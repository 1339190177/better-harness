# Studio Components: host component UIs inside Studio

## Traceability

- Spec ID: 2026-09-18-studio-app-host
- Status: Implemented

## Intent

`packages/harness-studio-apps` carries the app mechanism (host, stdlib-only
app backends, a minimal app-UI contract) with the app surface proven against
its own smoke suite. Studio is the shell those components should run in: this
spec connects the two so an app's `ui/entry.mjs` mounts inside Studio and its
API calls flow through Studio's origin.

The surface is named **Components** in the Studio UI (the mechanism package,
paths and CLI flags keep the `apps` names; renaming the wire protocol is a
separate decision). Studio stays the only page: it reverses the component
surfaces (`/apps/*`, `/api/apps*`) to a running apps host, injects the SDK
defined by the package's `client.mjs`, and the desktop shell starts the host
by itself so the surface needs no manual wiring.

The first migration exercise proves the direction: the Artifacts file tree —
an existing Studio surface — is rendered by a hosted component
(`apps/file-viewer`) whose data arrives through `sdk.props`.

## Acceptance scenarios

- AC1 — `harness-studio --apps-host <url>` accepts an http(s) base URL; the
  CLI refuses anything else, and `/api/config` reports `appsHostEnabled` so
  the sidebar can describe the surface before it is opened.
- AC2 — Studio reverses `GET|POST|PUT|PATCH|DELETE /apps/*` and `/api/apps*`
  to the configured apps host, passing status, bodies and headers through
  (including the UI bundle's CSP); a non-GET request without a same-origin
  origin header answers 403; without `--apps-host` the paths answer 404
  `apps_host_not_configured`; an unreachable host answers 502
  `apps_host_unreachable`. Every other Studio path is untouched.
- AC3 — The Components workbench lists the host's records (display name,
  enabled, backend availability, whether the manifest declares `ui.entry`),
  toggles enable/disable through the host lifecycle endpoints, and mounts the
  selected component's UI entry in a pane.
- AC4 — A mounted entry receives the `createAppSdk` object (`name`, `api`,
  `events`, `theme.mode`, `props`); the container carries `data-hs-theme`; a
  theme switch updates the SDK's mode and the attribute without remounting;
  a new props reference is pushed as the `"props"` event (and replaces
  `sdk.props`) without remounting; the entry's teardown runs when the pane
  unmounts or the selection changes.
- AC5 — Degraded states stay legible: a component without `ui.entry`, a
  disabled component, an unreachable apps host and a failing entry each
  render an explained state instead of a blank pane.
- AC6 — The desktop shell starts the apps host on launch (inside its userData
  directory, reusing a host that is already running) and passes its URL to
  the Studio server; a host that cannot start leaves Studio functional with
  the explained surface.
- AC7 — The Artifacts file tree is hosted: when an apps host is configured,
  the `file-viewer` component renders the tree from host props (`artifacts`,
  `scope`, `labels`), a click returns a parsed `select` event that drives the
  existing scope/preview machinery, and the built-in navigator stays the
  fallback when no host is configured or the component cannot load.
- AC8 — Evidence: vitest suites cover the proxy contract, the shell model and
  the desktop host launcher; a browser pass mounts file-explorer inside the
  Components workbench and the file-viewer tree inside Artifacts, with no
  console errors.

## Non-goals

- No rename of the mechanism package, `/apps/` paths, `--apps-host` flag or
  the wire protocol; only the Studio UI adopts the Components naming.
- No installation, uninstall, or registry surfaces; the workbench reads the
  host's records and toggles enablement only.
- No full migration of the Artifacts viewers: only the file tree is hosted
  in this slice; previews keep their built-in surfaces.
- No change to `client.mjs` semantics beyond the additive `props` channel:
  the contract version stays 1.

## Plan

1. Give `@qoder-ai/harness-studio-apps` a `client.d.ts`, a typed `./client`
   export and a `./server` export for programmatic launching; add the
   additive `props` channel to `client.mjs`.
2. Add `src/server/apps-host.ts`: path admission, upstream forwarding, the
   same-origin gate for writes, and the explained 404/502 answers; wire it
   into `server.ts`, the server options and `--apps-host`.
3. Add the `components` Studio area: shell-model row, sidebar destination,
   the `ComponentsWorkspace` (records list, lifecycle actions, SDK-injected
   host pane), the shared `HostedComponent` mounter and the stylesheet.
4. Desktop: `src/apps-host.mjs` starts/reuses the host from `main.mjs` and
   the URL travels to `startHarnessStudioServer` through the service
   contract; package the host via `asarUnpack`.
5. Add `apps/file-viewer` (manifest + entry, no backend) and host the
   Artifacts file tree with it, keeping the built-in navigator as fallback.
6. Cover proxy, shell model and host launcher with vitest/node tests; verify
   both mounted surfaces in a browser against a live apps host.

## Evidence

- `npx vitest run test/apps-host-proxy.test.ts test/studio-shell-model.test.ts`
  — proxy passthrough/404/502/cross-origin and the destination rows pass.
- `node --test test/apps-host.test.mjs` (desktop) — the launcher starts an
  owned host, reuses a running one, and skips a port that answers something
  else.
- Browser pass: Studio with `--apps-host` against a live apps host: the
  Components workbench lists records, enabling file-explorer starts its
  backend and mounts its `ui/entry.mjs`, and the Artifacts file tree is
  rendered by the `file-viewer` component (selection returns through the
  `select` event); screenshots reviewed, console clean.
