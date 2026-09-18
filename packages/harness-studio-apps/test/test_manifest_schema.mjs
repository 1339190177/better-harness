/**
 * Contract test for the app manifest: `schema/app.schema.json` and
 * `lib/manifest.mjs` are two statements of the same thing, so this pins both.
 *
 * What it holds:
 *   - every app shipped under `apps/` validates clean against the runtime
 *     validator, with its declared entries actually on disk,
 *   - each refusal has a stable `code`, so the host log, the tests and any
 *     future UI match on the code rather than on prose,
 *   - the JSON Schema's own property list and the validator's agree — a field
 *     added to one and forgotten in the other fails here rather than in an
 *     app author's editor,
 *   - the normalized output carries the defaults the host reads.
 *
 * Run: node test/test_manifest_schema.mjs
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  APP_SCHEMA_VERSION,
  FORBIDDEN_FORWARD_HEADERS,
  validateManifest,
} from '../lib/manifest.mjs'
import { loadApps } from '../lib/manifests.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const schema = JSON.parse(readFileSync(join(root, 'schema', 'app.schema.json'), 'utf-8'))

let failures = 0
function check(label, cond, detail = '') {
  if (cond) console.log(`  ok    ${label}`)
  else {
    failures += 1
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

/** A manifest that validates clean, as the base for the refusal cases. */
function validManifest(overrides = {}) {
  return {
    schemaVersion: APP_SCHEMA_VERSION,
    name: 'demo-app',
    version: '1.0.0',
    displayName: 'Demo',
    ...overrides,
  }
}

function codesOf(result) {
  return result.errors.map((error) => error.code)
}

// ---------------------------------------------------------------------------
// The apps this package ships
// ---------------------------------------------------------------------------

console.log('shipped apps')
const appsDir = join(root, 'apps')
const shipped = readdirSync(appsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
  .map((entry) => entry.name)
check('apps/ has at least one app', shipped.length > 0, `found ${shipped.length}`)

for (const name of shipped) {
  const dir = join(appsDir, name)
  const raw = JSON.parse(readFileSync(join(dir, 'app.json'), 'utf-8'))
  // `appDir` is what turns "the manifest names a backend" into "the backend is
  // there": every declared entry is checked for existence.
  const result = validateManifest(raw, { appDir: dir })
  check(
    `apps/${name}/app.json validates`,
    result.ok,
    result.errors.map((error) => `${error.path}: ${error.message}`).join('; '),
  )
  check(
    `apps/${name}/app.json has no warnings`,
    result.warnings.length === 0,
    result.warnings.map((warning) => `${warning.path}: ${warning.message}`).join('; '),
  )
}

// Discovery must reach the same verdict the validator does.
const silent = { info() {}, warn() {}, error() {} }
const loaded = loadApps(appsDir, { logger: silent })
check('loadApps loads every shipped app', loaded.size === shipped.length, `${loaded.size}/${shipped.length}`)
const fileExplorer = loaded.get('file-explorer')
check('loadApps binds the manifest-declared backend', fileExplorer?.backendScript?.endsWith('server.mjs') === true)

// ---------------------------------------------------------------------------
// Refusals — one case per error code the host acts on
// ---------------------------------------------------------------------------

console.log('\nrefusals')
const cases = [
  ['not an object', 'not a manifest', {}, 'manifest_not_object'],
  ['missing schemaVersion', { name: 'a-b', version: '1.0.0', displayName: 'A' }, {}, 'schema_version_missing'],
  ['future schemaVersion', validManifest({ schemaVersion: 99 }), {}, 'schema_version_unsupported'],
  ['name not kebab-case', validManifest({ name: 'Demo_App' }), {}, 'name_invalid'],
  ['name the host owns', validManifest({ name: 'registry' }), {}, 'name_reserved'],
  ['non-semver version', validManifest({ version: 'v1' }), {}, 'version_invalid'],
  ['missing displayName', validManifest({ displayName: '' }), {}, 'display_name_missing'],

  ['ui.entry escaping the app', validManifest({ ui: { entry: '../secret.mjs' } }), {}, 'ui_entry_invalid'],
  ['ui.entry that is not ESM', validManifest({ ui: { entry: 'index.html' } }), {}, 'ui_entry_invalid'],
  [
    'ui.pages without ui.entry',
    validManifest({ ui: { pages: [{ route: '/demo', label: 'Demo' }] } }),
    {},
    'ui_pages_without_entry',
  ],
  [
    'a page routed at the root',
    validManifest({ ui: { entry: 'e.mjs', pages: [{ route: '/', label: 'Demo' }] } }),
    {},
    'ui_page_route_root',
  ],
  [
    'two pages on one route',
    validManifest({
      ui: {
        entry: 'e.mjs',
        pages: [
          { route: '/demo', label: 'A' },
          { route: '/demo', label: 'B' },
        ],
      },
    }),
    {},
    'ui_page_route_duplicate',
  ],

  ['backend without an entry', validManifest({ backend: { kind: 'node' } }), {}, 'backend_entry_missing'],
  ['backend of an unknown kind', validManifest({ backend: { kind: 'python', entry: 's.mjs' } }), {}, 'backend_kind_unsupported'],
  [
    'backend.entry escaping the app',
    validManifest({ backend: { entry: '../../etc/passwd.mjs' } }),
    {},
    'backend_entry_invalid',
  ],
  [
    'backend.maxBodyBytes out of range',
    validManifest({ backend: { entry: 's.mjs', maxBodyBytes: -1 } }),
    {},
    'number_range',
  ],
  [
    'an unknown restart policy',
    validManifest({ backend: { entry: 's.mjs', restart: { policy: 'sometimes' } } }),
    {},
    'backend_restart_policy_invalid',
  ],

  [
    'an event name outside <scope>:<name>',
    validManifest({ capabilities: { events: ['Whatever'] } }),
    {},
    'capability_event_invalid',
  ],
  [
    'more session controls than the cap',
    validManifest({
      contributes: {
        sessionControls: [
          { id: 'a', entry: 'a.mjs' },
          { id: 'b', entry: 'b.mjs' },
          { id: 'c', entry: 'c.mjs' },
        ],
      },
    }),
    {},
    'contributes_session_controls_cap',
  ],
  [
    'a statusPath that is really a URL',
    validManifest({
      contributes: { sessionControls: [{ id: 'a', entry: 'a.mjs', statusPath: 'https://evil.example/x' }] },
    }),
    {},
    'contributes_session_control_invalid',
  ],
  [
    'a command missing its prompt',
    validManifest({ contributes: { commands: [{ id: 'go', title: 'Go' }] } }),
    {},
    'contributes_command_invalid',
  ],
  [
    'a malformed array instead of an empty one',
    validManifest({ capabilities: { events: 'files:changed' } }),
    {},
    'field_type',
  ],
  ['an unknown platform', validManifest({ platform: { os: ['beos'] } }), {}, 'platform_os_invalid'],
]

for (const [label, raw, options, expected] of cases) {
  const result = validateManifest(raw, options)
  check(
    `refuses ${label} (${expected})`,
    !result.ok && codesOf(result).includes(expected),
    result.ok ? 'accepted' : `got ${codesOf(result).join(', ')}`,
  )
}

// Every forbidden header is refused by the same code, so the proxy never has to
// decide: a manifest cannot ask for the host's own credentials.
for (const header of FORBIDDEN_FORWARD_HEADERS) {
  const result = validateManifest(validManifest({ capabilities: { forwardHeaders: [header] } }))
  check(
    `refuses forwardHeaders: ${header}`,
    !result.ok && codesOf(result).includes('forward_header_forbidden'),
    result.ok ? 'accepted' : codesOf(result).join(', '),
  )
}

// A declared entry that is not on disk is the "manifest lies about its backend"
// case, and it is an error rather than a shrug.
const missingBackend = validateManifest(validManifest({ backend: { entry: 'nope.mjs' } }), { appDir: root })
check(
  'refuses a backend entry that is not on disk (backend_entry_missing_file)',
  !missingBackend.ok && codesOf(missingBackend).includes('backend_entry_missing_file'),
  codesOf(missingBackend).join(', '),
)

// ---------------------------------------------------------------------------
// Warnings — the app loads, but the author is told
// ---------------------------------------------------------------------------

console.log('\nwarnings')
function warnCodes(raw, options = {}) {
  return validateManifest(raw, options).warnings.map((warning) => warning.code)
}

check(
  'a typo in a top-level field warns (unknown_field)',
  warnCodes(validManifest({ dispalyName: 'oops' })).includes('unknown_field'),
)
check(
  'an upstream-only field warns with a migration hint (legacy_field)',
  warnCodes(validManifest({ permissions: { api: ['/x'] } })).includes('legacy_field'),
)
check(
  'an unenforceable capability warns (capability_not_enforceable)',
  warnCodes(validManifest({ capabilities: { storage: 'shared' } })).includes('capability_not_enforceable'),
)
check(
  'an entry with no pages is accepted without a warning',
  warnCodes(validManifest({ ui: { entry: 'e.mjs' }, backend: { entry: 's.mjs' } })).length === 0,
  warnCodes(validManifest({ ui: { entry: 'e.mjs' }, backend: { entry: 's.mjs' } })).join(', '),
)
check(
  'an app with nothing to run warns (no_ui_no_backend)',
  warnCodes(validManifest()).includes('no_ui_no_backend'),
)
check(
  'an event outside the app namespace warns (capability_event_namespace)',
  warnCodes(validManifest({ capabilities: { events: ['other-app:ping'] } })).includes('capability_event_namespace'),
)
check(
  'declaring events says who has to enforce them (capability_events_shell_dependent)',
  warnCodes(validManifest({ capabilities: { events: ['demo-app:ping'] } })).includes(
    'capability_events_shell_dependent',
  ),
)
check(
  'a platform this host is not warns (platform_mismatch)',
  warnCodes(validManifest({ platform: { os: ['windows'] } }), { osName: 'linux' }).includes('platform_mismatch'),
)
check(
  'a contribution the shell cannot render yet warns (contributes_not_rendered)',
  warnCodes(
    validManifest({ contributes: { commands: [{ id: 'go', title: 'Go', prompt: 'do it' }] } }),
  ).includes('contributes_not_rendered'),
)

// ---------------------------------------------------------------------------
// Normalization — the host reads one shape
// ---------------------------------------------------------------------------

console.log('\nnormalization')
const normalized = validateManifest(validManifest({ backend: { entry: 'server.mjs' } })).manifest
check('backend.kind defaults to node', normalized.backend.kind === 'node')
check('backend.healthCheck defaults to /health', normalized.backend.healthCheck === '/health')
check('backend.maxBodyBytes defaults to 1 MiB', normalized.backend.maxBodyBytes === 1024 * 1024)
check('backend.startupTimeoutMs defaults to 10s', normalized.backend.startupTimeoutMs === 10_000)
check('backend.restart defaults to on-failure', normalized.backend.restart.policy === 'on-failure')
check('capabilities.http.inbound defaults to true', normalized.capabilities.http.inbound === true)
check('capabilities.forwardHeaders defaults to empty', normalized.capabilities.forwardHeaders.length === 0)
check('defaultEnabled defaults to false', normalized.defaultEnabled === false)
check('contributes is always present', Array.isArray(normalized.contributes.commands))

const dropped = validateManifest(validManifest({ iconUrl: '/app-assets/x.svg' })).manifest
check('an unknown field is dropped from the normalized manifest', dropped.iconUrl === undefined)

// ---------------------------------------------------------------------------
// The JSON Schema and the validator describe the same fields
// ---------------------------------------------------------------------------

console.log('\nschema/validator agreement')
const schemaTopLevel = new Set(Object.keys(schema.properties))
// `$schema` is an editor affordance the validator also tolerates.
const validatorTopLevel = new Set([
  '$schema', 'schemaVersion', 'name', 'version', 'displayName', 'description',
  'author', 'license', 'tags', 'defaultEnabled',
  'ui', 'backend', 'capabilities', 'contributes', 'platform',
])
const onlyInSchema = [...schemaTopLevel].filter((key) => !validatorTopLevel.has(key))
const onlyInValidator = [...validatorTopLevel].filter((key) => !schemaTopLevel.has(key))
check('no field is in the JSON Schema alone', onlyInSchema.length === 0, onlyInSchema.join(', '))
check('no field is in the validator alone', onlyInValidator.length === 0, onlyInValidator.join(', '))
check('the JSON Schema pins the same version', schema.properties.schemaVersion.const === APP_SCHEMA_VERSION)
check(
  'the JSON Schema caps session controls at the same number',
  schema.properties.contributes.properties.sessionControls.maxItems === 2,
)
check(
  'capabilities list the same keys in both',
  ['http', 'events', 'forwardHeaders'].every((key) => key in schema.properties.capabilities.properties) &&
    Object.keys(schema.properties.capabilities.properties).length === 3,
  Object.keys(schema.properties.capabilities.properties).join(', '),
)

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
