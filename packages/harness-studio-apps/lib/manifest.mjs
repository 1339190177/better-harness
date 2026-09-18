/**
 * App manifest contract — parse, validate and normalize ``app.json``.
 *
 * The rule this module exists to enforce: **every field in the schema is a
 * field the host reads.** A manifest that declares a backend the host will not
 * spawn, or a permission nothing checks, is worse than one that declares
 * nothing — it reads as a promise. So validation REFUSES rather than coerces:
 * an app whose manifest cannot be trusted is not loaded, and the reason is
 * logged with the field that caused it.
 *
 * The result splits two ways:
 *
 *   - ``errors``   the manifest cannot be trusted; the app does not load,
 *   - ``warnings`` the app loads, but something declared will not do what its
 *                  author expects (an entry nothing routes to, a contribution
 *                  the shell does not render yet, a platform mismatch).
 *
 * Nothing is dropped quietly. The upstream KiroCrew manifest carries
 * ``bad_commands`` / ``dropped_commands`` flags precisely because coercing a
 * malformed declaration to ``[]`` is indistinguishable from a deliberate empty
 * list — the author sees no error and no rows. Here that case is a warning with
 * the path in it.
 *
 * ``schema/app.schema.json`` is the same contract for editors. It is stricter
 * in exactly one way: unknown properties are an error there (so a typo gets a
 * squiggle while you write) and a warning here (so a manifest written against a
 * newer schema still loads on an older host).
 */
import { existsSync, statSync } from 'node:fs'
import { platform as osPlatform } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'

/** The contract version this host implements. */
export const APP_SCHEMA_VERSION = 1

/** App names are kebab-case: they land in URLs, in paths, and in React keys. */
export const APP_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * Names the host's own routes already answer. An app may not take one, or
 * ``/api/apps/registry`` would mean two things depending on what is installed.
 */
export const RESERVED_APP_NAMES = new Set([
  'api', 'apps', 'assets', 'health', 'host', 'library',
  'new', 'registries', 'registry', 'static', 'ui',
])

/** Executable entries are ESM only; the UI static tier serves nothing else as code. */
const ENTRY_EXTENSIONS = ['.mjs', '.js']

/** Upstream's cap, kept: a control renders in the composer on the path of every turn. */
export const MAX_SESSION_CONTROLS = 2

/**
 * Headers the proxy will never copy from the browser into an app backend, even
 * when a manifest asks. An app backend is third-party code that already has its
 * own identity on the HMAC hop; handing it the host's session credential is the
 * hole the HMAC exists to close, not a configuration choice.
 */
export const FORBIDDEN_FORWARD_HEADERS = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
  'set-cookie',
  'x-harness-app-proxy',
  'x-kirocrew-proxy',
])

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const EVENT_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*:[a-z0-9]+(?:-[a-z0-9]+)*$/
const ROUTE = /^\/[A-Za-z0-9][A-Za-z0-9._~-]*(?:\/[A-Za-z0-9][A-Za-z0-9._~-]*)*$/
const HEALTH_PATH = /^\/[A-Za-z0-9._~\-/]*$/
const EXPORT_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/
// A status route is a path INSIDE the app's own backend, so it is deliberately
// not a URL: no scheme, no host, no query. The host prefixes the app's API base
// itself, which is what stops a control from pointing the poll at another origin.
const STATUS_PATH = /^[a-z0-9][a-z0-9/_-]{0,63}$/

const TOP_LEVEL_FIELDS = new Set([
  '$schema', 'schemaVersion', 'name', 'version', 'displayName', 'description',
  'author', 'license', 'tags', 'defaultEnabled',
  'ui', 'backend', 'capabilities', 'contributes', 'platform',
])

/**
 * Fields from the upstream KiroCrew manifest that this host does NOT implement,
 * mapped to what to do instead. A ported manifest gets told exactly where the
 * two platforms differ instead of installing with half its declarations inert.
 */
const LEGACY_FIELDS = new Map([
  ['permissions', 'use `capabilities` — it is enforced, `permissions` never was'],
  ['minKiroCrewVersion', 'drop it; this host versions the contract through `schemaVersion`'],
  ['signer', 'drop it; this host has no admission/signature tier'],
  ['signature', 'drop it; this host has no admission/signature tier'],
  ['crons', 'drop it; this host runs no scheduler'],
  ['agents', 'drop it; agent/skill/SOP bundles are not installed by this host'],
  ['skills', 'drop it; agent/skill/SOP bundles are not installed by this host'],
  ['sops', 'drop it; agent/skill/SOP bundles are not installed by this host'],
  ['mcpServers', 'drop it; this host registers no MCP servers'],
  ['setup', 'drop it; this host runs no install/enable lifecycle scripts'],
  ['dependencies', 'drop it; this host provisions no dependencies'],
  ['notifications', 'drop it; this host has no notification channel registry'],
  ['publishProvider', 'drop it; this host has no artifact publish tier'],
  ['jobFamilies', 'drop it; this host has no job tier'],
  ['iconUrl', 'drop it; this host serves no `/app-assets` store art'],
  ['heroImage', 'drop it; this host serves no `/app-assets` store art'],
  ['heroImageDark', 'drop it; this host serves no `/app-assets` store art'],
  ['heroImageDetail', 'drop it; this host serves no `/app-assets` store art'],
  ['heroImageDetailDark', 'drop it; this host serves no `/app-assets` store art'],
  ['screenshots', 'drop it; this host serves no `/app-assets` store art'],
  ['highlights', 'fold it into `description`; this host has no store listing'],
  ['useCases', 'fold it into `description`; this host has no store listing'],
  ['configuration', 'fold it into `description`; this host has no store listing'],
  ['extra', 'drop it; unknown keys are already reported as warnings'],
])

const LEGACY_BACKEND_FIELDS = new Map([
  ['entryPoint', 'rename to `entry` — a path relative to the app root, not a module name'],
  ['port', 'drop it; the host always allocates a free port'],
  ['routes', 'drop it; this host has no in-gateway hooks tier'],
  ['hooks', 'drop it; this host has no in-gateway hooks tier'],
  ['type', 'rename to `kind`'],
])

/** Defaults applied to every normalized manifest, so the host reads one shape. */
const DEFAULT_BACKEND = {
  kind: 'node',
  healthCheck: '/health',
  maxBodyBytes: 1024 * 1024,
  startupTimeoutMs: 10_000,
  restart: { policy: 'on-failure', maxRetries: 3, backoffMs: 1000 },
}

/**
 * Capability defaults. The set is short on purpose: a backend is an ordinary
 * child process, so anything this host cannot actually withhold (outbound
 * network, filesystem reach) is NOT a field here — declaring it would document
 * a boundary that does not exist. Those return when there is a sandbox to
 * enforce them. Every app gets ``<home>/apps/<name>/data`` unconditionally.
 */
const DEFAULT_CAPABILITIES = {
  http: { inbound: true },
  events: [],
  forwardHeaders: [],
}

/** Capability names that belonged to another platform's model, with the reason. */
const UNENFORCEABLE_CAPABILITIES = new Map([
  ['storage', 'every app already gets `<home>/apps/<name>/data`; there is nothing to grant'],
  ['network', 'a backend is a child process — this host cannot withhold outbound network'],
  ['memory', 'this host has no memory store to scope'],
  ['cron', 'this host runs no scheduler'],
  ['spawn', 'this host spawns no agents'],
  ['jobs', 'this host has no job tier'],
  ['mcpTools', 'this host registers no MCP servers'],
  ['api', 'the proxy namespace is derived from `name`, not declared'],
])

const RESTART_POLICIES = new Set(['never', 'on-failure', 'always'])
const BACKEND_KINDS = new Set(['node'])
const OS_NAMES = new Set(['macos', 'linux', 'windows'])

/** The schema's `platform.os` spelling for the machine this host runs on. */
export function currentOsName(value = osPlatform()) {
  if (value === 'darwin') return 'macos'
  if (value === 'win32') return 'windows'
  return 'linux'
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Why *value* is not usable as a path relative to *root*, or null when it is.
 * Absolute paths, `..` segments and backslashes are all refused before the
 * filesystem is touched, so a manifest can never name a file outside its app.
 */
function relativeEntryError(value, { extensions = ENTRY_EXTENSIONS } = {}) {
  if (typeof value !== 'string' || value === '') return 'must be a non-empty string'
  if (isAbsolute(value) || value.startsWith('/')) return 'must be relative, not absolute'
  if (value.includes('\\')) return 'must use forward slashes'
  if (value.split('/').includes('..')) return 'must not contain a `..` segment'
  if (!extensions.some((ext) => value.toLowerCase().endsWith(ext))) {
    return `must end in ${extensions.join(' or ')}`
  }
  return null
}

/** True when *candidate* resolves to a regular file inside *root*. */
function fileInside(root, candidate) {
  const base = resolve(root)
  const target = resolve(join(base, candidate))
  if (target !== base && !target.startsWith(base + sep)) return false
  try {
    return statSync(target).isFile()
  } catch {
    return false
  }
}

/** Collects `{code, path, message}` entries into an errors/warnings pair. */
function createReport() {
  const errors = []
  const warnings = []
  return {
    errors,
    warnings,
    error(code, path, message) {
      errors.push({ code, path, message })
    },
    warn(code, path, message) {
      warnings.push({ code, path, message })
    },
    /** Type guard that reports and returns false, so callers read as one line. */
    expectObject(value, path, { optional = true } = {}) {
      if (value === undefined) {
        if (!optional) this.error('field_missing', path, `\`${path}\` is required`)
        return false
      }
      if (!isPlainObject(value)) {
        this.error('field_type', path, `\`${path}\` must be an object`)
        return false
      }
      return true
    },
    expectArray(value, path) {
      if (value === undefined) return false
      if (!Array.isArray(value)) {
        // Not coerced to []: an empty list and a malformed one would then be
        // indistinguishable, and the author would see neither rows nor an error.
        this.error('field_type', path, `\`${path}\` must be an array`)
        return false
      }
      return true
    },
    expectBoolean(value, path, fallback) {
      if (value === undefined) return fallback
      if (typeof value !== 'boolean') {
        this.error('field_type', path, `\`${path}\` must be a boolean`)
        return fallback
      }
      return value
    },
    expectInteger(value, path, { min, max, fallback }) {
      if (value === undefined) return fallback
      if (!Number.isInteger(value)) {
        this.error('field_type', path, `\`${path}\` must be an integer`)
        return fallback
      }
      if (value < min || value > max) {
        this.error('number_range', path, `\`${path}\` must be between ${min} and ${max} (got ${value})`)
        return fallback
      }
      return value
    },
  }
}

function validateUi(raw, report, appDir) {
  if (raw === undefined) return undefined
  if (!report.expectObject(raw, 'ui')) return undefined

  const ui = {}
  for (const key of Object.keys(raw)) {
    if (key !== 'entry' && key !== 'export' && key !== 'pages') {
      report.warn('unknown_field', `ui.${key}`, `unknown field \`ui.${key}\` — ignored`)
    }
  }

  if (raw.entry !== undefined) {
    const reason = relativeEntryError(raw.entry)
    if (reason) report.error('ui_entry_invalid', 'ui.entry', `\`ui.entry\` ${reason}`)
    else if (appDir && !fileInside(join(appDir, 'ui'), raw.entry)) {
      report.error(
        'ui_entry_missing_file',
        'ui.entry',
        `\`ui.entry\` names \`ui/${raw.entry}\`, which does not exist`,
      )
    } else ui.entry = raw.entry
  }

  if (raw.export !== undefined) {
    if (typeof raw.export !== 'string' || (raw.export !== 'default' && !EXPORT_NAME.test(raw.export))) {
      report.error('ui_export_invalid', 'ui.export', '`ui.export` must be `default` or a valid identifier')
    } else ui.export = raw.export
  }
  ui.export ??= 'default'

  ui.pages = []
  if (report.expectArray(raw.pages, 'ui.pages')) {
    const seen = new Set()
    raw.pages.forEach((page, index) => {
      const at = `ui.pages[${index}]`
      if (!report.expectObject(page, at, { optional: false })) return
      for (const key of Object.keys(page)) {
        if (key !== 'route' && key !== 'label' && key !== 'icon') {
          report.warn('unknown_field', `${at}.${key}`, `unknown field \`${at}.${key}\` — ignored`)
        }
      }
      if (typeof page.route !== 'string' || page.route === '') {
        report.error('ui_page_route_invalid', `${at}.route`, `\`${at}.route\` is required`)
        return
      }
      if (page.route === '/') {
        // A root route never prefix-matches anything but itself upstream either:
        // an app routed at "/" would swallow the whole shell.
        report.error('ui_page_route_root', `${at}.route`, `\`${at}.route\` may not be \`/\``)
        return
      }
      if (!ROUTE.test(page.route)) {
        report.error(
          'ui_page_route_invalid',
          `${at}.route`,
          `\`${at}.route\` must be an absolute path with no query, \`..\` or empty segment`,
        )
        return
      }
      if (seen.has(page.route)) {
        report.error('ui_page_route_duplicate', `${at}.route`, `route \`${page.route}\` is declared twice`)
        return
      }
      seen.add(page.route)
      if (typeof page.label !== 'string' || page.label === '') {
        report.error('ui_page_label_missing', `${at}.label`, `\`${at}.label\` is required`)
        return
      }
      const entry = { route: page.route, label: page.label }
      if (typeof page.icon === 'string' && page.icon !== '') entry.icon = page.icon
      ui.pages.push(entry)
    })
  }

  // `ui.entry` without `ui.pages` is NOT a mistake: an embedding shell (the
  // Studio app workbench) mounts the entry from the app list directly. Pages
  // only add a route of the app's own in the standalone host, so an app that is
  // never visited by URL legitimately declares none.
  if (ui.entry === undefined && ui.pages.length > 0) {
    report.error(
      'ui_pages_without_entry',
      'ui.entry',
      '`ui.pages` is declared without `ui.entry` — the pages have nothing to render',
    )
  }
  return ui
}

function validateBackend(raw, report, appDir) {
  if (raw === undefined) return undefined
  if (!report.expectObject(raw, 'backend')) return undefined

  const backend = { ...DEFAULT_BACKEND, restart: { ...DEFAULT_BACKEND.restart } }
  const known = new Set(['kind', 'entry', 'healthCheck', 'maxBodyBytes', 'startupTimeoutMs', 'restart'])
  for (const key of Object.keys(raw)) {
    if (known.has(key)) continue
    const hint = LEGACY_BACKEND_FIELDS.get(key)
    if (hint) report.warn('legacy_field', `backend.${key}`, `\`backend.${key}\` is not part of v1 — ${hint}`)
    else report.warn('unknown_field', `backend.${key}`, `unknown field \`backend.${key}\` — ignored`)
  }

  if (raw.kind !== undefined) {
    if (!BACKEND_KINDS.has(raw.kind)) {
      report.error(
        'backend_kind_unsupported',
        'backend.kind',
        `\`backend.kind\` must be one of ${[...BACKEND_KINDS].join(', ')}`,
      )
    } else backend.kind = raw.kind
  }

  if (raw.entry === undefined) {
    // The whole point of declaring the backend: discovery by file presence let
    // the manifest and the process that actually runs disagree.
    report.error('backend_entry_missing', 'backend.entry', '`backend.entry` is required when `backend` is declared')
  } else {
    const reason = relativeEntryError(raw.entry)
    if (reason) report.error('backend_entry_invalid', 'backend.entry', `\`backend.entry\` ${reason}`)
    else if (appDir && !fileInside(appDir, raw.entry)) {
      report.error(
        'backend_entry_missing_file',
        'backend.entry',
        `\`backend.entry\` names \`${raw.entry}\`, which does not exist`,
      )
    } else backend.entry = raw.entry
  }

  if (raw.healthCheck !== undefined) {
    if (typeof raw.healthCheck !== 'string' || !HEALTH_PATH.test(raw.healthCheck)) {
      report.error(
        'backend_health_check_invalid',
        'backend.healthCheck',
        '`backend.healthCheck` must be an absolute path with no query',
      )
    } else backend.healthCheck = raw.healthCheck
  }

  backend.maxBodyBytes = report.expectInteger(raw.maxBodyBytes, 'backend.maxBodyBytes', {
    min: 0,
    max: 256 * 1024 * 1024,
    fallback: DEFAULT_BACKEND.maxBodyBytes,
  })
  backend.startupTimeoutMs = report.expectInteger(raw.startupTimeoutMs, 'backend.startupTimeoutMs', {
    min: 1000,
    max: 300_000,
    fallback: DEFAULT_BACKEND.startupTimeoutMs,
  })

  if (report.expectObject(raw.restart, 'backend.restart')) {
    for (const key of Object.keys(raw.restart)) {
      if (key !== 'policy' && key !== 'maxRetries' && key !== 'backoffMs') {
        report.warn('unknown_field', `backend.restart.${key}`, `unknown field \`backend.restart.${key}\` — ignored`)
      }
    }
    if (raw.restart.policy !== undefined) {
      if (!RESTART_POLICIES.has(raw.restart.policy)) {
        report.error(
          'backend_restart_policy_invalid',
          'backend.restart.policy',
          `\`backend.restart.policy\` must be one of ${[...RESTART_POLICIES].join(', ')}`,
        )
      } else backend.restart.policy = raw.restart.policy
    }
    backend.restart.maxRetries = report.expectInteger(raw.restart.maxRetries, 'backend.restart.maxRetries', {
      min: 0,
      max: 20,
      fallback: DEFAULT_BACKEND.restart.maxRetries,
    })
    backend.restart.backoffMs = report.expectInteger(raw.restart.backoffMs, 'backend.restart.backoffMs', {
      min: 100,
      max: 60_000,
      fallback: DEFAULT_BACKEND.restart.backoffMs,
    })
  }

  return backend
}

function validateCapabilities(raw, report) {
  const caps = {
    http: { ...DEFAULT_CAPABILITIES.http },
    events: [],
    forwardHeaders: [],
  }
  if (raw === undefined) return caps
  if (!report.expectObject(raw, 'capabilities')) return caps

  for (const key of Object.keys(raw)) {
    if (['http', 'events', 'forwardHeaders'].includes(key)) continue
    const hint = UNENFORCEABLE_CAPABILITIES.get(key)
    if (hint) {
      report.warn(
        'capability_not_enforceable',
        `capabilities.${key}`,
        `\`capabilities.${key}\` is not part of v1 — ${hint}`,
      )
    } else {
      report.warn('unknown_field', `capabilities.${key}`, `unknown field \`capabilities.${key}\` — ignored`)
    }
  }

  if (report.expectObject(raw.http, 'capabilities.http')) {
    for (const key of Object.keys(raw.http)) {
      if (key !== 'inbound') {
        const hint = key === 'outbound' ? UNENFORCEABLE_CAPABILITIES.get('network') : undefined
        report.warn(
          hint ? 'capability_not_enforceable' : 'unknown_field',
          `capabilities.http.${key}`,
          hint
            ? `\`capabilities.http.${key}\` is not part of v1 — ${hint}`
            : `unknown field \`capabilities.http.${key}\` — ignored`,
        )
      }
    }
    caps.http.inbound = report.expectBoolean(raw.http.inbound, 'capabilities.http.inbound', true)
  }

  if (report.expectArray(raw.events, 'capabilities.events')) {
    raw.events.forEach((event, index) => {
      const at = `capabilities.events[${index}]`
      if (typeof event !== 'string' || !EVENT_NAME.test(event)) {
        report.error('capability_event_invalid', at, `\`${at}\` must be \`<scope>:<name>\` in kebab-case`)
        return
      }
      if (caps.events.includes(event)) {
        report.warn('capability_event_duplicate', at, `event \`${event}\` is declared twice`)
        return
      }
      caps.events.push(event)
    })
  }

  if (report.expectArray(raw.forwardHeaders, 'capabilities.forwardHeaders')) {
    raw.forwardHeaders.forEach((header, index) => {
      const at = `capabilities.forwardHeaders[${index}]`
      if (typeof header !== 'string' || !KEBAB.test(header)) {
        report.error('forward_header_invalid', at, `\`${at}\` must be a lowercase header name`)
        return
      }
      if (FORBIDDEN_FORWARD_HEADERS.has(header)) {
        // Not a policy knob: the backend is behind an HMAC hop with its own
        // identity, so the host's credential has no reason to cross it.
        report.error(
          'forward_header_forbidden',
          at,
          `\`${header}\` may never be forwarded to an app backend — it carries the host's own credentials`,
        )
        return
      }
      if (!caps.forwardHeaders.includes(header)) caps.forwardHeaders.push(header)
    })
  }

  return caps
}

function validateContributes(raw, report, appDir) {
  const out = { commands: [], sessionControls: [] }
  if (raw === undefined) return out
  if (!report.expectObject(raw, 'contributes')) return out

  for (const key of Object.keys(raw)) {
    if (key !== 'commands' && key !== 'sessionControls') {
      report.warn('unknown_field', `contributes.${key}`, `unknown field \`contributes.${key}\` — ignored`)
    }
  }

  if (report.expectArray(raw.commands, 'contributes.commands')) {
    const seen = new Set()
    raw.commands.forEach((command, index) => {
      const at = `contributes.commands[${index}]`
      if (!report.expectObject(command, at, { optional: false })) return
      if (typeof command.id !== 'string' || !KEBAB.test(command.id)) {
        report.error('contributes_command_invalid', `${at}.id`, `\`${at}.id\` must be kebab-case`)
        return
      }
      if (seen.has(command.id)) {
        report.error('contributes_id_duplicate', `${at}.id`, `command id \`${command.id}\` is declared twice`)
        return
      }
      if (typeof command.title !== 'string' || command.title === '') {
        report.error('contributes_command_invalid', `${at}.title`, `\`${at}.title\` is required`)
        return
      }
      if (typeof command.prompt !== 'string' || command.prompt === '') {
        report.error('contributes_command_invalid', `${at}.prompt`, `\`${at}.prompt\` is required`)
        return
      }
      seen.add(command.id)
      const entry = { id: command.id, title: command.title, prompt: command.prompt, autoSend: false }
      if (typeof command.subtitle === 'string' && command.subtitle) entry.subtitle = command.subtitle
      if (typeof command.icon === 'string' && command.icon) entry.icon = command.icon
      if (report.expectArray(command.keywords, `${at}.keywords`)) {
        entry.keywords = command.keywords.filter((word) => typeof word === 'string' && word !== '')
      }
      entry.autoSend = report.expectBoolean(command.autoSend, `${at}.autoSend`, false)
      out.commands.push(entry)
    })
  }

  if (report.expectArray(raw.sessionControls, 'contributes.sessionControls')) {
    if (raw.sessionControls.length > MAX_SESSION_CONTROLS) {
      report.error(
        'contributes_session_controls_cap',
        'contributes.sessionControls',
        `at most ${MAX_SESSION_CONTROLS} session controls per app (got ${raw.sessionControls.length})`,
      )
    }
    const seen = new Set()
    raw.sessionControls.forEach((control, index) => {
      const at = `contributes.sessionControls[${index}]`
      if (!report.expectObject(control, at, { optional: false })) return
      if (typeof control.id !== 'string' || !KEBAB.test(control.id)) {
        report.error('contributes_session_control_invalid', `${at}.id`, `\`${at}.id\` must be kebab-case`)
        return
      }
      if (seen.has(control.id)) {
        report.error('contributes_id_duplicate', `${at}.id`, `session control id \`${control.id}\` is declared twice`)
        return
      }
      const reason = relativeEntryError(control.entry)
      if (reason) {
        report.error('contributes_session_control_invalid', `${at}.entry`, `\`${at}.entry\` ${reason}`)
        return
      }
      if (appDir && !fileInside(join(appDir, 'ui'), control.entry)) {
        report.error(
          'contributes_session_control_invalid',
          `${at}.entry`,
          `\`${at}.entry\` names \`ui/${control.entry}\`, which does not exist`,
        )
        return
      }
      if (control.statusPath !== undefined) {
        if (typeof control.statusPath !== 'string' || !STATUS_PATH.test(control.statusPath)) {
          report.error(
            'contributes_session_control_invalid',
            `${at}.statusPath`,
            `\`${at}.statusPath\` must be a bare path inside the app's own backend — no scheme, host or query`,
          )
          return
        }
      }
      seen.add(control.id)
      const entry = { id: control.id, entry: control.entry }
      if (typeof control.label === 'string' && control.label) entry.label = control.label
      if (typeof control.icon === 'string' && control.icon) entry.icon = control.icon
      if (control.statusPath) entry.statusPath = control.statusPath
      out.sessionControls.push(entry)
    })
  }

  if (out.commands.length > 0 || out.sessionControls.length > 0) {
    report.warn(
      'contributes_not_rendered',
      'contributes',
      'contributions are validated and published on `GET /api/apps`, but the Studio shell does not render them yet',
    )
  }
  return out
}

function validatePlatform(raw, report, osName) {
  const out = { os: ['macos', 'linux', 'windows'] }
  if (raw === undefined) return out
  if (!report.expectObject(raw, 'platform')) return out
  for (const key of Object.keys(raw)) {
    if (key !== 'os') report.warn('unknown_field', `platform.${key}`, `unknown field \`platform.${key}\` — ignored`)
  }
  if (report.expectArray(raw.os, 'platform.os')) {
    const list = []
    raw.os.forEach((entry, index) => {
      if (!OS_NAMES.has(entry)) {
        report.error(
          'platform_os_invalid',
          `platform.os[${index}]`,
          `\`platform.os[${index}]\` must be one of ${[...OS_NAMES].join(', ')}`,
        )
        return
      }
      if (!list.includes(entry)) list.push(entry)
    })
    if (list.length === 0) {
      report.error('platform_os_invalid', 'platform.os', '`platform.os` must list at least one platform')
    } else {
      out.os = list
    }
  }
  if (!out.os.includes(osName)) {
    // A warning, not a refusal: a manifest is not a better judge of the machine
    // than the machine is, and hiding the app would leave no way to say why.
    report.warn(
      'platform_mismatch',
      'platform.os',
      `this host runs on ${osName}, which the app does not list — it may not work`,
    )
  }
  return out
}

/**
 * Validate and normalize one parsed ``app.json``.
 *
 * @param {unknown} raw       the parsed manifest
 * @param {object}  [options]
 * @param {string}  [options.appDir]  the app's directory; when given, declared
 *   entries are checked for existence, which is what turns "the manifest names
 *   a backend" into "the backend is there"
 * @param {string}  [options.osName]  platform spelling to check against
 * @returns {{ok: boolean, errors: object[], warnings: object[], manifest: object|null}}
 *   ``manifest`` is the normalized form with defaults applied, or null when the
 *   manifest was refused.
 */
export function validateManifest(raw, { appDir, osName = currentOsName() } = {}) {
  const report = createReport()

  if (!isPlainObject(raw)) {
    report.error('manifest_not_object', '', 'app.json must contain a JSON object')
    return { ok: false, errors: report.errors, warnings: report.warnings, manifest: null }
  }

  for (const key of Object.keys(raw)) {
    if (TOP_LEVEL_FIELDS.has(key)) continue
    const hint = LEGACY_FIELDS.get(key)
    if (hint) report.warn('legacy_field', key, `\`${key}\` is not part of v1 — ${hint}`)
    else report.warn('unknown_field', key, `unknown field \`${key}\` — ignored`)
  }

  if (raw.schemaVersion === undefined) {
    report.error(
      'schema_version_missing',
      'schemaVersion',
      `\`schemaVersion\` is required (this host implements ${APP_SCHEMA_VERSION})`,
    )
  } else if (raw.schemaVersion !== APP_SCHEMA_VERSION) {
    report.error(
      'schema_version_unsupported',
      'schemaVersion',
      `\`schemaVersion\` ${JSON.stringify(raw.schemaVersion)} is not implemented by this host (expected ${APP_SCHEMA_VERSION})`,
    )
  }

  if (typeof raw.name !== 'string' || raw.name === '') {
    report.error('name_missing', 'name', '`name` is required')
  } else if (!APP_NAME_PATTERN.test(raw.name) || raw.name.length > 64) {
    report.error('name_invalid', 'name', '`name` must be kebab-case (`[a-z0-9]` segments joined by `-`), at most 64 chars')
  } else if (RESERVED_APP_NAMES.has(raw.name)) {
    report.error('name_reserved', 'name', `\`${raw.name}\` is a name the host's own routes answer`)
  }

  if (typeof raw.version !== 'string' || !SEMVER.test(raw.version)) {
    report.error('version_invalid', 'version', '`version` must be a semver string, e.g. `1.0.0`')
  }

  if (typeof raw.displayName !== 'string' || raw.displayName === '') {
    report.error('display_name_missing', 'displayName', '`displayName` is required')
  }

  if (raw.description !== undefined && typeof raw.description !== 'string') {
    report.error('field_type', 'description', '`description` must be a string')
  }

  const tags = []
  if (report.expectArray(raw.tags, 'tags')) {
    raw.tags.forEach((tag, index) => {
      if (typeof tag !== 'string' || !KEBAB.test(tag)) {
        report.error('field_type', `tags[${index}]`, `\`tags[${index}]\` must be a kebab-case string`)
        return
      }
      if (!tags.includes(tag)) tags.push(tag)
    })
  }

  const ui = validateUi(raw.ui, report, appDir)
  const backend = validateBackend(raw.backend, report, appDir)
  const capabilities = validateCapabilities(raw.capabilities, report)
  const contributes = validateContributes(raw.contributes, report, appDir)
  const platform = validatePlatform(raw.platform, report, osName)

  if (ui?.entry === undefined && backend === undefined) {
    report.warn(
      'no_ui_no_backend',
      '',
      'the app declares neither `ui.entry` nor `backend` — there is nothing for the host to run',
    )
  }
  if (backend === undefined && capabilities.http.inbound && raw.capabilities?.http?.inbound === true) {
    report.warn(
      'inbound_without_backend',
      'capabilities.http.inbound',
      '`capabilities.http.inbound` is declared but there is no `backend` to receive the requests',
    )
  }
  for (const event of capabilities.events) {
    if (typeof raw.name === 'string' && !event.startsWith(`${raw.name}:`)) {
      report.warn(
        'capability_event_namespace',
        'capabilities.events',
        `event \`${event}\` is outside this app's \`${raw.name}:\` namespace — the host may refuse the subscription`,
      )
    }
  }
  if (capabilities.events.length > 0) {
    // The one declaration whose enforcement is not this package's to make: the
    // allow-list only binds when the embedding shell passes it to
    // `createAppSdk({allowedEvents})`. Saying so is the difference between a
    // contract and a hope.
    report.warn(
      'capability_events_shell_dependent',
      'capabilities.events',
      'the event allow-list binds only when the embedding shell passes it to `createAppSdk({allowedEvents})` — ' +
        'a shell that does not will deliver any event name',
    )
  }

  if (report.errors.length > 0) {
    return { ok: false, errors: report.errors, warnings: report.warnings, manifest: null }
  }

  const manifest = {
    schemaVersion: APP_SCHEMA_VERSION,
    name: raw.name,
    version: raw.version,
    displayName: raw.displayName,
    description: typeof raw.description === 'string' ? raw.description : '',
    defaultEnabled: report.expectBoolean(raw.defaultEnabled, 'defaultEnabled', false),
    capabilities,
    contributes,
    platform,
  }
  if (typeof raw.author === 'string' && raw.author) manifest.author = raw.author
  if (typeof raw.license === 'string' && raw.license) manifest.license = raw.license
  if (tags.length > 0) manifest.tags = tags
  if (ui !== undefined) manifest.ui = ui
  if (backend !== undefined) manifest.backend = backend

  return { ok: true, errors: report.errors, warnings: report.warnings, manifest }
}

/** One-line rendering of a finding, for the host log. */
export function formatFinding(finding) {
  return finding.path ? `${finding.path}: ${finding.message}` : finding.message
}

/** Absolute path to an app's declared backend script, or null when it has none. */
export function backendScriptPath(appDir, manifest) {
  if (!manifest?.backend?.entry) return null
  const script = resolve(join(appDir, manifest.backend.entry))
  return existsSync(script) ? script : null
}
