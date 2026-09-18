/**
 * Host API surface of the compat host.
 *
 * Two tiers:
 *
 *  1. **Apps tier — real, contract-faithful.** `/api/apps`, its per-app
 *     lifecycle endpoints and the per-app config document (`config.json`,
 *     upstream `handle_app_config`) return the same record shape the gateway's
 *     `apps/manager.list_apps()` returns (installed metadata + parsed manifest
 *     + `backend_status`), because that is what the dashboard SPA normalizes
 *     and what app UIs depend on.
 *
 *  2. **Shell tier — stubs for everything else.** The dashboard shell polls a
 *     large surface (chat slots, notifications, status, metrics, ...) that the
 *     compat host does not implement yet. Each known endpoint answers the
 *     shape its consumer tolerates (empty list / empty object); unknown
 *     endpoints answer `{}` and are logged once, so the browser console stays
 *     the source of truth for what to implement next.
 */
import { existsSync, readFileSync } from 'node:fs'
import { arch, platform } from 'node:os'
import { join } from 'node:path'
import { atomicWrite } from './appServer.mjs'
import { BodyTooLargeError, readBody, sendJson } from './httpUtil.mjs'

/** Ceiling on a per-app config document (`PUT /api/apps/<name>/config`). */
const CONFIG_MAX_BYTES = 256 * 1024

/**
 * First path segments under ``/api/apps/<name>/`` that the CORE owns — the
 * mirror of ``CORE_APP_ROUTE_SEGMENTS`` in ``apps/manifest.py``. Upstream the
 * dynamic lifecycle routes are registered BEFORE any builtin's literal routes
 * and aiohttp resolves in registration order, so the core handler answers a
 * builtin's own ``/config`` too — a builtin's enabled gate is skipped there
 * exactly as here (the ordering contract is pinned by
 * ``test/test_dashboard_route_table.py``). The hooks-tier proxy therefore
 * never forwards one into a backend; this host serves the lifecycle actions
 * and ``config`` below and answers the rest from the stub tier.
 */
export const CORE_APP_ROUTE_SEGMENTS = new Set([
  '_jobs',
  'config',
  'dev',
  'disable',
  'enable',
  'manifest',
  'migrate-cleanup',
  'open',
  'token',
  'uninstall',
  'update',
])

/** Endpoints whose consumers expect a bare JSON array. */
const LIST_ENDPOINTS = new Set([
  '/api/approvals',
  '/api/chat/slots',
  '/api/chat/tags',
  '/api/chat/tag-columns',
  '/api/chat/folders',
  '/api/cron-folders',
  '/api/artifact-folders',
  '/api/terminal/sessions',
  '/api/agents/installed',
  '/api/spawn',
  '/api/ask-question/pending',
  '/api/models',
  '/api/sessions',
  '/api/skills',
  '/api/agents',
  '/api/crons',
  '/api/prompts',
  '/api/mcp/active',
  '/api/workspaces',
  '/api/hooks',
  '/api/monitors',
  '/api/themes',
  '/api/artifacts',
  '/api/tasks/summary',
])

/** Endpoints with a known, minimal, tolerable shape. */
const SHAPED_STUBS = {
  '/api/notifications': () => ({ notifications: [] }),
  '/api/changelog': () => ({ content: '' }),
  '/api/ready': () => ({ ok: true }),
  // The shell renders these numbers straight into the status chrome; an empty
  // object leaves them undefined rather than zero.
  '/api/status': () => ({
    uptime: '0s',
    start_time: Math.trunc(Date.now() / 1000),
    sessions: 0,
    messages: 0,
    cron_jobs: 0,
    lessons: 0,
    subagents: 0,
    update_available: false,
  }),
  '/api/system': () => ({}),
  '/api/dashboard/config': () => ({}),
  '/api/dashboard/branding': () => ({
    bot_name: 'Kiro Crew',
    avatar: '/logo.png',
    direct_local: true,
  }),
  // The prerequisite gate blocks the whole dashboard until this answers
  // `ready` (or `initial_setup_complete`): an empty object reads as "CLI not
  // installed" and pins the SPA on the install-Kiro-CLI screen.
  '/api/kiro-prerequisite': () => ({
    platform: 'gateway',
    installed: true,
    authenticated: true,
    ready: true,
    initial_setup_complete: true,
    repair_required: false,
    docs_url: '',
    login_command: 'kiro-cli login',
    sso_login_command: '',
    setup_allowed: true,
    sandbox_unavailable: false,
    sandbox_failure_kind: '',
    sandbox_detail: '',
    acp_supported: true,
    update_command: '',
    cli_update_error: '',
  }),
  '/api/theme/boot': () => ({}),
  '/api/sessions/usage': () => ({}),
  '/api/auth/refresh': () => ({}),
  '/api/auth/me': () => ({ authenticated: true, user: null }),
  // Consumed as `{runs?: WorkflowRunSummary[]}` and `{default_agent?: string}`.
  '/api/workflows/runs': () => ({ runs: [] }),
  '/api/config/default-agent': () => ({ default_agent: '' }),
}

export function createHostApi({ apps, state, backends, config, logger, isAppEnabled }) {
  const loggedUnknown = new Set()

  function appRecords({ enabledOnly = false } = {}) {
    const out = []
    for (const app of apps.values()) {
      const enabled = isAppEnabled(app.name)
      if (enabledOnly && !enabled) continue
      const backendStatus = backends.status(app.name)
      const record = { ...app.record, enabled }
      if (backendStatus) record.backend_status = backendStatus
      out.push(record)
    }
    return out
  }

  async function enableApp(name) {
    const app = apps.get(name)
    if (!app) return null
    state.setEnabled(name, true)
    if (app.backendSpec) await backends.start(name, app.backendSpec, state.secretFor(name))
    return { ok: true, name, enabled: true, backend_status: backends.status(name) }
  }

  function disableApp(name) {
    const app = apps.get(name)
    if (!app) return null
    state.setEnabled(name, false)
    backends.stop(name)
    return { ok: true, name, enabled: false }
  }

  /**
   * Bring up every app that is on at boot. What "on" means is decided once, by
   * ``isAppEnabled``: an explicit enable/disable, else the installed record,
   * else the manifest's ``defaultEnabled``. Resolving it into state here makes
   * the boot decision durable, so an app does not silently change sides when
   * its manifest is edited later.
   */
  async function startEnabledApps() {
    for (const app of apps.values()) {
      if (!isAppEnabled(app.name)) continue
      state.setEnabled(app.name, true)
      if (app.backendSpec) await backends.start(app.name, app.backendSpec, state.secretFor(app.name))
    }
  }

  /**
   * GET/PUT /api/apps/<name>/config — the twin of upstream
   * ``handle_app_config`` (apps/routes.py).
   *
   * Reads/writes the same file the app itself reads:
   * ``<home>/apps/<name>/data/config.json``. GET returns the current document
   * and seeds ``{}`` (best effort, exactly as upstream) when the file is
   * missing, so an app shows defaults instead of a perpetual loading state.
   * PUT replaces it after an object check. The SEL audit entry the upstream
   * PUT writes has no counterpart in this host and is omitted, never faked.
   */
  async function handleAppConfig(req, res, name) {
    const app = apps.get(name)
    if (!app) return sendJson(res, 404, { error: `app '${name}' not installed` })
    const file = join(config.homeDir, 'apps', name, 'data', 'config.json')

    if (req.method === 'GET') {
      if (!existsSync(file)) {
        try {
          atomicWrite(file, '{}\n')
        } catch {
          /* the seed is best effort, exactly as upstream */
        }
        return sendJson(res, 200, {})
      }
      try {
        return sendJson(res, 200, JSON.parse(readFileSync(file, 'utf-8')))
      } catch (err) {
        return sendJson(res, 500, { error: `failed to read config: ${err.message}` })
      }
    }

    let raw
    try {
      // A config document is a settings blob, not an upload; the ceiling keeps
      // a PUT from being an out-of-memory.
      raw = await readBody(req, { limit: CONFIG_MAX_BYTES })
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        return sendJson(
          res,
          413,
          { code: 'body_too_large', error: `config must be under ${CONFIG_MAX_BYTES} bytes` },
          { close: true },
        )
      }
      throw err
    }
    let body
    try {
      body = JSON.parse(raw.toString('utf-8'))
    } catch {
      return sendJson(res, 400, { error: 'invalid JSON' })
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return sendJson(res, 400, { error: 'config must be a JSON object' })
    }
    try {
      atomicWrite(file, `${JSON.stringify(body, null, 2)}\n`)
    } catch (err) {
      return sendJson(res, 500, { error: `failed to write config: ${err.message}` })
    }
    return sendJson(res, 200, { ok: true, name })
  }

  async function handle(req, res, url) {
    const path = url.pathname
    if (!path.startsWith('/api/') && path !== '/api') return false
    const method = req.method

    // ---- Apps tier -------------------------------------------------------
    if (path === '/api/apps' && method === 'GET') {
      sendJson(res, 200, appRecords())
      return true
    }
    if (path === '/api/apps/registry' && method === 'GET') {
      sendJson(res, 200, {
        apps: [],
        serverPlatform: { os: platform(), arch: arch() },
        categoryOrder: [],
        editorialSections: [],
      })
      return true
    }
    if (path === '/api/apps/registries' && method === 'GET') {
      sendJson(res, 200, { registries: [], pinned: [] })
      return true
    }
    const appConfigMatch = path.match(/^\/api\/apps\/([^/]+)\/config$/)
    if (appConfigMatch) {
      const name = decodeURIComponent(appConfigMatch[1])
      if (method === 'GET' || method === 'PUT') return handleAppConfig(req, res, name)
      sendJson(res, 405, { error: 'method not allowed' })
      return true
    }

    const appMatch = path.match(/^\/api\/apps\/([^/]+)(\/(manifest|enable|disable|open))?$/)
    if (appMatch) {
      const name = decodeURIComponent(appMatch[1])
      const action = appMatch[3]
      const app = apps.get(name)

      if (method === 'GET' && !action) {
        if (!app) return sendJson(res, 404, { error: `app '${name}' not installed` })
        sendJson(res, 200, appRecords().find((r) => r.name === name))
        return true
      }
      if (method === 'GET' && action === 'manifest') {
        if (!app) return sendJson(res, 404, { error: `app '${name}' not installed` })
        sendJson(res, 200, app.manifest)
        return true
      }
      if (method === 'POST' && action === 'enable') {
        const result = await enableApp(name)
        if (!result) return sendJson(res, 404, { error: `app '${name}' not installed` })
        return sendJson(res, 200, result)
      }
      if (method === 'POST' && action === 'disable') {
        const result = disableApp(name)
        if (!result) return sendJson(res, 404, { error: `app '${name}' not installed` })
        return sendJson(res, 200, result)
      }
      if (method === 'POST' && action === 'open') {
        return sendJson(res, 200, { ok: true, name })
      }
    }

    // A core segment the host reserves but has not implemented must SAY so.
    // These used to fall through to the shell tier's `200 {}`, which meant
    // `POST /api/apps/<name>/uninstall` answered as though it had worked.
    const coreMatch = path.match(/^\/api\/apps\/([^/]+)\/([^/]+)/)
    if (coreMatch && CORE_APP_ROUTE_SEGMENTS.has(decodeURIComponent(coreMatch[2]))) {
      const segment = decodeURIComponent(coreMatch[2])
      sendJson(res, 501, {
        code: 'not_implemented',
        error: `this host reserves /api/apps/<name>/${segment} but does not implement it`,
      })
      return true
    }

    // A debug view of what this host actually is/loaded.
    if (path === '/api/host/info' && method === 'GET') {
      sendJson(res, 200, {
        mode: 'kirocrew-node-host',
        distDir: config.distDir,
        appsDir: config.appsDir,
        homeDir: config.homeDir,
        apps: [...apps.values()].map((a) => ({
          name: a.name,
          dir: a.dir,
          nodeBackend: a.backendSpec ? a.backendSpec.script : null,
          enabled: isAppEnabled(a.name),
          backendStatus: backends.status(a.name),
        })),
      })
      return true
    }

    // ---- Shell tier ------------------------------------------------------
    // Feature-off endpoints answer the refusal the gateway itself serves when
    // the feature is disabled (non-2xx on purpose: the SPA branches on the
    // status, e.g. `error.status === 403` means "instances feature off",
    // while a 200 `{}` would break its `.instances` iteration).
    if (path === '/api/instances' || path.startsWith('/api/instances/')) {
      sendJson(res, 403, { error: 'instances feature is disabled (set instances.enabled=true)' })
      return true
    }

    if (method === 'GET' || method === 'POST' || method === 'PUT' || method === 'DELETE') {
      const stub = SHAPED_STUBS[path]
      if (stub) {
        sendJson(res, 200, stub())
        return true
      }
      if (LIST_ENDPOINTS.has(path)) {
        sendJson(res, 200, [])
        return true
      }
      // Unknown: keep the shell alive with an empty object, but say so once.
      if (!loggedUnknown.has(path)) {
        loggedUnknown.add(path)
        logger.warn(`unhandled host API ${method} ${path} — answered {} (add a real handler when the UI needs it)`)
      }
      sendJson(res, 200, {})
      return true
    }

    sendJson(res, 405, { error: 'method not allowed' })
    return true
  }

  return { handle, appRecords, enableApp, disableApp, startEnabledApps }
}
