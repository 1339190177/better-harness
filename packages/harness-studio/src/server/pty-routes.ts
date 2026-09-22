import type { IncomingMessage, ServerResponse } from "node:http";
import type { HarnessStudioServerOptions } from "./studio-types.js";
import { encodeSseData, readJsonBody, respondJson, sameOriginRequest } from "./http-utils.js";

/**
 * PTY terminal routes.
 *
 * The pty host is duplex: output arrives on the child's schedule, so this
 * splits into a long-lived SSE stream (`GET /api/pty/stream`) that forwards
 * every `pty.data`/`pty.exit` event, and short POST calls for the control
 * verbs. It mirrors the run-stream split (SSE down, POST up) rather than
 * inventing a WebSocket the rest of Studio does not use.
 *
 * Returns `true` when it owned the request. A server without a `ptyProvider`
 * answers nothing here, so the browser is never shown a control it cannot honour.
 */
export async function ptyRoute(
  request: IncomingMessage,
  response: ServerResponse,
  options: HarnessStudioServerOptions,
): Promise<boolean> {
  const provider = options.ptyProvider;
  if (provider === undefined) return false;
  const url = new URL(request.url ?? "/", "http://localhost");
  if (!url.pathname.startsWith("/api/pty/")) return false;

  // Every pty verb mutates a real child, so cross-origin callers are refused
  // the same way live runs are.
  if (!sameOriginRequest(request)) {
    respondJson(response, 403, { error: "Cross-origin terminal access is not allowed." });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/pty/stream") {
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-store",
      Connection: "keep-alive",
      "X-Content-Type-Options": "nosniff",
    });
    // Flush headers now so the client's stream opens before the first event; a
    // terminal may sit idle for a while before it prints anything.
    response.flushHeaders();
    const offData = provider.onData(({ ptyId, data }) => {
      response.write(encodeSseData({ type: "pty.data", ptyId, dataBase64: data.toString("base64") }));
    });
    const offExit = provider.onExit(({ ptyId, code, signal }) => {
      response.write(encodeSseData({ type: "pty.exit", ptyId, code, signal }));
    });
    response.once("close", () => { offData(); offExit(); });
    return true;
  }

  if (request.method !== "POST") return false;

  let body: Record<string, unknown>;
  try {
    body = (await readJsonBody(request)) as Record<string, unknown>;
  } catch (error) {
    respondJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
    return true;
  }

  try {
    switch (url.pathname) {
      case "/api/pty/spawn": {
        // A terminal with no explicit command opens the reader's login shell,
        // resolved on the server (the browser cannot read the environment).
        const requested = typeof body.command === "string" && body.command.length > 0 ? body.command : undefined;
        const command = requested ?? process.env.SHELL ?? "/bin/sh";
        const ptyId = await provider.spawn({
          command,
          ...(Array.isArray(body.args) ? { args: body.args.map(String) } : {}),
          ...(typeof body.cwd === "string" ? { cwd: body.cwd } : {}),
          ...(typeof body.rows === "number" ? { rows: body.rows } : {}),
          ...(typeof body.cols === "number" ? { cols: body.cols } : {}),
          ...(typeof body.term === "string" ? { term: body.term } : {}),
        });
        respondJson(response, 200, { ptyId });
        return true;
      }
      case "/api/pty/write": {
        const ptyId = asPtyId(body.ptyId);
        const dataBase64 = typeof body.dataBase64 === "string" ? body.dataBase64 : undefined;
        if (ptyId === undefined || dataBase64 === undefined) {
          respondJson(response, 400, { error: "pty.write needs ptyId and dataBase64." });
          return true;
        }
        const written = await provider.write(ptyId, Buffer.from(dataBase64, "base64"));
        respondJson(response, 200, { written });
        return true;
      }
      case "/api/pty/resize": {
        const ptyId = asPtyId(body.ptyId);
        if (ptyId === undefined || typeof body.rows !== "number" || typeof body.cols !== "number") {
          respondJson(response, 400, { error: "pty.resize needs ptyId, rows and cols." });
          return true;
        }
        await provider.resize(ptyId, body.rows, body.cols);
        respondJson(response, 200, { ok: true });
        return true;
      }
      case "/api/pty/signal": {
        const ptyId = asPtyId(body.ptyId);
        if (ptyId === undefined || typeof body.signal !== "number") {
          respondJson(response, 400, { error: "pty.signal needs ptyId and signal." });
          return true;
        }
        await provider.signal(ptyId, body.signal);
        respondJson(response, 200, { ok: true });
        return true;
      }
      case "/api/pty/close": {
        const ptyId = asPtyId(body.ptyId);
        if (ptyId === undefined) {
          respondJson(response, 400, { error: "pty.close needs ptyId." });
          return true;
        }
        await provider.closePty(ptyId);
        respondJson(response, 200, { ok: true });
        return true;
      }
      default:
        return false;
    }
  } catch (error) {
    respondJson(response, 502, { error: error instanceof Error ? error.message : String(error) });
    return true;
  }
}

function asPtyId(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}
