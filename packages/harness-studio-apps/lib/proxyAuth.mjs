/**
 * Shared HMAC verification for the gateway → app-backend reverse proxy —
 * the Node twin of ``kiro_crew/apps/proxy_auth.py``.
 *
 * The host signs every forwarded request with the per-app secret:
 *
 *   X-KiroCrew-Proxy: <ts>:<hmac_sha256(secret, "<ts>:<METHOD>:<target>:<sha256(body)>")>
 *
 * where ``<target>`` is the request-target the backend receives (e.g.
 * ``/api/read?path=x`` — the raw percent-encoded path+query exactly as it went
 * on the wire). Fails closed: missing secret, malformed header, stale
 * timestamp (±60s) or signature mismatch all return false.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

const MAX_SKEW_SECONDS = 60

export function proxySecret() {
  return process.env.KIROCREW_PROXY_SECRET || ''
}

export function signProxyRequest({ method, target, body, secret, now }) {
  const ts = String(Math.trunc(now ?? Date.now() / 1000))
  const bodyHash = createHash('sha256')
    .update(body ?? Buffer.alloc(0))
    .digest('hex')
  const msg = `${ts}:${method}:${target}:${bodyHash}`
  const sig = createHmac('sha256', secret).update(msg).digest('hex')
  return `${ts}:${sig}`
}

export function verifyProxyRequest(headerValue, { method, target, body, secret, now } = {}) {
  const key = secret ?? proxySecret()
  if (!key || !headerValue || !headerValue.includes(':')) return false
  const idx = headerValue.indexOf(':')
  const tsStr = headerValue.slice(0, idx)
  const sig = headerValue.slice(idx + 1)
  if (!/^\d+$/.test(tsStr) || !sig) return false
  const clock = now ?? Math.trunc(Date.now() / 1000)
  if (Math.abs(clock - Number(tsStr)) > MAX_SKEW_SECONDS) return false
  const expected = signProxyRequest({ method, target, body, secret: key, now: Number(tsStr) })
  const a = Buffer.from(expected)
  const b = Buffer.from(headerValue)
  return a.length === b.length && timingSafeEqual(a, b)
}
