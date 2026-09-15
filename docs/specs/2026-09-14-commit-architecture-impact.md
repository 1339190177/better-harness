# Commit architecture impact projection

## Traceability

- Spec ID: `2026-09-14-commit-architecture-impact`
- Status: In Progress
- Related:
  - [Structural Commit Diff](2026-09-14-structural-commit-diff.md)
  - [Artifact provider SDK and Structurizr integration](2026-08-22-artifact-provider-sdk-and-structurizr.md)
  - [Harness Studio Artifact runtime and provider architecture](../adrs/studio-artifact-runtime-and-providers.md)

## Intent

The Git history workbench shows one commit as `refs | log | detail`. A reader can
see which lines changed, and with the structural reading, which tokens changed.
They still cannot see **which declared architecture boundary the change crossed**
or **how far it propagates**.

The signals needed already exist, but they are split and unjoined:

| Signal | Where it lives today | Shape |
|---|---|---|
| Symbol graph, callers, impact radius, core hits, test gaps | `hooks/git-scripts/blast-radius/` | JavaScript, stop-hook scoped |
| Token-level structural change of one file | `packages/better-harness-desktop/rust/diff-service` + `difftastic-core` | native capability, display projection |
| Declared C4 model | Qoder Canvas viewer conventions, Artifact provider lane | `.dsl` / workspace JSON |

This spec adds a fourth pane to the commit workbench that projects **one commit**
onto the workspace's **declared** C4 model, marks where the change lands and how
far it reaches, and can export that projection as `.dsl` + `.svg`.

### Why a new Rust core, and why it is not `difftastic-core`

`difftastic-core` is a vendored upstream crate whose only added surface is
`src/bridge.rs`, and whose internals are deliberately `pub(crate)`. Its bridge
returns rendered line segments, not facts: it answers "which tokens changed on
this line", never "which architecture edge this change moved". Extending it into
a fact extractor would mean opening vendored internals and re-applying a second
added module on every upstream re-vendor.

`harness-diff-host` is already 103 MB, dominated by tree-sitter parse tables. A
third parser stack would also duplicate the grammar registry that
`blast-radius` (tree-sitter WASM) and Studio (`oxc-parser`) already carry.

So the facts layer becomes its own reusable Rust core, and **v1 extracts
JavaScript/TypeScript only, through OXC**, which the desktop already ships in
`rust/oxc-service`. No new grammar tables are compiled into a shipped binary.

### Design constraints carried from evidence

These are decisions, not preferences, and every one of them is a plausible v1
mistake:

- Declared architecture and observed code facts stay **two models joined by
  explicit bindings**. A directory is not a component and a repository is not a
  container; at most they are unconfirmed candidates.
- Relation kinds stay **distinct** (`contains`, `imports`, `resolved_call`,
  `declared_http`) and are never folded into one `depends_on`. Folding them makes
  risk propagation produce false positives.
- **View scale and risk severity are separate.** A change inside one function
  can be riskier than a new component dependency; "how many layers up" is not a
  score.
- The projection is **bounded and conservative**. An unresolved target stays
  unresolved. Injection, macros, conditional compilation and path aliases are
  never resolved by guessing a target node.
- A structural diff of zero size is **not** evidence of no impact. Rewriting
  `import { p } from "./payment"` to `"./legacy"` can leave the syntax shape
  identical while the dependency changes.

### Where the declared model comes from

Discovery reuses the conventions the Structurizr viewer manifest already
publishes, so the same files a Canvas reader sees are the files this pane reads:

```
pathGlobs:   **/workspace.dsl, **/workspace.json,
             **/*.structurizr.dsl, **/*.structurizr.json
contentProbe: a `workspace` declaration in the first 32 KiB
fallback:    .better-harness/architecture/model.dsl
bindings:    .better-harness/architecture/bindings.json
             (path glob -> declared element id)
```

The pane borrows the workspace JSON model shape and the `dagre`/rank-direction
layout idea. It does not depend on the Canvas viewer package, and it does not
replace the Artifact provider lane.

## Acceptance Scenarios

- **AC-1** `arch-core` exposes language-neutral file facts and a symbol graph as
  pure functions with **no filesystem access**: the caller supplies file content
  and the tracked path list. The same crate backs both the stdio host and the
  NSXPC service.
- **AC-2** `arch-service` speaks a versioned, bounded JSONL contract mirroring
  `diff-service` (`deny_unknown_fields`, positive request id, per-revision and
  per-batch byte limits, declared maximum file count). Unknown methods, unknown
  fields, empty or NUL paths, over-limit input, and unsupported languages are
  **refusals with stable codes**, never crashes or partial graphs.
- **AC-3** `GET /api/git/commits/:sha/architecture` returns one bounded
  `CommitArchitectureImpactV1` for the selected commit: the projection, the
  change overlay, and the impact radius. When the host is absent or no declared
  model is discovered, the route answers **unavailable**, not an empty
  projection a reader would read as "no impact".
- **AC-4** The commit workbench gains a fourth pane. Wide layouts are
  `refs | log | detail | architecture` with a resizable sash, and element
  identity and position stay stable while the selection moves between commits in
  the same area. Narrow layout gains a fourth tab. Keyboard focus, bounded
  overflow, console/page errors, and light/dark screenshots are verified.
- **AC-5** The pane exports `.dsl` and `.svg` for the current projection, and the
  exported `.dsl` re-parses into the same element and relationship set
  (round-trip asserted on the parsed model, not on emitted text).
- **AC-6** The Stop-hook review trigger gains an offline `architecture-impact`
  source that decides **only** from changed paths matched against declared
  bindings plus the existing change-level thresholds. It performs no source
  parsing, launches no application, and stays deterministic and cross-platform.
  It reports configured model evidence only; it never claims runtime use.
- **AC-7** v1 fact extraction covers JavaScript/TypeScript through OXC. Any other
  language is reported as `unsupported-language` in the diagnostics channel and
  is **excluded** from the graph rather than partially extracted.

## Non-goals

- Runtime or observed traffic edges, log/trace ingestion, or calling a source
  fact a runtime proof.
- Auto-deriving L1 system context, external systems, or trust boundaries. Scale
  L1 stays human or agent proposed and confirmed.
- Replacing, extending, or re-hosting the Structurizr Artifact provider. This
  pane owns its own projection and rendering.
- Incremental graph maintenance. v1 rebuilds a bounded projection per request,
  consistent with the documented `bounded-full-projection` behaviour of
  `blast-radius`.
- Live or streaming refresh during an agent session. The trigger lane in this
  spec is the Stop hook.
- A second tree-sitter stack, or any new grammar tables in a shipped binary.
- Binary files, submodules, mode-only changes, and renames without a textual
  counterpart.
- Removing or rewriting `blast-radius`. Its parser keeps serving the hook until
  the new core demonstrably covers the same language set.

## Plan and Tasks

### Rust core (`packages/better-harness-desktop/rust/arch-core`)

1. `facts.rs`: `extract_facts(path, source) -> FileFacts` over OXC. Every fact
   carries file identity, source digest, extractor version, evidence kind and
   parse status. Nothing exposes a syntax node upward.
2. `graph.rs`: `build_graph(facts, tracked_paths, limits) -> CodeGraph`, porting
   the semantics of `buildCodeGraph`: symbol table, per-file exports index,
   import resolution against the tracked path set, forward and reverse edges,
   unresolved targets retained as unresolved.
3. `project.rs`: declared model (workspace/system/container/component/person,
   relationships) plus bindings, projected against the graph into an
   `ArchitectureSnapshot` whose edges keep their kind and source.
4. `delta.rs`: snapshot against an optional baseline, producing added/removed
   elements and edges, new cycles, and changed counts.
5. `dsl.rs`: emit `.dsl` from a snapshot so an observed projection can be
   promoted, by a human, into the declared model.
6. Bounded by construction: max files, max file bytes, max edges, max symbols;
   each bound refuses rather than truncates silently.

### Rust service (`packages/better-harness-desktop/rust/arch-service`)

7. `wire.rs` mirroring `diff-service/src/wire.rs`; `HOST_PROTOCOL_VERSION` is its
   own constant, not a re-use of the diff protocol version.
8. Methods: `host.describe` (`capabilities: ["arch.facts", "arch.graph",
   "arch.project", "arch.delta"]`), `arch.snapshot`, `arch.emit-dsl`, `shutdown`.
9. Binaries `harness-arch-host` (stdio) and `harness-arch-xpc`, plus
   `harness-arch-client`, matching the existing service topology.

### Desktop packaging

10. Register the new native service on **both** chains: the `after-pack` hook and
    `rust.mjs`. Bundle the client beside the app executable and the service under
    `Contents/XPCServices`. A service wired into only one chain builds locally
    and is missing from the packaged app.

### Studio contracts and server

11. `packages/harness-studio/src/contracts/architecture-impact.ts`:
    `CommitArchitectureImpactV1` plus a validator, in the shape discipline of
    `structural-diff.ts` (own contract, not the engine's).
12. Declared-model discovery from the conventions above.
13. `readCommitArchitectureImpact()`: read the commit's changed files through the
    existing bounded git revision helpers, hand content plus tracked paths to the
    host, and cache bounded results in the workspace state like
    `structuralDiffCache`.
14. Route + provider. Prefer extracting the supervised host transport shared with
    `rust-diff-provider.ts`; if that refactor is not in scope, a sibling provider
    is acceptable but the duplicated supervision logic is a named risk.

### Studio UI

15. Fourth pane in `GitHistoryView.tsx` with `PaneSash`, plus a fourth narrow tab;
    grid column and sash styles under the shared tokens in `workbench.css`.
16. `dagre` layout with stable node identity and position; the hot path updates
    colour, edges, counts and evidence only. A full relayout happens only when
    the structure actually changed.
17. Change overlay and impact radius presented as **separate** encodings from
    risk severity. The pane states what it did not evaluate.
18. Export action producing `.dsl` + `.svg`; i18n resources in `en` and `zh-CN`.

### Review trigger

19. New source under `scripts/review-trigger/`: match changed paths against
    declared bindings and thresholds, emit ordinary finding rows in the existing
    envelope (`id`, `category`, `severity`, `source`, `evidence`, `nextStep`,
    `fingerprint`). No parsing, no host launch, no full-repository scan.

### Tests

20. Rust: facts extraction on fixtures, import resolution, unresolved retention,
    refusal codes, bound enforcement, `.dsl` round-trip.
21. Studio: contract validator, discovery, route unavailable-vs-empty, cache
    bounds, provider supervision.
22. Hook: binding crossing, threshold interaction, determinism, cross-platform
    path handling through `node:path`.
23. Browser: four-pane behaviour at wide / compact / narrow widths, keyboard
    focus, export round-trip, screenshot evidence in both themes.

## Test and Review Evidence

### Implemented and verified

- AC-1 (Rust core): `arch-core` crate exposes `extract_file_facts`, `build_graph`, `compute_change_overlay`, `project_snapshot`, `emit_dsl`. 5 unit tests pass. All pure functions with no filesystem access.
- AC-2 (Wire contract): `arch-service` crate speaks versioned JSONL with `deny_unknown_fields`, positive id, byte limits, refusal codes. `host.describe` / `arch.snapshot` / `shutdown`. 4 unit tests pass.
- AC-3 (Route): `GET /api/git/commits/:sha/architecture` implemented in `server/git/routes.ts`, registered in `server.ts`. Returns `unavailable` when the host is missing.
- AC-6 (Hook): `scripts/review-trigger/architecture-impact.mjs` wired into Stop-hook envelope. Offline, deterministic, cross-platform, no parsing.
- Pipeline: `scripts/rust.mjs` builds + stages `arch-core` and `arch-service` alongside existing services.
- AC-3 (Host wiring, task 14): `server/workspace/rust-host-transport.ts` holds the supervised
  JSONL transport shared by the diff and arch providers; `rust-arch-provider.ts` speaks
  `arch.snapshot` under `arch-rust-1.0.0+jsonl-v1` and maps the host's snake_case result onto
  `ArchitectureImpactReading` (`parentId`/`sourceId`/`targetId`, `impactedFiles` as paths).
  The desktop shell injects it on all three chains (`main.mjs`, `service-host.mjs`,
  `studio-runtime.mjs`) and probes it at startup like every other host; `installArchXpc` and the
  `after-pack` hook bundle the service for macOS, and the Windows/Linux `extraResources` filter
  ships `harness-arch-host`. A host failure now answers `unavailable` with its reason instead of
  a status the pane cannot render.
- AC-3 (Defect): `rust/arch-service/src/arch-protocol.m` declared `forwardRequest:reply:`
  protocols, not the `sendFrame:`/`deliverFrame:`/`hostFailed:` shape `xpc.rs` sends and every
  other host service declares. The macOS bridge aborted with "Rust cannot catch foreign
  exceptions" before its first frame; the file now mirrors `diff-protocol.m`.
- AC-3 (Wire): `arch.snapshot` reports `overlay.impactedFiles` as the impacted path list, which
  is what the Studio contract promises, rather than a count under a path-named key.
- AC-3 (Discovery, task 12 in part): `server/architecture-model.ts` reads the worktree's declared
  model — `.better-harness/architecture/model.json` in arch-core's shape plus `bindings.json` —
  from the tracked path list, so discovery is bounded by what git knows. Absent, unreadable and
  other-dialect models each answer `unavailable` with their reason, and a trackable model reaches
  the host as `model_json` + `bindings`. `arch-service` now refuses a declared model it cannot
  read (`invalid-model`) instead of silently projecting an empty one, which is how "0 elements"
  stayed invisible.
- AC-3 (Failure policy): the pane's contract has three states and no error state, so every
  failure to make a reading — absent host, host fault, a changed file over the host's per-file
  bound — answers `unavailable` with its reason. `readSnapshot` refuses a reply that lost a
  container instead of degrading it to a zero reading, the request line is capped at the 4 MiB
  the hosts' `wire.rs` accepts so an oversized request is a bounded refusal instead of a killed
  host, the per-file bound is aligned to the host's `MAX_FILE_BYTES`, and the reading cache is
  keyed by commit plus worktree path digest.

- AC-4 (Rendering, task 15 in part): the pane draws the C4 shape rather than a row of
  boxes — a boundary per system/container with its children nested inside, each layer centred
  and sized from its own widest row, arrowed edges labelled with the declared relationship, and
  a legend whose swatches reuse the diagram's own markup. `Export .svg` resolves the computed
  paint onto the cloned nodes, because an exported file that depends on the app's stylesheet
  arrives as an unreadable black rectangle in every other viewer.
- AC-4 (Reading the diagram, task 17 in part): the diagram is drawn into a measured viewport
  and fits the pane it has, with zoom (buttons and wheel, about the pointer), pan by drag,
  double-click or `Fit` to reset, and `Escape` to clear. Clicking an element — a box or a
  boundary — opens a docked card naming its kind, technology, state, lineage and the edges in
  and out, including which of them are code facts. The radius is a state of its own: reached
  elements are marked apart from changed ones, and `arch.snapshot` reports the element ids the
  change reached so the two are never conflated. Pointer capture is taken on the first real
  movement, because capturing on press retargets the click that follows to the viewport and the
  element under it never hears the click.

- AC-3 (Impact radius, task 13 in part): `server/architecture-hop.ts` hands the host the
  parseable, tracked files in a changed file's own directory and the one above it — where a
  relative import can reach it — bounded at 200 candidates and reporting what the bound dropped.
  They travel as context, never as changed paths, and a path already considered is not
  reconsidered. `arch-core` now attributes every call site to its enclosing symbol and reads
  class methods and JSX usage, so a caller the commit did not touch finally appears: for
  `fbba212d` the reading went from 0 to 61 impacted symbols and 0 to 4 code-fact edges.
- AC-3 (Bounded reply): the host answers with the projection and the files it could not extract,
  not the per-file facts, so a reply no longer grows with how many files were sent; an
  over-limit reply is now a `limit/response` refusal that names the bound instead of a host that
  exits during the request. Files in a language v1 does not extract are reported in `omitted`
  with their diagnostics rather than dropped silently.

### Verified by

- `npx vitest run` in `packages/harness-studio` (90 files, 696 tests), including the new
  `test/architecture-impact.test.ts`: host-absent `unavailable`, provider mapping and refusal
  classification, cache reuse, and a failed host reported as `unavailable` with its reason.
- `npx vitest run --config vitest.native.config.ts test/architecture-impact.native.ts`: a real
  commit read through the real provider over both `stdio` and the macOS NSXPC bridge, publishing
  a declared model and asserting the projection comes back with that element marked changed.
- The full Rust suite: `npm run test:rust -w @qoder-ai/better-harness-desktop` (every
  capability crate, including `arch-core` through `arch-service`).
- A dev-shell probe over this repository: `fbba212d` answers `status: "impact"`, 23 elements,
  16 edges, 114 changed symbols and **61 impacted symbols**, drawing the declared system →
  containers → components tree with Harness Studio, Studio Desktop Shell and Documentation
  marked changed, and naming the 6 files it could not extract; the same probe fits the diagram
  into the pane (44%), zooms to 68%, returns to fit, opens one changed element's details card,
  exports the pane's SVG and renders it in a plain browser, and keeps the page free of overflow
  at 390px.
- `npm test` in `packages/better-harness-desktop` (10 tests) for the versioned start contract and
  `npm run smoke -w @qoder-ai/better-harness-desktop` for the Electron receipt
  (`nativeProof.archRuntime: "arch-v1-nsxpc"`, `archPid` distinct from `archBridgePid`).
- `cargo test --release` for `arch-service` (4 tests), including the overlay path-list assertion.

### Still open

- Structurizr sources. Discovery reads `.better-harness/architecture/model.json` (arch-core's own
  shape) and `bindings.json`; a tracked `*.dsl` or workspace JSON is reported as an unreadable
  declared model, named in the pane, rather than translated. Translating those dialects — and
  reading their relationships, views and tags faithfully — is the remaining half of task 12.
- `dagre` layout and the four-pane browser evidence (tasks 16, 18, 23). The pane's own layout is
  hierarchical and bounded, but it has no rank/flow ordering: edges cross boundaries and are not
  routed around boxes.
- The radius is one hop, and it is reported per element. Coarse bindings — one element per
  directory — mean a caller often lives in an element the commit already changed, so "reached"
  can be empty on a large commit even when the symbol counts show a real radius.
- The diagram is drawn into the pane rather than opened larger; a dedicated expanded surface is
  the next step if a reader needs the picture beyond a docked pane's height.
- Authoring a model is content, not code: this repository ships one under
  `.better-harness/architecture/` so its own commits can be read in the pane.

### Evidence that was expected but is not yet produced

- `npm run better-harness-desktop:pack` plus the packaged smoke receipt. The receipt above comes
  from the dev shell, so the `after-pack` install of the arch service is reviewed but not run.
- Playwright screenshots committed with the change for the pane at three widths in both themes;
  the probes above take them, but the resulting images live outside the repository.
- a `node scripts/review-trigger/cli.mjs --mode=stop --json` run whose envelope
  contains the new source's findings.

## Decisions and Risks

- **Decision**: facts live in a new reusable core, not in `difftastic-core`. The
  vendored crate keeps exactly one added module, and no upstream re-vendor has to
  re-apply a second one.
- **Decision**: v1 is JavaScript/TypeScript through OXC. This is the language set
  `blast-radius` covers best and the one Studio edits most; the cost is honest
  `unsupported-language` diagnostics for everything else.
- **Decision**: the fourth pane attaches to the commit workbench, not to the
  Artifacts workspace. The reader's question is about the commit they selected.
- **Risk**: `arch-core` and `blast-radius` will both resolve imports until the
  core is proven equivalent. Two resolvers can disagree. Mitigation: the hook
  source in AC-6 does not use the core at all, and replacing `blast-radius` is
  explicitly out of scope.
- **Risk**: Studio, `blast-radius` and `arch-core` would each own a language
  registry. Mitigation: v1 adds no grammar tables and reuses the OXC version the
  desktop already ships; a shared language registry is deferred, not forgotten.
- **Risk**: a projected edge can be read as a measured call. Mitigation: edge
  kind and source ship in the contract, and the pane names what each edge is
  based on.
- **Risk**: `dagre` is a new Studio dependency. It is a layout engine only, with
  no runtime host access.
