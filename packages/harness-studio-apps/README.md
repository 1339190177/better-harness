# @qoder-ai/harness-studio-apps

Run **apps as first-class units** on a Node host: stdlib-only app backends
behind an HMAC-signed reverse proxy, a declarative host surface (`/api/apps`
records, manifests, enable/disable, config), and a minimal app-UI contract —
so a feature can ship as a self-contained app instead of a route inside a
monolith.

Extracted from the KiroCrew Node compat host (`packages/kirocrew-node` in the
Kiro Crew repository) after that mechanism was proven end-to-end against the
official app suite. The intent here is to carry Harness Studio features as
apps on the same mechanism; the `apps/` tree below keeps `file-explorer` as
the reference port of an official KiroCrew app backend.

## How it fits together

Three layers, all in this package:

| Layer | What it is | Where |
|---|---|---|
| **Host** | one Node process: app discovery, enablement state, backend lifecycle, proxy, static app assets | `server.mjs` + `lib/` |
| **App backend** | a stdlib-only HTTP server per app — a sibling `server.mjs` is the whole contract | `apps/<name>/server.mjs` |
| **App UI** | a plain-ESM entry per app — a default export `mount(container, sdk)` | `apps/<name>/ui/entry.mjs` |

The host discovers an app's backend by file presence: `apps/<name>/server.mjs`
next to `app.json`. Writing that file is the whole backend contract — no
manifest edit, no registry. The same holds for `ui/entry.mjs` and the UI.

An app may also carry its own content next to the code (`inject/` overlays,
`skills/` bundles); a lookup resolves the copy that ships with the app before
any source tree, so the package runs whole with no Kiro Crew checkout or
install present.

## Run

```bash
node server.mjs                            # http://127.0.0.1:8799
node server.mjs --port 8899 --enable file-explorer
node server.mjs --app file-explorer        # pin: / opens the app's page
```

Input resolution (first hit wins):

| Input | Flags | Env | Default |
|---|---|---|---|
| Dashboard dist (**optional**) | `--dist` | `KIROCREW_DIST_DIR` | `public/dist/`, a build output, or an installed Kiro Crew app |
| App manifests | `--apps` | `KIROCREW_NODE_APPS_DIR` | this package's `apps/` |
| Host state | `--state-dir` | `KIROCREW_NODE_STATE_DIR` | `.state/state.json` |
| App data home | `--home` | `KIROCREW_HOME` | `~/.kiro/crew` |
| Port / bind | `--port` `--host` | `PORT` `HOST` | `8799` / `127.0.0.1` |
| Boot enables | `--enable a,b` | `KIROCREW_NODE_ENABLE` | none (apps ship off) |
| Pinned app | `--app <name>` | `KIROCREW_NODE_APP` | none |

No dist is a supported state: the app surface (`/apps/<name>/api/*`,
`/apps/<name>/ui/*`, `/api/apps*`) is whole without one, and only the SPA
shell routes 404. The data home supplies installed-app records
(`<home>/apps/<name>/installed.json`) and each app's data directory
(`<home>/apps/<name>/data`).

## Request flow

```
GET  /                       302 -> the pinned app's page, else the app library
GET  /apps/<name>/ui/<entry> static: app UI ESM bundles (extension allow-list,
                              CSP sandbox, no-cache)
*    /apps/<name>/api/*       proxy: HMAC-signed forward to the app's backend
                              process, headers default-denied and the body
                              capped (403 disabled / 413 too large /
                              502 unreachable)
*    /api/apps/<name>/*       hooks tier: same forward for a backend that
                              answers under the in-gateway namespace
*    /api/apps...             apps tier: records, manifests, enable/disable,
                              config read/write; a reserved-but-unimplemented
                              segment answers 501
*    /api/*                   shell tier: shaped stubs ({} / [] / {ok:true})
GET  /api/ws                  minimal WebSocket accept
GET  /assets/* <anything>     static: the dist when one is configured, SPA
                              fallback for extensionless paths
```

## App manifest (`app.json`)

`schema/app.schema.json` is the contract; `lib/manifest.mjs` enforces it at
load time. **Every field in the schema is a field the host reads** — a manifest
that declares a backend the host will not spawn, or a permission nothing
checks, is worse than one that declares nothing, because it reads as a promise.

```jsonc
{
  "$schema": "../../schema/app.schema.json",
  "schemaVersion": 1,
  "name": "my-app",                       // kebab-case; host route names reserved
  "version": "1.0.0",                     // semver
  "displayName": "My App",
  "description": "...",
  "defaultEnabled": false,

  "ui": {
    "entry": "entry.mjs",                 // relative to ui/; must exist
    "export": "default",                  // the mount(container, sdk) export
    "pages": [{ "route": "/my-app", "label": "My App", "icon": "Folder" }]
  },

  "backend": {                            // omit for a UI-only app
    "kind": "node",
    "entry": "server.mjs",                // relative to the app root; must exist
    "healthCheck": "/health",
    "maxBodyBytes": 1048576,              // proxied bodies past this answer 413
    "startupTimeoutMs": 10000,
    "restart": { "policy": "on-failure", "maxRetries": 3, "backoffMs": 1000 }
  },

  "capabilities": {
    "http": { "inbound": true },          // false ⇒ the proxy answers 403
    "events": ["my-app:changed"],         // the app's event vocabulary
    "forwardHeaders": []                  // default-deny; see below
  },

  "contributes": { "commands": [], "sessionControls": [] },
  "platform": { "os": ["macos", "linux", "windows"] }
}
```

Three properties worth stating outright:

- **The backend is declared, not discovered.** `backend.entry` names the script;
  validation refuses a manifest pointing at a file that is not there. Discovery
  by file presence let the manifest and the process that actually runs
  disagree.
- **Headers are default-denied.** Only `content-type`, `accept`,
  `accept-language` and the names in `capabilities.forwardHeaders` cross the
  proxy hop. `cookie`, `authorization`, `proxy-authorization`, `set-cookie` and
  the proxy signature header are refused at validation time and can never be
  asked for: a backend is a separate process running third-party code that
  already has its own identity on the hop, so handing it the browser's session
  credential is the bypass the HMAC exists to prevent.
- **Capabilities are short because they are enforced.** Anything this host
  cannot actually withhold from a child process — outbound network, filesystem
  reach — is deliberately absent rather than declared and unpoliced. Every app
  gets `<home>/apps/<name>/data` with no declaration needed. Those fields come
  back when there is a sandbox behind them.

Validation splits two ways. **Errors** mean the app does not load and the
reason is logged with the field that caused it. **Warnings** mean it loads but
something declared will not do what its author expects — an unknown key
(typo), an upstream-only field with a migration hint, a platform this host is
not, a contribution the shell does not render yet. Nothing is dropped quietly:
a malformed array is a warning naming the path, never a silent `[]`.

```js
import { validateManifest } from '@qoder-ai/harness-studio-apps/manifest'

const { ok, errors, warnings, manifest } = validateManifest(raw, { appDir })
// `manifest` is the normalized form (defaults applied, unknown fields dropped)
// — the shape `GET /api/apps` publishes and the host reads everywhere.
```

## App backend contract

`lib/appServer.mjs` carries everything a backend shares — the HMAC gate, the
route table, JSON helpers, atomic writes, the data dir. A backend declares its
routes and handlers, nothing else:

```js
import { createAppServer, sendJson } from '../../lib/appServer.mjs'

const ROUTES = [
  ['GET', ['things'], (req, res) => sendJson(res, 200, { things: [] })],
  ['POST', ['things', ':id', 'run'], handleRun],   // :param and trailing :rest*
]

createAppServer({ appName: 'my-app', routes: ROUTES })
```

- Handler signature: `(req, res, { params, query, raw })`; `query` is a
  `URLSearchParams`, `raw` the buffered body (the HMAC covers those bytes, so
  body reads flow through it).
- Routing mirrors aiohttp: matched on the raw path (`..`/`.` never resolve), a
  known path with the wrong method answers **405**, an undeclared path
  **404**.
- `GET /health` is the only unsigned route (the host's liveness probe);
  everything else requires `X-KiroCrew-Proxy`. The proxy secret arrives in
  `KIROCREW_PROXY_SECRET`; env also carries `PORT`, `HOST`,
  `KIROCREW_APP_NAME`, `KIROCREW_HOME`.
- Helpers: `sendJson`, `badRequest(res, error, code)`, `readJsonObject(raw)`,
  `atomicWrite(path, data)`, `readJsonFile(path, fallback)`, `crewHome()`,
  `appDataDir(appName)`.
- Errors carry both prose and a machine-readable code:
  `{ "error": "...", "code": "..." }`.

## App UI contract

An app declares its UI entry in `app.json` and ships it as one plain-ESM file:

```json
"ui": { "entry": "entry.mjs", "pages": [{ "route": "/my-app", "label": "My App" }] }
```

```js
// apps/my-app/ui/entry.mjs
export default function mount(container, sdk) {
  const el = document.createElement('div')
  el.textContent = 'hello'
  container.replaceChildren(el)
  sdk.api.get('things').then((data) => { /* ... */ })
  return () => container.replaceChildren()   // optional teardown
}
```

The host or embedding shell owns the page and builds the `sdk` with
`createAppSdk` from `client.mjs` (exported as
`@qoder-ai/harness-studio-apps/client`):

```js
import { createAppSdk } from '@qoder-ai/harness-studio-apps/client'

const { default: mount } = await import(`/apps/${name}/ui/${entry}`)
const sdk = createAppSdk({ name, theme: { mode: 'dark' } })
sdk.events.emit('greeting', { text: 'hi from the host' })
const teardown = mount(container, sdk)
```

- `sdk.api` — `get/del/post/put/patch/request` bound to
  `/apps/<name>/api/*`; JSON responses parse, empty ones resolve
  `undefined`, failures reject with `AppApiError` (`status`, unparsed `body`).
- `sdk.events` — the shared event bus; `on(name, fn)` returns its own
  unsubscribe. The host owns the `"props"` event; every other name is yours
  to name, and a host that forwards one listens on the same bus.
- `sdk.props` — host-supplied context for this mount (a record list, a
  selection). Read it at mount; the host keeps it current by replacing
  `sdk.props` and emitting `"props"` with the next object.
- `sdk.theme` — `{ mode: 'light' | 'dark' }`; the host also mirrors it as
  `data-hs-theme` on the container so CSS can react without JS.
- `sdk.contract` — `APP_CONTRACT_VERSION` (currently `1`).
- The UI bundle is served with `CSP: default-src 'none'; sandbox` and a strict
  extension allow-list; styles travel inside the entry.

`apps/file-explorer/ui/entry.mjs` is the reference implementation of this
contract (tree browsing + file preview against the file-explorer backend).

## Layout

```
schema/app.schema.json     the app.json contract (editor-facing)
lib/manifest.mjs           the same contract, enforced: validate + normalize
server.mjs                 entry: route dispatch (app api -> /api -> static)
client.mjs                 app-UI contract: SDK, API client, event bus
lib/config.mjs             flag/env/default input resolution
lib/manifests.mjs          discovery: apps/<name>/app.json + installed records
lib/state.mjs              .state/state.json: enabledApps + per-app secrets
lib/backends.mjs           spawn / port allocation / health poll / restart / stop
lib/proxyAuth.mjs          HMAC sign + verify (host and backend sides)
lib/proxy.mjs              reverse proxy: enablement gate, header + body policy
lib/hostApi.mjs            /api/apps tier (records, manifest, config, ...)
lib/static.mjs             dist serving + app UI bundles + SPA fallback
lib/appServer.mjs          shared app-backend scaffolding
lib/redact.mjs             credential redaction for served content
lib/ws.mjs                 minimal WebSocket accept
apps/<name>/app.json       the manifest (see the contract above)
apps/<name>/server.mjs     app backend, named by backend.entry
apps/<name>/ui/entry.mjs   app UI entry, named by ui.entry (plain ESM)
test/fixtures/echo-app/    fixture app for the host-policy test
test/test_<name>.mjs       smoke tests (ALL PASS)
```

## Tests

Each test is standalone and prints `ALL PASS`:

```bash
node test/run-all.mjs              # everything, serially
npm test                           # same, via the package script
```

| Test | What it pins |
|---|---|
| `test_manifest_schema.mjs` | every shipped `app.json` validates clean; one case per refusal code; the JSON Schema and the validator describe the same fields |
| `test_host_policy.mjs` | the manifest fields the host must ACT on, observed end to end: `forwardHeaders` default-deny, `maxBodyBytes` → 413, `restart` → the backend comes back, `defaultEnabled` → on at boot, a reserved core route → 501 |
| `test_file_explorer.mjs` | the reference app's backend behind the HMAC gate |

## Apps in this tree

| App | Surface |
|---|---|
| `file-explorer` | read-only FS API (`resolve` `tree` `read` `search` `git-status` `complete`) plus its UI entry |
| `file-viewer` | UI-only: an artifact tree the host feeds through `props` |

## Boundaries

What this host does not do, stated so no manifest field implies otherwise:

- **No install/uninstall, registry browsing, or approval flows.** The core
  route segments reserved for them (`uninstall`, `update`, `dev`, `token`,
  `_jobs`, `migrate-cleanup`) answer **501** rather than a fake `200 {}`.
- **No sandbox.** A backend is an ordinary child process: it can reach the
  network and the filesystem regardless of its manifest. That is why
  `capabilities` has no field claiming otherwise.
- **`capabilities.events` binds only when the embedding shell passes it** to
  `createAppSdk({ allowedEvents })`. The validator warns whenever an app
  declares events, so the gap is never silent.
- **`contributes` is validated and published, not rendered.** The Studio shell
  has no command palette or composer slot for it yet; declaring one warns.
- The shell tier (`/api/chat/*`, sessions, crons, artifacts, ...) answers
  shaped stubs — a leftover of this package's origin as a compat host, and dead
  weight when Studio is the embedder (it proxies only `/apps/*` and
  `/api/apps*`).
- Env vars, the proxy header and the data home still carry the upstream
  `KIROCREW_*` / `~/.kiro/crew` spelling; renaming them is a separate change.
- A dist-less host serves the app surface only — there is no dashboard shell.
