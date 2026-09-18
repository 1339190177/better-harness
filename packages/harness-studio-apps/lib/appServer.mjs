/**
 * Shared scaffolding for Node app backends under ``apps/<name>/server.mjs``.
 *
 * The hooks-tier contract is fixed and identical for every app — the Node
 * twin of what ``apps/proxy_auth.py`` plus aiohttp's router provided upstream —
 * so it lives here once instead of being copied into every backend:
 *
 *   - one buffered request body (the proxy HMAC covers those bytes, and a
 *     stream cannot be consumed twice),
 *   - the HMAC gate: /health is unsigned (the host's liveness probe), every
 *     other request must carry ``X-KiroCrew-Proxy`` (see proxyAuth.mjs),
 *   - a declarative route table matched on the RAW path exactly as aiohttp
 *     matched it (``..``/``.`` never resolve; a known path with the wrong
 *     method answers 405, not 404),
 *   - JSON body parsing and field validation carrying the Python handlers'
 *     exact error strings/codes, so the dashboard localizes identically,
 *   - atomic file writes (temp + fsync + rename) and data-dir resolution.
 *
 * A backend file then declares only its ROUTES table and its handlers:
 *
 *   import { createAppServer, sendJson, readJsonObject } from '../../lib/appServer.mjs'
 *   const ROUTES = [['GET', ['things'], handleList]]
 *   createAppServer({ appName: 'my-app', routes: ROUTES })
 *
 * Handlers receive ``(req, res, { params, query, raw })`` and may write
 * streaming responses themselves (an SSE handler must not end the response);
 * the dispatcher's error path only touches the response when nothing has been
 * sent yet.
 */
import { createServer } from 'node:http'
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { verifyProxyRequest } from './proxyAuth.mjs'

const PORT = Number(process.env.PORT || 9100)
const HOST = process.env.HOST || '127.0.0.1'

// ---------------------------------------------------------------------------
// Logging and data home
// ---------------------------------------------------------------------------

export function createLog(appName) {
  return (level, ...args) => console.log(`[${appName}] ${level}`, ...args)
}

/** Resolved per call, never captured at import — KIROCREW_HOME decides. */
export function crewHome() {
  return process.env.KIROCREW_HOME || join(homedir(), '.kiro', 'crew')
}

/** ``<crew-home>/apps/<name>/data`` — the official ``app_data_dir()``. */
export function appDataDir(appName) {
  return join(crewHome(), 'apps', appName, 'data')
}

// ---------------------------------------------------------------------------
// HTTP and validation helpers
// ---------------------------------------------------------------------------

export function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf-8')
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

/**
 * A 400 carrying both prose and a machine-readable code: the dashboard
 * localizes `code` and treats `error` as advisory (RFC 9457 3.1.3).
 */
export function badRequest(res, error, code) {
  return sendJson(res, 400, { error, code })
}

/**
 * Buffer the request body once, at the entrance. The proxy HMAC covers the
 * body bytes, so the signature gate and every handler have to read the same
 * buffer — a stream cannot be consumed twice.
 */
export async function readRawBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks)
}

/**
 * Parse a buffered body and require it to be a JSON object (``_json_object``).
 * Non-finite numbers are refused: JSON.parse turns ``1e999`` into Infinity,
 * which the browser's JSON.parse chokes on, so persisting it would hide the
 * whole record.
 */
export function readJsonObject(raw) {
  let body
  try {
    body = JSON.parse(raw.toString('utf-8'), (key, value) => {
      if (typeof value === 'number' && !Number.isFinite(value)) {
        throw new SyntaxError(`non-finite number not allowed: ${key}`)
      }
      return value
    })
  } catch {
    return { error: ['invalid JSON', 'invalid_json'] }
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { error: ['body must be a JSON object', 'body_not_object'] }
  }
  return { body }
}

/** Optional string field; a non-string is rejected outright (``_opt_str``). */
export function optStr(body, key) {
  if (!(key in body) || body[key] === null) return { value: null }
  if (typeof body[key] !== 'string') {
    return { error: [`${key} must be a string`, 'invalid_field_type'] }
  }
  return { value: body[key] }
}

/** Required, non-empty string field; the value comes back stripped. */
export function reqStr(body, key) {
  const { value, error } = optStr(body, key)
  if (error) return { error }
  if (!(value || '').trim()) {
    return { error: [`${key} is required`, 'missing_required_field'] }
  }
  return { value: value.trim() }
}

/** Optional list-of-strings field, element types checked (``_opt_str_list``). */
export function optStrList(body, key) {
  if (!(key in body) || body[key] === null) return { value: null }
  const value = body[key]
  if (!Array.isArray(value)) {
    return { error: [`${key} must be an array`, 'invalid_field_type'] }
  }
  if (!value.every((entry) => typeof entry === 'string')) {
    return { error: [`${key} must contain only strings`, 'invalid_field_type'] }
  }
  return { value }
}

/** Optional integer field with optional bounds; bool fails like Python's int(). */
export function optInt(body, key, { min, max } = {}) {
  if (!(key in body) || body[key] === null) return { value: null }
  const value = body[key]
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return { error: [`${key} must be an integer`, 'invalid_field_type'] }
  }
  if (min !== undefined && value < min) {
    return { error: [`${key} must be at least ${min}`, 'invalid_field_value'] }
  }
  if (max !== undefined && value > max) {
    return { error: [`${key} must be at most ${max}`, 'invalid_field_value'] }
  }
  return { value }
}

/** Optional boolean field; a non-boolean is rejected outright. */
export function optBool(body, key) {
  if (!(key in body) || body[key] === null) return { value: null }
  if (typeof body[key] !== 'boolean') {
    return { error: [`${key} must be a boolean`, 'invalid_field_type'] }
  }
  return { value: body[key] }
}

export const isString = (value) => typeof value === 'string'
// Python excluded bool from the numeric field explicitly (bool is an int
// there); in JS the types are already distinct, so `true` fails this test.
export const isNumber = (value) => typeof value === 'number' && Number.isFinite(value)
export const isBoolean = (value) => typeof value === 'boolean'

/** int() semantics for a query parameter: digits only, or null. */
export function pyInt(raw) {
  const text = String(raw).trim()
  if (!/^[+-]?\d+$/.test(text)) return null
  return Number(text)
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/**
 * Atomic temp-file + rename with fsync (``atomic_write(..., fsync=True)``):
 * a plain write truncates the existing file before the new bytes land, so an
 * interruption mid-save leaves the previous content gone.
 */
export function atomicWrite(path, text) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(16).slice(2, 10)}`
  const fd = openSync(tmp, 'w')
  try {
    writeSync(fd, text)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    renameSync(tmp, path)
  } catch (err) {
    try {
      unlinkSync(tmp)
    } catch {
      /* best effort */
    }
    throw err
  }
}

/** Read a JSON file, returning *fallback* on any parse/IO error. */
export function readJsonFile(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return fallback
  }
}

// ---------------------------------------------------------------------------
// Router and HTTP entry
// ---------------------------------------------------------------------------

function decodeSegment(segment) {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

/**
 * Match the request against a ROUTES table. Returns the handler plus decoded
 * params, or a refusal: a path traversal segment and an unknown path answer
 * 404 (aiohttp matched on the path as sent, so those never resolve to a
 * route), and a known path with another method answers 405.
 *
 * TWO request shapes reach a Node backend, mirroring the two namespaces the
 * official gateway splits:
 *
 *   /api/apps/<name>/<rest...>  hooks-tier apps — the in-gateway namespace,
 *                               forwarded with the target unchanged.
 *   /api/<rest...>              process-tier apps — the gateway's
 *                               ``/apps/<name>/api/*`` proxy preserves the
 *                               ``/api/`` prefix, so the backend sees exactly
 *                               the paths the frontend calls (md-notebook).
 *
 * A trailing ``:name*`` pattern slot is a catch-all that absorbs ONE OR MORE
 * remaining segments (the Node twin of aiohttp's ``{name:.*}``) — the ``*``
 * suffix marks it and the captured rest arrives rejoined with ``/``, empty
 * segments conserved, exactly as aiohttp's match_info would have delivered it.
 * A catch-all refuses a zero-segment rest: ``/preview/<id>`` matches no
 * registered Python route, only ``/preview/<id>/<subpath>`` does.
 */
export function resolveRoute(routes, appName, method, rawPath) {
  const [, api, second, ...tail] = rawPath.split('/')
  if (api !== 'api') return null
  let rest
  if (second === 'apps') {
    // Hooks tier: /api/apps/<name>/<rest...>
    if (tail[0] !== appName) return null
    rest = tail.slice(1)
  } else {
    // Process tier: /api/<rest...> — `/api` itself carries no route.
    rest = second === undefined ? [] : [second, ...tail]
  }
  if (rest.some((segment) => segment === '..' || segment === '.')) return null
  const segments = rest.map(decodeSegment)
  if (segments.some((segment) => segment === '..' || segment === '.')) return null

  let pathMatched = false
  for (const [routeMethod, pattern, handler] of routes) {
    const lastIndex = pattern.length - 1
    const catchAll = lastIndex >= 0 && pattern[lastIndex].startsWith(':') && pattern[lastIndex].endsWith('*')
    const fixed = catchAll ? lastIndex : pattern.length
    if (catchAll ? segments.length <= fixed : segments.length !== fixed) continue
    const params = {}
    let matched = true
    for (let i = 0; i < fixed; i += 1) {
      if (pattern[i].startsWith(':')) {
        params[pattern[i].slice(1)] = segments[i]
        continue
      }
      if (segments[i] !== pattern[i]) {
        matched = false
        break
      }
    }
    if (!matched) continue
    if (catchAll) params[pattern[lastIndex].slice(1, -1)] = segments.slice(fixed).join('/')
    pathMatched = true
    if (routeMethod === method) return { handler, params }
  }
  return pathMatched ? { methodNotAllowed: true } : null
}

/**
 * Verify the proxy HMAC on a buffered request. /health stays unauthenticated
 * (the host's liveness probe hits it unsigned); the signature covers the body
 * bytes, so verification MUST run against the buffered body.
 */
export function authorized(appName, req, raw) {
  const route = (req.url || '').split('?')[0].replace(/\/+$/, '')
  if (route === '' || route === '/health') return true
  return verifyProxyRequest(req.headers['x-kirocrew-proxy'] || '', {
    method: req.method,
    target: req.url,
    body: raw,
  })
}

/**
 * Start the HTTP server for one app backend: health probe, HMAC gate, route
 * dispatch, 500 guard, graceful shutdown. *onShutdown* (optional) runs before
 * the listener closes — the hook a store uses to flush.
 */
export function createAppServer({ appName, routes, onShutdown }) {
  const log = createLog(appName)
  const server = createServer(async (req, res) => {
    const rawPath = (req.url || '').split('?')[0]
    const query = new URLSearchParams((req.url || '').split('?')[1] || '')

    if (
      (req.method === 'GET' || req.method === 'HEAD') &&
      rawPath.replace(/\/+$/, '') === '/health'
    ) {
      return sendJson(res, 200, { status: 'ok' })
    }
    // Buffer once: the HMAC covers these bytes and each handler parses the
    // same buffer — the request stream cannot be read twice.
    const raw = await readRawBody(req)
    if (!authorized(appName, req, raw)) {
      return sendJson(res, 401, { error: 'unauthorized' })
    }

    const route = resolveRoute(routes, appName, req.method, rawPath)
    if (!route) return sendJson(res, 404, { error: `not found: ${rawPath}` })
    if (route.methodNotAllowed) return sendJson(res, 405, { error: 'method not allowed' })

    try {
      await route.handler(req, res, { params: route.params, query, raw })
    } catch (err) {
      const id = Math.random().toString(16).slice(2, 14)
      log('ERROR', `${req.method} ${req.url} failed [${id}]`, err)
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error', id })
      else res.end()
    }
  })

  server.listen(PORT, HOST, () => {
    log('INFO', `listening on http://${HOST}:${PORT}`)
  })

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      log('INFO', 'shutting down')
      try {
        onShutdown?.()
      } catch (err) {
        log('ERROR', 'shutdown hook failed', err)
      }
      server.close(() => process.exit(0))
      setTimeout(() => process.exit(0), 1000).unref()
    })
  }

  return server
}
