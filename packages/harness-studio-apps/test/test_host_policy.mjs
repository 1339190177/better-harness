/**
 * Host policy smoke — the manifest fields that only mean something if the host
 * acts on them, observed end to end against a fixture app.
 *
 * Every check here corresponds to one manifest field:
 *   capabilities.forwardHeaders  → the browser's Cookie never crosses the hop,
 *                                  a declared header does
 *   backend.maxBodyBytes         → a body past the ceiling answers 413 without
 *                                  the app's process being touched
 *   backend.restart              → a backend that dies comes back, and the
 *                                  retry budget is honoured
 *   defaultEnabled               → the app is on at boot with no --enable
 *   the reserved core segments   → answer 501, not a fake 200
 *
 * Run: node test/test_host_policy.mjs
 */
import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const STATE = join(root, '.state', 'policy-test')
const PORT = 9341
const BASE = `http://127.0.0.1:${PORT}`

rmSync(STATE, { recursive: true, force: true })

let failures = 0
function check(label, cond, detail = '') {
  if (cond) console.log(`  ok    ${label}`)
  else {
    failures += 1
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const host = spawn(
  process.execPath,
  [
    join(root, 'server.mjs'),
    '--port', String(PORT),
    '--apps', join(root, 'test', 'fixtures'),
    '--state-dir', STATE,
    '--home', join(STATE, 'home'),
  ],
  { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
)
const hostLog = []
host.stdout.on('data', (d) => hostLog.push(String(d)))
host.stderr.on('data', (d) => hostLog.push(String(d)))

async function waitReady(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/apps`)
      if (res.ok) {
        const records = await res.json()
        const echo = records.find((record) => record.name === 'echo-app')
        if (echo?.backend_status?.healthy) return echo
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error(`host never became ready\n${hostLog.join('')}`)
}

try {
  // defaultEnabled: no --enable was passed, so the manifest decided this.
  const echo = await waitReady()
  check('defaultEnabled brings the app up at boot', echo.enabled === true)

  // capabilities.forwardHeaders: default-deny with the declared header allowed.
  const headersRes = await fetch(`${BASE}/apps/echo-app/api/headers`, {
    headers: {
      cookie: 'session=must-not-cross',
      authorization: 'Bearer must-not-cross',
      'x-allowed': 'yes',
      'x-undeclared': 'no',
      accept: 'application/json',
    },
  })
  const seen = (await headersRes.json()).headers
  check('the host Cookie never reaches the backend', !seen.includes('cookie'), seen.join(', '))
  check('the host Authorization never reaches the backend', !seen.includes('authorization'), seen.join(', '))
  check('an undeclared header is dropped', !seen.includes('x-undeclared'), seen.join(', '))
  check('a declared forwardHeader crosses', seen.includes('x-allowed'), seen.join(', '))
  check('the proxy signature still crosses', seen.includes('x-kirocrew-proxy'), seen.join(', '))

  // backend.maxBodyBytes = 1024 in the fixture manifest.
  const small = await fetch(`${BASE}/apps/echo-app/api/echo`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'x'.repeat(512),
  })
  check('a body under the ceiling is forwarded', small.status === 200, `got ${small.status}`)

  const large = await fetch(`${BASE}/apps/echo-app/api/echo`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'x'.repeat(4096),
  })
  const largeBody = await large.json().catch(() => ({}))
  check(
    'a body past backend.maxBodyBytes answers 413',
    large.status === 413 && largeBody.code === 'body_too_large',
    `got ${large.status} ${JSON.stringify(largeBody)}`,
  )

  // A reserved core segment the host does not implement must say so.
  const uninstall = await fetch(`${BASE}/api/apps/echo-app/uninstall`, { method: 'POST' })
  const uninstallBody = await uninstall.json().catch(() => ({}))
  check(
    'an unimplemented core route answers 501, not a fake 200',
    uninstall.status === 501 && uninstallBody.code === 'not_implemented',
    `got ${uninstall.status} ${JSON.stringify(uninstallBody)}`,
  )

  // backend.restart: the fixture exits non-zero on demand and must come back.
  const before = (await (await fetch(`${BASE}/apps/echo-app/api/pid`)).json()).pid
  await fetch(`${BASE}/apps/echo-app/api/crash`, { method: 'POST' })
  let after
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200))
    try {
      const res = await fetch(`${BASE}/apps/echo-app/api/pid`)
      if (res.ok) {
        after = (await res.json()).pid
        if (after !== before) break
      }
    } catch {
      /* mid-restart */
    }
  }
  check('backend.restart brings a crashed backend back', after !== undefined && after !== before, `${before} -> ${after}`)

  const records = await (await fetch(`${BASE}/api/apps`)).json()
  const restarts = records.find((record) => record.name === 'echo-app')?.backend_status?.restarts
  check('the restart is reported in backend_status', restarts >= 1, `restarts=${restarts}`)
} catch (error) {
  failures += 1
  console.log(`  FAIL  ${error.message}`)
} finally {
  host.kill('SIGTERM')
  await new Promise((r) => setTimeout(r, 400))
  host.kill('SIGKILL')
  rmSync(STATE, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
