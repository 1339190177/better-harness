# Session population freeze must keep one entry per distinct session identity

## Traceability

- Spec ID: 2026-09-24-session-population-duplicate-identity
- Story: related to QoderAI/better-harness#164 (same failure family)
- Status: Implemented

## Intent

The frozen Session population binding counts eligible Sessions by **distinct
trimmed sessionId** (`sessionIds()`), but `freezeSessionPopulation` stored the
raw prepared inventory in `population.sessions`. A provider whose discovery can
emit two entries with the same content-derived sessionId therefore freezes an
inventory whose raw length disagrees with its own binding count: the Session
facts lane (all-eligible `scope.eligibleSessions`), `selectSessions`, and every
other raw-count consumer then contradict the binding and the bundle fails with
`SESSION_POPULATION_BINDING_MISMATCH` — no report can be produced for that
workspace at all.

Static review of the platform adapters shows the reachable trigger is Copilot:
session identity comes from file content (`workspace.yaml` `id:` and the
`session.start` event's `data.sessionId`, `copilot.mjs`) rather than a unique
filesystem location, and the discovery collector is a plain array. Two
session-state directories that resolve to one content id — copied, re-synced,
or resumed session state — reproduce the failure deterministically. Augment
shares the content-derived identity pattern but is not an evidence-bundle
provider, so its duplicates cannot reach the freeze today.

The freeze owns the invariant its binding already declares: the frozen
inventory holds at most one entry per distinct trimmed session identity, and
dropped duplicate or empty-identity entries are recorded explicitly in the
binding's omission block rather than silently disappearing.

## Acceptance scenarios

- AC-1: `freezeSessionPopulation` drops duplicate and empty-trimmed-id entries
  from the frozen inventory (`first-wins` in the given array order) so that
  `population.sessions.length === population.binding.eligible.count` always
  holds. The workspace-CWD candidate map follows the same first-wins rule so
  the surviving entry inherits its own candidates (or none), never a dropped
  duplicate sibling's.
- AC-2: the binding's `omission` block gains an additive
  `duplicateIdentitySessions` count; existing omission fields, fingerprints,
  schema versions, and `samePopulation` comparisons are unchanged.
- AC-3: a Copilot fixture home with two session-state directories sharing one
  content id freezes a one-entry population, reports
  `omission.duplicateIdentitySessions: 1`, and the Session facts lane stays
  available with `eligibleSessions === selectedSessions === 1` instead of
  throwing `SESSION_POPULATION_BINDING_MISMATCH`.

## Non-goals

- Changing any platform adapter's discovery or identity semantics (Copilot's
  content-derived identity stays as is; merging duplicate entries' source refs
  is future adapter work if ever needed).
- Changing selection strategies, count semantics of `selectSessions`, lane
  envelopes, or the fail-closed binding validation itself.
- Renaming or versioning the population binding schema.

## Plan and tasks

1. Deduplicate the prepared inventory inside `freezeSessionPopulation` before
   freezing, keyed by trimmed sessionId, counting dropped entries.
2. Add `duplicateIdentitySessions` to the binding omission block.
3. Regression tests: a unit test over the freeze (duplicate id + empty id +
   unique id) and a real-fixture Copilot evidence-bundle test following the
   existing Claude population/facts template.

## Test and review evidence

- New tests verified red on the pre-fix implementation (fix stashed:
  2 failed; the CWD-inheritance test separately verified red against the
  pre-fix last-wins candidate map) and green after it (`npx vitest run
  test/sessions/session-population.test.mjs
  test/reporting/better-harness-evidence-bundle.test.mjs` — 45 passed).
- Full root suite: 1774 passed, 6 skipped, 0 failed; `npm run pack:verify`
  passed (the freeze module ships in the npm package).
- End-to-end driver on a synthetic Copilot home: bundle goes from
  `failed` with both lanes `SESSION_POPULATION_BINDING_MISMATCH` to a bound
  population with both lanes available; the Claude end-to-end driver's healthy
  and lead-failure paths are unchanged.
