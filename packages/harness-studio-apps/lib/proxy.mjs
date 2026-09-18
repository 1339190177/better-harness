/**
 * Reverse proxy into an app's backend process.
 *
 *   /apps/<name>/api/<path>   → the app's own backend, target rewritten to
 *                               ``/api/<path>``.
 *   /api/apps/<name>/<path>   → the same backend with the target UNCHANGED
 *                               (the in-gateway namespace an app may answer
 *                               under; see ``lib/appServer.mjs::resolveRoute``).
 *
 * Contract:
 *   - the forwarded request carries ``X-KiroCrew-Proxy: <ts>:<hmac>`` signed
 *     with the app's secret over the raw wire target + body hash,
 *   - a disabled app answers 403 before any process is reachable,
 *   - an app that does not declare ``capabilities.http.inbound`` answers 403,
 *   - a body past ``backend.maxBodyBytes`` answers 413 without the app's
 *     process being touched,
 *   - request headers are DEFAULT-DENIED: only structurally necessary ones and
 *     the app's declared ``capabilities.forwardHeaders`` cross the hop,
 *   - hop-by-hop headers are stripped on the way back,
 *   - ``..`` in the path is refused.
 *
 * The header policy is the reason the HMAC exists at all. An app backend is a
 * separate process running third-party code; it already has its own identity on
 * this hop. Copying the browser's ``Cookie`` or ``Authorization`` into it would
 * hand every app the host's session credential — the exact bypass the signature
 * is there to prevent (CWE-306, "network-only authentication"). So the manifest
 * cannot ask for those: ``FORBIDDEN_FORWARD_HEADERS`` is rejected at validation
 * time, and anything not declared is dropped here.
 */
import { request as httpRequest } from 'node:http'
import { BodyTooLargeError, readBody, sendJson } from './httpUtil.mjs'
import { signProxyRequest } from './proxyAuth.mjs'

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

/**
 * Headers every backend needs to read its own request at all. They describe the
 * message, not the caller, so they carry no identity across the hop.
 * ``content-length`` is not here because the proxy recomputes it.
 */
const ALWAYS_FORWARDED = new Set(['content-type', 'accept', 'accept-language'])

/** How long the host waits for the backend's response headers. */
const UPSTREAM_TIMEOUT_MS = 120_000

/** Fallback ceiling for an app whose manifest declares no backend block. */
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024

export function createAppProxy({ backends, isAppEnabled, secretFor, appFor, host = '127.0.0.1', logger }) {
  /** The manifest-declared limits for *name*, with the defaults filled in. */
  function policyFor(name) {
    const manifest = appFor?.(name)?.manifest
    const allowed = new Set(ALWAYS_FORWARDED)
    for (const header of manifest?.capabilities?.forwardHeaders ?? []) allowed.add(header)
    return {
      inbound: manifest?.capabilities?.http?.inbound !== false,
      maxBodyBytes: manifest?.backend?.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
      allowed,
    }
  }

  /** Sign and forward one request to the app's backend at *rawTarget*. */
  async function forward(req, res, name, rawTarget) {
    const policy = policyFor(name)
    if (!policy.inbound) {
      return sendJson(res, 403, {
        code: 'inbound_not_declared',
        error: `app '${name}' does not declare capabilities.http.inbound`,
      })
    }

    const status = backends.status(name)
    if (!status || !status.running) {
      return sendJson(res, 502, { error: `app '${name}' has no reachable backend` })
    }

    let body
    try {
      body = await readBody(req, { limit: policy.maxBodyBytes })
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        return sendJson(
          res,
          413,
          {
            code: 'body_too_large',
            error: `request body exceeds the app's backend.maxBodyBytes (${policy.maxBodyBytes})`,
          },
          // The client is still uploading a body nobody will read; only closing
          // the connection stops it.
          { close: true },
        )
      }
      throw err
    }

    const secret = secretFor(name)
    const proxyHeader = signProxyRequest({ method: req.method, target: rawTarget, body, secret })

    // Default-deny: a header crosses only if it describes the message or the
    // manifest named it. `host` is replaced, hop-by-hop headers never travel.
    const headers = {}
    for (const [key, value] of Object.entries(req.headers)) {
      const lower = key.toLowerCase()
      if (lower === 'host' || HOP_BY_HOP.has(lower)) continue
      if (!policy.allowed.has(lower)) continue
      headers[key] = value
    }
    headers['X-KiroCrew-Proxy'] = proxyHeader
    headers['content-length'] = String(body.length)

    const upstream = httpRequest(
      {
        host,
        port: status.port,
        method: req.method,
        path: rawTarget,
        headers,
        timeout: UPSTREAM_TIMEOUT_MS,
      },
      (up) => {
        const responseHeaders = {}
        for (const [key, value] of Object.entries(up.headers)) {
          if (HOP_BY_HOP.has(key.toLowerCase())) continue
          responseHeaders[key] = value
        }
        res.writeHead(up.statusCode || 502, responseHeaders)
        up.on('error', () => res.destroy())
        up.pipe(res)
      },
    )
    // A backend that accepts the connection and then goes quiet would otherwise
    // hold this request open forever.
    upstream.on('timeout', () => upstream.destroy(new Error(`backend did not answer in ${UPSTREAM_TIMEOUT_MS}ms`)))
    upstream.on('error', (err) => {
      logger.warn(`proxy ${name} ${rawTarget} failed: ${err.message}`)
      if (!res.headersSent) sendJson(res, 502, { error: `app '${name}' backend unreachable` })
      else res.end()
    })
    res.on('close', () => {
      // A client that navigates away mid-request must not leave the hop open.
      if (!res.writableEnded) upstream.destroy()
    })
    if (body.length) upstream.write(body)
    upstream.end()
  }

  async function handle(req, res, url, name, rest) {
    if (rest.includes('..')) {
      return sendJson(res, 400, { error: 'invalid path' })
    }
    // Enablement gate first: an app the user never turned on never gets a
    // signed proxy into its backend.
    if (!isAppEnabled(name)) {
      return sendJson(res, 403, { code: 'app_not_enabled', error: `app '${name}' is not enabled` })
    }
    await forward(req, res, name, `/api/${rest}${url.search || ''}`)
  }

  /**
   * ``/api/apps/<name>/<path>`` → the app's backend with the request-target
   * unchanged, so percent-encoding survives byte-for-byte and the HMAC covers
   * exactly what the backend verifies against its own ``req.url``.
   */
  async function handleHooks(req, res, name) {
    if (!isAppEnabled(name)) {
      return sendJson(res, 403, { code: 'app_disabled', error: `${name} is disabled` })
    }
    await forward(req, res, name, req.url || `/api/apps/${name}`)
  }

  return { handle, handleHooks }
}
