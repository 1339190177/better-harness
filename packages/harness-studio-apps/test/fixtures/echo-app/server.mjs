/**
 * Test fixture backend: reports back exactly what crossed the proxy hop, so
 * the host's header and body policy can be OBSERVED instead of asserted from
 * the source. Also exits on demand, which is how the restart policy is tested.
 */
import { createAppServer, sendJson } from '../../../lib/appServer.mjs'

const ROUTES = [
  // What the proxy actually forwarded: header names only, so a leaked value
  // never lands in test output.
  ['GET', ['headers'], (req, res) => sendJson(res, 200, { headers: Object.keys(req.headers).sort() })],
  ['POST', ['echo'], (req, res, { raw }) => sendJson(res, 200, { bytes: raw.length })],
  // The pid changes when the host respawns the process.
  ['GET', ['pid'], (req, res) => sendJson(res, 200, { pid: process.pid })],
  [
    'POST',
    ['crash'],
    (req, res) => {
      sendJson(res, 200, { ok: true })
      setTimeout(() => process.exit(3), 20)
    },
  ],
]

createAppServer({ appName: 'echo-app', routes: ROUTES })
