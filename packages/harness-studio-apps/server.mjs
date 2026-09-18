#!/usr/bin/env node
/**
 * Kiro Crew Node host — run the official dashboard SPA and the official apps
 * against a Node.js reimplementation of the gateway surface.
 *
 * Request flow:
 *
 *   GET  /                          302 -> the pinned app's page (--app),
 *                                   else the app library at /apps/library —
 *                                   never chat, whose surface this host only
 *                                   stubs
 *   GET  /assets/* /app-assets/*    static: hashed bundles + store art
 *   GET  /apps/<name>/ui/<entry>    static: federated app UI ESM bundles
 *   *    /apps/<name>/api/*         proxy: HMAC-signed forward to the app's
 *                                   Node backend process (or 502/403)
 *   *    /api/apps/<name>/*         hooks tier: HMAC-signed forward to the app's
 *                                   Node backend with the target unchanged,
 *                                   whenever a Node backend exists (or 502/403)
 *   *    /api/apps...               apps tier: records, manifests, enable/disable
 *   *    /api/*                     shell tier: stubs that keep the SPA booting
 *   GET  /api/ws                    minimal WebSocket accept
 *
 * An app's backend is whatever its manifest's ``backend.entry`` names, resolved
 * against the app's own directory. Validation (``lib/manifest.mjs``) refuses a
 * manifest naming a file that is not there, so a declared backend is one that
 * exists — the manifest and the process that runs cannot disagree.
 *
 * Usage:
 *   node server.mjs [--port 8799] [--dist <dir>] [--apps <dir>] [--home <dir>]
 *                   [--state-dir <dir>] [--enable app1,app2] [--app <name>]
 */
import { createServer } from 'node:http'
import { join } from 'node:path'

import { createLogger } from './lib/log.mjs'
import { resolveConfig } from './lib/config.mjs'
import { loadApps, loadInstalledApps } from './lib/manifests.mjs'
import { HostState } from './lib/state.mjs'
import { BackendManager } from './lib/backends.mjs'
import { createHostApi, CORE_APP_ROUTE_SEGMENTS } from './lib/hostApi.mjs'
import { createAppProxy } from './lib/proxy.mjs'
import { createStaticHandler } from './lib/static.mjs'
import { attachWebSocket } from './lib/ws.mjs'
import { sendJson } from './lib/httpUtil.mjs'

const logger = createLogger('host')

async function main() {
  const config = resolveConfig()
  if (config.distDir) {
    logger.info(`dist      ${config.distDir}`)
  } else {
    // Not fatal: apps carry their own UI bundles and the API surface is whole.
    logger.warn(
      'dist      (none) — SPA shell routes will 404; pass --dist <dir> or set KIROCREW_DIST_DIR',
    )
  }
  logger.info(`apps dir  ${config.appsDir}`)
  logger.info(`home      ${config.homeDir}`)

  const state = new HostState(config.stateDir)
  const apps = loadApps(config.appsDir, { logger })

  // Overlay the data home's installed records. Real installed metadata (the
  // enabled flag, timestamps, source) replaces the synthesized record, and an
  // app that exists ONLY in the data home joins the map.
  for (const [name, installed] of loadInstalledApps(join(config.homeDir, 'apps'), { logger })) {
    const existing = apps.get(name)
    if (existing) {
      existing.installedMeta = installed.installedMeta
      existing.manifest = installed.manifest
      existing.backendScript = installed.backendScript
      existing.dir = installed.dir
      existing.record = { ...existing.record, ...installed.record }
    } else {
      apps.set(name, installed)
    }
  }

  // Bind each app to the backend its MANIFEST declares. Validation already
  // refused a manifest whose `backend.entry` is not there, so a declared
  // backend is a backend that exists — the manifest and the process that runs
  // cannot disagree.
  const withBackend = []
  for (const app of apps.values()) {
    if (!app.manifest.backend || !app.backendScript) continue
    app.backendSpec = {
      script: app.backendScript,
      dir: app.dir,
      healthCheck: app.manifest.backend.healthCheck,
      startupTimeoutMs: app.manifest.backend.startupTimeoutMs,
      restart: app.manifest.backend.restart,
    }
    withBackend.push(app.name)
  }
  logger.info(`apps      ${[...apps.keys()].join(', ')}`)
  logger.info(`backends  ${withBackend.length ? withBackend.join(', ') : '(none)'}`)

  // Every route a manifest says an app PAGE owns (``ui.pages[].route``). The
  // static handler injects a chrome-hiding rule for these routes into the SPA
  // shell: an app page here is the whole window, not a pane inside the
  // dashboard shell. Federated apps declare the same field, so both app kinds
  // are covered without a second list.
  const appRoutes = [
    ...new Set(
      [...apps.values()]
        .flatMap((app) => app.manifest?.ui?.pages ?? [])
        .map((page) => page?.route)
        .filter((route) => typeof route === 'string' && route.startsWith('/'))
    ),
  ]
  if (appRoutes.length) logger.info(`app pages ${appRoutes.join(', ')}`)

  // `--app <name>` pins this host to one app: `/` opens its page, and the
  // app is enabled at boot (pinning a host to an app is an explicit operator
  // decision, same weight as --enable). Without it `/` lands on the app
  // library at /apps/library (the installed-app list with an Open action per
  // row, served straight from GET /api/apps) — the dashboard's chat landing
  // is exactly the surface this host does not implement, so it is never the
  // front door.
  const pinnedApp = config.app && apps.has(config.app) ? config.app : null
  if (config.app && !pinnedApp) {
    logger.warn(`--app ${config.app}: no such app — serving the app library at /`)
  }
  let rootRedirect = '/apps/library'
  if (pinnedApp) {
    const route = apps.get(pinnedApp).manifest?.ui?.pages?.[0]?.route
    if (route && route !== '/') rootRedirect = route
  }
  logger.info(`root      / -> ${rootRedirect}${pinnedApp ? ` (pinned: ${pinnedApp})` : ''}`)

  const backends = new BackendManager({ homeDir: config.homeDir, logger })

  // Single source of truth for "is this app on": an explicit decision (enable /
  // disable) wins, then the installed record's `enabled` flag, then the
  // manifest's `defaultEnabled`, then off. Both the host API and the proxy read
  // this, so what `/api/apps` reports and the proxy enforces cannot diverge.
  const isAppEnabled = (name) => {
    const decided = state.isEnabled(name)
    if (decided !== undefined) return decided
    const app = apps.get(name)
    if (!app) return false
    if (typeof app.installedMeta?.enabled === 'boolean') return app.installedMeta.enabled
    return app.manifest.defaultEnabled === true
  }

  // Official UI-file root for federated apps: <home>/apps/<name>/ui — the
  // same location the Python gateway serves /apps/<name>/ui/* from.
  const staticHandler = createStaticHandler({
    distDir: config.distDir,
    apps,
    installedAppsDir: join(config.homeDir, 'apps'),
    appRoutes,
    isAppEnabled,
  })
  const hostApi = createHostApi({ apps, state, backends, config, logger, isAppEnabled })
  const proxy = createAppProxy({
    backends,
    isAppEnabled,
    secretFor: (name) => state.secretFor(name),
    // The proxy reads the app's manifest for its own policy: the inbound gate,
    // the body ceiling, and the header allow-list are all manifest-declared.
    appFor: (name) => apps.get(name),
    host: '127.0.0.1',
    logger,
  })

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
    const path = url.pathname
    const started = Date.now()
    res.on('finish', () => {
      if (path.startsWith('/assets/')) return // hashed bundles: too noisy to log
      logger.info(`${req.method} ${req.url} -> ${res.statusCode} (${Date.now() - started}ms)`)
    })

    try {
      // `/` is the front door, and it is never chat: this host exists to run
      // apps, and its chat surface is only stubbed (a chat landing would open
      // an error boundary). Pinned app first, the app list otherwise.
      if (path === '/' && (req.method === 'GET' || req.method === 'HEAD')) {
        res.writeHead(302, { Location: rootRedirect, 'Cache-Control': 'no-store' })
        res.end()
        return
      }
      const appApi = path.match(/^\/apps\/([^/]+)\/api\/?(.*)$/)
      if (appApi) {
        const [, name, rest] = appApi
        await proxy.handle(req, res, url, decodeURIComponent(name), rest)
        return
      }
      // Hooks-tier apps answer at /api/apps/<name>/<path> (the in-gateway
      // namespace) whenever a Node backend exists. The manifest's
      // ``backend.routes`` is NOT consulted: upstream mounts every builtin's
      // hooks unconditionally (dashboard/routes/system.py imports each
      // builtin and calls register_routes), so requiring the manifest to say
      // so would 404 the very apps whose manifest stays silent — their
      // fallback stub crashes the page instead. The tail must be non-empty,
      // and its first segment must not be a CORE segment: an app-declared
      // route may never use one upstream, so /api/apps/<name>/enable and
      // friends stay the host's own endpoints.
      const hooksApi = path.match(/^\/api\/apps\/([^/]+)\/(.+)$/)
      if (hooksApi) {
        const name = decodeURIComponent(hooksApi[1])
        const app = apps.get(name)
        let head = hooksApi[2].split('/')[0]
        try {
          head = decodeURIComponent(head)
        } catch {
          /* malformed escape — never a reserved segment */
        }
        if (!CORE_APP_ROUTE_SEGMENTS.has(head) && app?.backendSpec) {
          await proxy.handleHooks(req, res, name)
          return
        }
      }
      if (path === '/api/ws') {
        sendJson(res, 400, { error: 'websocket endpoint — connect with a WebSocket client' })
        return
      }
      if (path.startsWith('/api/') || path === '/api') {
        await hostApi.handle(req, res, url)
        return
      }
      if (await staticHandler.handle(req, res, url)) return
      sendJson(res, 404, { error: `not found: ${path}` })
    } catch (err) {
      logger.error(`request failed: ${req.method} ${req.url}`, err)
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' })
      else res.end()
    }
  })

  attachWebSocket(server, { path: '/api/ws', logger })

  await new Promise((resolve) => server.listen(config.port, config.host, resolve))
  logger.info(`dashboard http://${config.host}:${config.port}/`)

  // `--enable a,b` is an explicit enable (a state write), so it behaves
  // exactly like a click in the dashboard and survives restarts. A pinned
  // app (--app) carries the same weight.
  for (const name of [...config.enableList, ...(pinnedApp ? [pinnedApp] : [])]) {
    if (!apps.has(name)) {
      logger.warn(`--enable ${name}: no such app`)
      continue
    }
    state.setEnabled(name, true)
  }

  // Bring up every app that is on: an operator decision (--enable / --app or a
  // click), the installed record, or the manifest's `defaultEnabled`.
  await hostApi.startEnabledApps()

  const shutdown = () => {
    logger.info('shutting down — stopping app backends')
    backends.stopAll()
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 1500).unref()
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => {
  logger.error('fatal', err)
  process.exit(1)
})
