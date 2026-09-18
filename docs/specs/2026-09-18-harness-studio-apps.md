# Harness Studio Apps: extract the app host mechanism into Better Harness

## Traceability

- Spec ID: 2026-09-18-harness-studio-apps
- Status: Implemented — extraction and the app-UI contract first cut; the Harness Studio AppHost integration is the next slice

## Intent

Better Harness needs a home for features that outgrow a route inside the
Studio server: an app host with an enablement gate, process isolation for
backends, and a frontend contract so an app's UI can be derived from the
feature without inventing a second plugin system.

The mechanism already exists and was proven end-to-end: the KiroCrew Node
compat host ran the official app suite — host, HMAC-signed proxy, Node
backend ports, per-app smoke tests. This spec moves that mechanism into Better
Harness as a workspace package (`packages/harness-studio-apps`) and defines
the one piece the KiroCrew host borrowed from its SPA and therefore never
owned: the app-UI contract.

## Acceptance scenarios

- AC1 — The package runs standalone: `node server.mjs` starts with no
  dashboard dist configured, warns once, and serves the app surface.
- AC2 — `node test/run-all.mjs` runs every ported smoke test serially and
  exits 0 with every report ending in `ALL PASS`.
- AC3 — A backend is a sibling `server.mjs`; the host discovers, spawns, signs
  and proxies it without any manifest edit (file-explorer tree reads through
  the live host, plus the per-app smoke tests).
- AC4 — `client.mjs` exports the UI contract (`createAppSdk`, `createAppApi`,
  `createEventBus`, `AppApiError`, `APP_CONTRACT_VERSION`) and the
  file-explorer `ui/entry.mjs` mounts against it using only `sdk.api`.
- AC5 — `GET /apps/file-explorer/ui/entry.mjs` serves the entry with the
  extension allow-list, the CSP sandbox header, and `no-cache`; traversal and
  unknown extensions keep the upstream 400/403 answers.
- AC6 — The package joins the workspace without changing existing checks:
  `npm test -w @qoder-ai/harness-studio-apps` runs the smoke suite and the
  other workspace test scripts are untouched.

## Non-goals

- No Harness Studio AppHost (loading and mounting entries inside the Studio
  React shell) in this slice — the contract is defined and reference-tested,
  the consumer integration comes next.
- No app-store style install/uninstall/registry surfaces.
- No port of the KiroCrew shell APIs (chat, crons, artifacts); the shaped
  stubs stay stubs.
- No rename of the wire protocol (`X-KiroCrew-Proxy`, `KIROCREW_*` env): it is
  a tested protocol contract, and a rename is a separate decision.

## Plan

1. Create `packages/harness-studio-apps` from the KiroCrew Node host
   (`lib/`, `apps/`, `server.mjs`, the smoke tests), and drop the two
   untracked older `kirocrew-compat` snapshots (`packages/`,
   `dev/`) that this package replaces. Assets the ports used to reach through
   the Kiro Crew source tree (the design-tweak overlay, the design-critique
   skill) ship inside their apps instead.
2. Make the dashboard dist optional (`lib/config.mjs`, `lib/static.mjs`,
   `server.mjs`) so the host runs without a Kiro Crew install.
3. Add `client.mjs` plus the `apps/file-explorer/ui/entry.mjs` reference and
   the `ui.entry` manifest field; add `test/run-all.mjs`.
4. Join the workspace and add the root scripts.
5. Document the mechanism (package README) and this spec; evidence below.

## Evidence

- `node test/run-all.mjs` — every ported smoke file passes.
- Live-host pass on an isolated home: `/api/apps` records, enable/disable
  lifecycle, a signed proxied `apps/file-explorer/api/tree` read, the
  `ui/entry.mjs` bundle served with the right headers, and a disabled app
  answering 403.
- `node --check` across `lib/`, `server.mjs`, `apps/`, `client.mjs`, and
  `test/`.
- Self-contained assets (removed later with their apps, see the scope note
  below): `apps/design-tweak/inject/select-to-edit.js` and
  `apps/design-critique/skills/design-critique/` shipped with their apps, and
  a backend spawn with no skill-dir override resolved the in-app copy first,
  so those ports ran with no Kiro Crew checkout or install on the lookup path.
- Scope narrowed after extraction: `file-explorer` remains as the single
  reference port — the other ported backends, their bundled assets and their
  smokes were removed deliberately — and `node test/run-all.mjs` now runs
  `test/test_file_explorer.mjs`.
