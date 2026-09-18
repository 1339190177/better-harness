import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startHarnessStudioServer, type StartedHarnessStudioServer } from "../src/server/server.js";

const temporary: string[] = [];
let studio: StartedHarnessStudioServer | undefined;
let upstream: Server | undefined;

afterEach(async () => {
  await studio?.close();
  studio = undefined;
  if (upstream !== undefined) {
    await new Promise<void>((resolvePromise) => upstream!.close(() => resolvePromise()));
    upstream = undefined;
  }
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function startStudio(appsHostUrl?: string): Promise<StartedHarnessStudioServer> {
  const root = await mkdtemp(join(tmpdir(), "studio-apps-host-"));
  temporary.push(root);
  const appDir = join(root, "app");
  await mkdir(appDir, { recursive: true });
  await writeFile(join(appDir, "index.html"), "<!doctype html><title>fixture</title>", "utf8");
  studio = await startHarnessStudioServer({
    appDir,
    ...(appsHostUrl === undefined ? {} : { appsHostUrl }),
  });
  return studio;
}

interface UpstreamObservation {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
}

/**
 * A stand-in for the apps host: the exact routes the proxy is contracted to
 * carry, and a record of what actually arrived on the hop.
 */
async function startAppsHostUpstream(): Promise<{ url: string; received: UpstreamObservation[] }> {
  const received: UpstreamObservation[] = [];
  const server = createHttpServer((request, response) => {
    received.push({ method: request.method ?? "", url: request.url ?? "", headers: request.headers });
    if (request.url === "/apps/demo/ui/entry.mjs") {
      response.writeHead(200, {
        "Content-Type": "text/javascript; charset=utf-8",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      });
      response.end("export default function mount() {}\n");
      return;
    }
    if (request.url === "/api/apps?enabled=1") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify([{ name: "demo", enabled: true }]));
      return;
    }
    if (request.url === "/api/apps" && request.method === "GET") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify([{ name: "demo", enabled: false }]));
      return;
    }
    if (request.url === "/api/apps/demo/enable" && request.method === "POST") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true, name: "demo", enabled: true }));
      return;
    }
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "no fixture route" }));
  });
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  upstream = server;
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, received };
}

describe("apps host proxy", () => {
  it("passes the app surface through with status, body and headers intact", async () => {
    const appsHost = await startAppsHostUpstream();
    const server = await startStudio(appsHost.url);

    const entry = await fetch(`${server.url}/apps/demo/ui/entry.mjs`);
    expect(entry.status).toBe(200);
    expect(entry.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(await entry.text()).toContain("export default");

    const records = await fetch(`${server.url}/api/apps`);
    expect(records.status).toBe(200);
    expect(await records.json()).toEqual([{ name: "demo", enabled: false }]);

    // A query string survives the hop.
    const enabledOnly = await fetch(`${server.url}/api/apps?enabled=1`);
    expect(await enabledOnly.json()).toEqual([{ name: "demo", enabled: true }]);

    // A same-origin write reaches the lifecycle endpoint.
    const enable = await fetch(`${server.url}/api/apps/demo/enable`, {
      method: "POST",
      headers: { Origin: server.url },
    });
    expect(enable.status).toBe(200);
    expect(await enable.json()).toMatchObject({ ok: true, enabled: true });
    expect(appsHost.received.some((observation) => observation.url === "/api/apps/demo/enable" && observation.method === "POST")).toBe(true);
  });

  it("refuses cross-origin writes without forwarding them", async () => {
    const appsHost = await startAppsHostUpstream();
    const server = await startStudio(appsHost.url);
    const refused = await fetch(`${server.url}/api/apps/demo/enable`, {
      method: "POST",
      headers: { Origin: "https://untrusted.invalid" },
    });
    expect(refused.status).toBe(403);
    expect(appsHost.received.some((observation) => observation.url === "/api/apps/demo/enable")).toBe(false);
  });

  it("explains an unconfigured host and keeps other Studio routes working", async () => {
    const server = await startStudio();
    const records = await fetch(`${server.url}/api/apps`);
    expect(records.status).toBe(404);
    expect(await records.json()).toMatchObject({ code: "apps_host_not_configured" });

    const config = await fetch(`${server.url}/api/config`);
    expect(config.status).toBe(200);
    expect((await config.json() as { appsHostEnabled?: boolean }).appsHostEnabled).toBe(false);
  });

  it("reports an unreachable host as 502 with a stable code", async () => {
    const appsHost = await startAppsHostUpstream();
    const unreachable = appsHost.url;
    await new Promise<void>((resolvePromise) => upstream!.close(() => resolvePromise()));
    upstream = undefined;

    const server = await startStudio(unreachable);
    const records = await fetch(`${server.url}/api/apps`);
    expect(records.status).toBe(502);
    expect(await records.json()).toMatchObject({ code: "apps_host_unreachable" });
  });

  it("reports appsHostEnabled once a host is configured", async () => {
    const appsHost = await startAppsHostUpstream();
    const server = await startStudio(appsHost.url);
    const config = await fetch(`${server.url}/api/config`);
    expect((await config.json() as { appsHostEnabled?: boolean }).appsHostEnabled).toBe(true);
  });
});
