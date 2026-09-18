import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { respondJson, sameOriginRequest } from "./http-utils.js";
import type { HarnessStudioServerOptions } from "./studio-types.js";

/**
 * The app surfaces Studio reverses to a running `harness-studio-apps` host:
 * `/apps/<name>/ui/*` (app UI bundles), `/apps/<name>/api/*` (the app's own
 * backend, HMAC-signed by the apps host itself) and `/api/apps*` (the app
 * catalog and its enable/disable lifecycle). Nothing else crosses the seam —
 * the apps host's SPA shell and shaped stubs stay its own business.
 */
export function isStudioAppHostPath(pathname: string): boolean {
  return pathname === "/apps"
    || pathname.startsWith("/apps/")
    || pathname === "/api/apps"
    || pathname.startsWith("/api/apps/");
}

/**
 * One wait for the upstream response headers. An app backend may legitimately
 * take minutes (a render job), so this bounds a silent hang rather than a slow
 * answer; a dead host refuses the connection long before it.
 */
export const APPS_HOST_TIMEOUT_MS = 180_000;

/** Headers that describe one connection and must not be forwarded to the next. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/**
 * Reverse-proxy the app surfaces to the configured apps host. Returns true
 * when the request was this surface's to answer — including the explained
 * refusals — and false when the path belongs to another Studio route.
 *
 * The apps host stays the security authority: it signs the app-backend hop,
 * gates disabled apps, and sets the UI bundles' CSP. Studio contributes the
 * same-origin gate it applies to its own writes, because a cross-site page
 * must not be able to toggle an app's enablement through this origin.
 */
export function routeAppsHost(
  request: IncomingMessage,
  response: ServerResponse,
  options: HarnessStudioServerOptions,
): boolean {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (!isStudioAppHostPath(url.pathname)) return false;
  const appsHostUrl = options.appsHostUrl;
  if (appsHostUrl === undefined) {
    respondJson(response, 404, {
      error: "No apps host is configured. Start one with `npm run harness-studio-apps:start` and pass --apps-host <url>.",
      code: "apps_host_not_configured",
    });
    return true;
  }
  const method = request.method ?? "GET";
  if (method !== "GET" && method !== "HEAD" && !sameOriginRequest(request)) {
    respondJson(response, 403, { error: "Cross-origin app host requests are not allowed." });
    return true;
  }
  let target: URL;
  try {
    const base = new URL(appsHostUrl);
    if (base.protocol !== "http:" && base.protocol !== "https:") throw new Error("unsupported protocol");
    target = new URL(base.origin);
    target.pathname = url.pathname;
    target.search = url.search;
  } catch {
    respondJson(response, 502, {
      error: `The configured apps host URL is not usable: ${appsHostUrl}`,
      code: "apps_host_unreachable",
    });
    return true;
  }
  const outboundHeaders: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined || HOP_BY_HOP.has(key.toLowerCase())) continue;
    outboundHeaders[key] = value;
  }
  outboundHeaders.host = target.host;
  const transport = target.protocol === "https:" ? httpsRequest : httpRequest;
  const proxied = transport(target, { method, headers: outboundHeaders, timeout: APPS_HOST_TIMEOUT_MS }, (upstreamResponse) => {
    const responseHeaders: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries(upstreamResponse.headers)) {
      if (value === undefined || HOP_BY_HOP.has(key.toLowerCase())) continue;
      responseHeaders[key] = value;
    }
    response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
    upstreamResponse.on("error", () => response.destroy());
    upstreamResponse.pipe(response);
  });
  proxied.on("timeout", () => proxied.destroy(new Error("apps host timed out")));
  proxied.on("error", () => {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    respondJson(response, 502, {
      error: `The apps host at ${appsHostUrl} is not reachable. Start it with \`npm run harness-studio-apps:start\`.`,
      code: "apps_host_unreachable",
    });
  });
  response.on("close", () => {
    // A client that navigates away mid-request must not leave the upstream
    // hop open; a completed response ends before close.
    if (!response.writableEnded) proxied.destroy();
  });
  request.pipe(proxied);
  return true;
}
