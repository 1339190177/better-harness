/** Shared HTTP helpers: response writing, body reading, MIME mapping. */
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname } from 'node:path'

export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.br': 'application/octet-stream',
  '.gz': 'application/gzip',
}

export function mimeFor(filePath) {
  return MIME[extname(filePath).toLowerCase()] || 'application/octet-stream'
}

/**
 * Write a JSON response.
 *
 * ``close`` ends the connection after the response. It is what a refusal
 * mid-upload needs: the client is still sending a body nobody will read, and
 * only closing the connection stops it.
 */
export function sendJson(res, status, payload, { close = false } = {}) {
  const body = Buffer.from(JSON.stringify(payload), 'utf-8')
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  }
  if (close) headers.Connection = 'close'
  res.writeHead(status, headers)
  res.end(body)
  if (close) res.on('finish', () => res.socket?.destroy())
}

/** Raised by ``readBody`` when a request body passes the caller's ceiling. */
export class BodyTooLargeError extends Error {
  constructor(limit) {
    super(`request body exceeds ${limit} bytes`)
    this.name = 'BodyTooLargeError'
    this.limit = limit
  }
}

/**
 * Buffer a request body, with a ceiling.
 *
 * The buffering is not a choice: the proxy HMAC covers the body bytes, so they
 * must all be in hand before the request can be signed and forwarded. That is
 * exactly why the ceiling is mandatory — without one, a single upload is one
 * out-of-memory. ``backend.maxBodyBytes`` in the app manifest is where the
 * number comes from; a body past it is refused with 413 before the app's
 * process is touched.
 */
export function readBody(req, { limit = Number.POSITIVE_INFINITY } = {}) {
  if (req.method === 'GET' || req.method === 'HEAD') return Promise.resolve(Buffer.alloc(0))
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    const cleanup = () => {
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('error', onError)
    }
    function onData(chunk) {
      size += chunk.length
      if (size > limit) {
        cleanup()
        // Pause rather than destroy: destroying the request kills the socket
        // before the caller's 413 can be written, and the client sees a dropped
        // connection instead of the reason. The caller answers with
        // `close: true`, which ends the connection once the refusal is out.
        req.pause()
        reject(new BodyTooLargeError(limit))
        return
      }
      chunks.push(chunk)
    }
    function onEnd() {
      cleanup()
      resolve(Buffer.concat(chunks))
    }
    function onError(err) {
      cleanup()
      reject(err)
    }
    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
  })
}

/**
 * Serve a file by path with basic conditional support.
 * Returns false when the file does not exist or is not a regular file.
 */
export async function sendFile(res, filePath, { cache = 'no-store', headers = {} } = {}) {
  let info
  try {
    info = await stat(filePath)
  } catch {
    return false
  }
  if (!info.isFile()) return false
  res.writeHead(200, {
    'Content-Type': mimeFor(filePath),
    'Content-Length': info.size,
    'Cache-Control': cache,
    ...headers,
  })
  createReadStream(filePath).pipe(res)
  return true
}
