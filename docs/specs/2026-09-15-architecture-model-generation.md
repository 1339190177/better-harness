# Architecture model generation and confirmation

## Traceability

- Spec ID: `2026-09-15-architecture-model-generation`
- Status: In Progress
- Related:
  - [Commit architecture impact projection](2026-09-14-commit-architecture-impact.md)

## Intent

The Impact pane projects one commit onto a **declared** architecture model
(`.better-harness/architecture/model.json`). A project that has not authored one
sees `No declared architecture model was found`, and the pane has nothing to
draw. Authoring a model by hand is real work, so most projects never do it and
the pane is inert for them.

This spec makes the model **derivable**: when a project declares no model, the
Impact pane projects the commit onto a model **generated from the project's own
structure**, marked as generated rather than presented as an authored fact. A
reader can then refine it — with an agent — and, only on their action, save it
as the declared model this and every later reading uses.

The generation is deterministic and evidence-first: it reads what the worktree
already tracks (workspace manifests, package boundaries, source directories),
never guesses a boundary it cannot ground, and keeps the arch host's existing
`model_json` + `bindings` contract as the single shape everything consumes.

### Three model states

| State | Origin | Impact pane behavior |
|---|---|---|
| `declared` | authored, saved under `.better-harness/architecture/` | used as-is |
| `generated` | deterministic analysis of the worktree | used, marked `generated · <confidence>` |
| `agent-proposed` | agent-refined candidate over a generated model | used, marked `proposed`, still unsaved |

Only a reader's explicit save turns a `generated` or `agent-proposed` model into
a `declared` one on disk. A `GET` reading never writes to the user's repository.

## Acceptance Scenarios

- **AC-1** `generateArchitectureModel` is a pure function: given a repo name,
  the tracked path list, and the parsed contents of any workspace manifests, it
  returns a model in arch-core's own shape (`elements` with snake_case
  `parent_id`, `relationships` with `source_id`/`target_id`) plus `bindings`,
  with **no filesystem access** of its own. The same tracked paths always
  produce the same model.
- **AC-2** The generated model is **bounded and grounded**: one `SoftwareSystem`
  root, one `Container` per workspace/package boundary, and `Component` children
  only for source directories that actually contain extractable source, capped
  at a declared maximum. A directory with no source, and any path the projection
  is not about, produces no element. Every generated element carries a
  `generated` tag; every binding maps a real path glob to a generated element.
- **AC-3** `resolveArchitectureModel` returns the declared model when one is
  readable, and otherwise a generated model carrying `origin: "generated"` and a
  confidence. An **unreadable** declared model (malformed JSON, wrong shape,
  a foreign dialect) still answers `unavailable` with its reason — a broken
  authored model is never silently replaced by a generated one.
- **AC-4** `CommitArchitectureImpactV1` gains an optional `modelSource`
  (`origin` + `confidence`). A reading over a declared model reports
  `origin: "declared"`; a reading over a generated model reports
  `origin: "generated"` with its confidence. The three status states
  (`impact` / `no-impact` / `unavailable`) are unchanged.
- **AC-5** The Impact pane marks a generated reading (`Auto-generated ·
  <confidence>`) distinctly from a declared one, and offers `Review model`,
  `Refine with agent`, and `Save as declared model`. Save writes
  `.better-harness/architecture/model.json` and `bindings.json` only on the
  reader's action, through a dedicated write route; a declared model is never
  overwritten without an explicit confirm.
- **AC-6** A repo-local skill (`architecture-model-bootstrap`) consumes the
  deterministic evidence pack and returns a schema-valid `agent-proposed` model:
  it may rename, merge, split, re-kind (Container vs Component), and describe
  candidate elements, and propose external systems, but every element it keeps
  retains resolvable path evidence. The skill never invents a binding to a path
  that does not exist.

## Non-goals

- Auto-deriving L1 system context, external systems, or trust boundaries without
  confirmation. Generation proposes Container/Component structure from evidence;
  L1 scale and external systems stay agent-proposed and human-confirmed, per the
  parent spec's non-goal.
- Replacing the declared-model contract or the arch host wire. Generation
  produces the same `model_json` + `bindings` shape the host already consumes.
- Multi-language fact extraction beyond what arch-core covers. Generation uses
  tracked paths and manifests for boundaries; component grounding uses the
  extractable source set, and a broader language set is a later slice behind a
  shared `FileFactsV1`.
- Writing to the user's repository on a read. Only an explicit save persists a
  model.
- Incremental model maintenance or diffing a generated model against a declared
  one. v1 regenerates a bounded candidate per request when no model is declared.

## Plan and Tasks

### Slice 1 — deterministic generation and fallback (server, no native rebuild)

1. `packages/harness-studio/src/server/architecture-model-generator.ts`: pure
   `generateArchitectureModel({ repoName, trackedPaths, manifests })` producing
   the arch-core-shaped model + bindings, bounded by a max element count, every
   element tagged `generated`.
2. `architecture-model.ts`: add `resolveArchitectureModel(repoRoot, trackedPaths)`
   returning `{ origin: "declared" | "generated", model, bindings, confidence? }`
   or the existing `unreadable` answer. Declared wins; absent falls back to
   generated; unreadable stays unavailable.
3. `architecture-impact.ts`: use the resolved model, thread `modelSource` onto
   the result and the cache key.
4. `contracts/architecture-impact.ts`: add optional `modelSource`.
5. Tests: generator determinism, bound and grounding, declared-vs-generated
   resolution, unreadable-stays-unavailable, and `modelSource` on the reading.

### Slice 2 — surface the source and save (UI + write route)

6. `ArchitectureImpactView.tsx`: a generated badge with confidence, and the
   `Review model` / `Refine with agent` / `Save as declared model` actions.
7. A write route that persists the current model + bindings under
   `.better-harness/architecture/`, guarded so a declared model is not
   overwritten without confirm; i18n in `en` and `zh-CN`.

### Slice 3 — agent refinement skill

8. `.agents/skills/architecture-model-bootstrap/SKILL.md` plus references: the
   evidence pack it reads, the schema it must return, and the grounding rules.

### Slice 4 — multi-language grounding (deferred)

9. A shared `FileFactsV1` so Tree-sitter can feed the same graph builder for
   languages arch-core's OXC path does not cover, improving component grounding.

## Test and Review Evidence

### Slice 1 — implemented and verified

- AC-1/AC-2 (generation): `architecture-model-generator.ts` derives one
  `SoftwareSystem`, a `Container` per workspace manifest boundary, and
  `Component` children only for source directories that hold source-like files,
  tagging every element `generated`. `test/architecture-model-generator.test.ts`
  asserts the shape, the source-only grounding (a `docs` directory produces no
  component), the ignored build/dependency segments, determinism, and that no
  binding glob starts with a stray `/`.
- AC-3 (resolution): `resolveArchitectureModel` returns the declared model when
  readable, falls back to a generated one when absent, and keeps an unreadable
  declared model `unavailable` with its reason.
- AC-4 (`modelSource`): `readCommitArchitectureImpact` threads `modelSource`
  (origin + confidence) onto the reading and the cache key.
  `test/architecture-impact.test.ts` asserts a declared reading reports
  `origin: "declared"` and an absent-model reading now projects a `generated`
  model (host called, elements tagged `generated`) instead of answering
  `unavailable`.
- Verified by: `npx vitest run test/architecture-model-generator.test.ts
  test/architecture-impact.test.ts` in `packages/harness-studio` — 2 files, 30
  tests, all passing.

### Slice 2 — implemented and verified

- AC-5 (save route): `POST /api/git/architecture/model` in `git/routes.ts`
  persists the resolved model to `.better-harness/architecture/` and clears the
  reading cache. It refuses to overwrite a declared model without
  `overwrite: true` (`ARCH_MODEL_DECLARED`), surfaces an unreadable model as
  `409`, and is the only write path — reads never write. Registered in
  `server.ts`.
- AC-5 (UI): `ArchitectureImpactView.tsx` shows an `Auto-generated · <confidence>`
  badge and a `Save as declared model` action only when `modelSource.origin ===
  "generated"`, with a status line for the save outcome; badge and save-note
  styles added to `workbench.css` (badge scoped under `.arch-header` to beat the
  muted-span rule).
- Verified by: `npx vitest run test/architecture-model-generator.test.ts
  test/architecture-impact.test.ts` (2 files, 32 tests, all passing) covering the
  save round-trip (generated → saved → read as declared) and the
  overwrite guard; `npx tsc --noEmit` clean over `packages/harness-studio`.
- Follow-up: a Playwright screenshot of the generated badge needs a
  provider-backed Impact pane (native arch host), so the badge's visual review is
  pending a desktop run.

### Slices 3–4 — still open

- Slice 3 (agent skill) and Slice 4 (multi-language grounding) are not yet
  implemented. `Refine with agent` lands with Slice 3.

## Decisions and Risks

- **Decision**: generation lives in the Studio server (TypeScript), not the Rust
  host, because the host already takes `model_json` as **input**. A generated
  model is just a model the server supplies, so no native rebuild is on the
  critical path for the first slice.
- **Decision**: a generated model is used but always labeled, never written on a
  read. Presenting a derived boundary as an authored fact is the mistake the
  parent spec's "a directory is not a component" constraint guards against; the
  label plus save-on-confirm keeps inference and declaration distinct.
- **Risk**: coarse generated boundaries (one component per directory) inflate or
  flatten the real architecture. Mitigation: bound the element count, ground
  components in real source, and route refinement through the agent skill and a
  human save rather than trusting the first cut.
- **Risk**: two model origins reaching the same host could diverge in shape.
  Mitigation: `generateArchitectureModel` emits exactly the shape
  `readModelShape` validates and the host consumes, asserted in tests.
