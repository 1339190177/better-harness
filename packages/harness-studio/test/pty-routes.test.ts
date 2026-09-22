import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ptyRoute } from "../src/server/pty-routes.js";
import type { HarnessStudioServerOptions, PtyProvider } from "../src/server/studio-types.js";

/** A fake pty provider driven by an EventEmitter, recording the calls it gets. */
function fakeProvider(): PtyProvider & {
  emitter: EventEmitter;
  writes: Array<{ ptyId: number; data: Buffer }>;
  spawns: unknown[];
} {
  const emitter = new EventEmitter();
  const writes: Array<{ ptyId: number; data: Buffer }> = [];
  const spawns: unknown[] = [];
  return {
    emitter,
    writes,
    spawns,
    async spawn(params) { spawns.push(params); return 7; },
    async write(ptyId, data) {
      const buffer = typeof data === "string" ? Buffer.from(data) : data;
      writes.push({ ptyId, data: buffer });
      return buffer.length;
    },
    async resize() {},
    async signal() {},
    async closePty() {},
    onData(handler) {
      emitter.on("data", handler);
      return () => emitter.off("data", handler);
    },
    onExit(handler) {
      emitter.on("exit", handler);
      return () => emitter.off("exit", handler);
    },
  };
}

let server: Server | undefined;
afterEach(() => { server?.close(); server = undefined; });

/** Start a server that routes only through ptyRoute; a miss is a 404. */
async function serve(options: HarnessStudioServerOptions): Promise<string> {
  server = createServer(async (request, response) => {
    if (await ptyRoute(request, response, options)) return;
    response.writeHead(404); response.end();
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const { port } = server!.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

describe("pty routes", () => {
  it("ignores every path when no provider is configured", async () => {
    const base = await serve({ appDir: "." });
    const response = await fetch(`${base}/api/pty/spawn`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(response.status).toBe(404);
  });

  it("spawns with parsed params and returns the ptyId", async () => {
    const provider = fakeProvider();
    const base = await serve({ appDir: ".", ptyProvider: provider });
    const response = await fetch(`${base}/api/pty/spawn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "/bin/sh", args: ["-c", "echo hi"], rows: 24, cols: 80 }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ptyId: 7 });
    expect(provider.spawns[0]).toMatchObject({ command: "/bin/sh", args: ["-c", "echo hi"], rows: 24, cols: 80 });
  });

  it("decodes base64 input on write", async () => {
    const provider = fakeProvider();
    const base = await serve({ appDir: ".", ptyProvider: provider });
    const response = await fetch(`${base}/api/pty/write`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ptyId: 7, dataBase64: Buffer.from("ls -l\n").toString("base64") }),
    });
    expect(await response.json()).toEqual({ written: 6 });
    expect(provider.writes.at(-1)).toMatchObject({ ptyId: 7 });
    expect(provider.writes.at(-1)!.data.toString("utf8")).toBe("ls -l\n");
  });

  it("streams pty.data as an SSE frame", async () => {
    const provider = fakeProvider();
    const base = await serve({ appDir: ".", ptyProvider: provider });
    const controller = new AbortController();
    const response = await fetch(`${base}/api/pty/stream`, { signal: controller.signal });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = response.body!.getReader();
    // Give the route a tick to register its listeners, then emit.
    await new Promise((resolve) => setTimeout(resolve, 20));
    provider.emitter.emit("data", { ptyId: 7, data: Buffer.from("out\n") });
    const { value } = await reader.read();
    const frame = new TextDecoder().decode(value);
    expect(frame.startsWith("data: ")).toBe(true);
    const event = JSON.parse(frame.slice("data: ".length).trim());
    expect(event).toEqual({ type: "pty.data", ptyId: 7, dataBase64: Buffer.from("out\n").toString("base64") });
    controller.abort();
    await reader.cancel().catch(() => {});
  });

  it("refuses cross-origin callers", async () => {
    const provider = fakeProvider();
    const base = await serve({ appDir: ".", ptyProvider: provider });
    const response = await fetch(`${base}/api/pty/spawn`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://evil.example" },
      body: JSON.stringify({ command: "/bin/sh" }),
    });
    expect(response.status).toBe(403);
    expect(provider.spawns).toHaveLength(0);
  });
});
