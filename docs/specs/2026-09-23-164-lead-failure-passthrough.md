# Lead lane failures must not be relabeled as session population binding mismatches

## Traceability

- Spec ID: 2026-09-23-164-lead-failure-passthrough
- Story: QoderAI/better-harness#164
- Status: Implemented

## Intent

When the lead analyzer fails for its own reason (for example a
provider-specific throw inside `analyzeHarnessEvidence`), the evidence bundle
currently replaces that lane with a generic
`SESSION_POPULATION_BINDING_MISMATCH` envelope. The replacement happens because
`populationDiagnostics` reconciles lead-side counts from absent data
(`lead.data` is missing, so every lead count compares as `-1`), reports
`conflict`, and `collectEvidenceBundle` then overwrites the lead lane — even
though nothing about the session population binding actually conflicted. The
bundle still fails closed, but the user-visible failure code points at the
binding contract instead of the real cause, which makes reports such as #164
undiagnosable: the original lead error is discarded before it can reach the
reader.

An unobserved lead lane must keep its own failure on the lane, and binding
reconciliation must only judge the lead when the lead produced data. Genuine
binding conflicts (lead data present but contradicting the frozen population)
keep the existing fail-closed code and surface the concrete reconciliation
errors in the diagnostics payload.

## Acceptance scenarios

- AC-1: when the lead lane fails before producing data, the bundle keeps the
  lane's original error code, the session population binding diagnostics report
  `bound` with `leadObserved: false`, and the bundle status remains `failed`.
- AC-2: when the lead lane returns data that contradicts the frozen population
  (for example public eligible counts that do not match the binding), the bundle
  keeps the fail-closed `SESSION_POPULATION_BINDING_MISMATCH` lead downgrade and
  the diagnostics include the concrete reconciliation error strings plus
  `leadObserved: true`.
- AC-3: `validateSessionPopulationBundle` gains an optional `leadObserved`
  flag (default `true`); lead-attributed structural checks are skipped only when
  the flag reports the lead lane as unobserved. Existing callers keep their
  behavior.

## Non-goals

- Changing the fail-closed contract of the binding reconciliation itself.
- Changing lane envelope shapes, fingerprints, discovery, qualification, or
  provider behavior.
- Diagnosing the remaining provider-specific lead failure that #164 reports on
  Windows; this change only stops masking it.

## Plan and tasks

1. `populationDiagnostics` computes `leadObserved`, skips lead-attributed
   validation and lead public-count checks when the lead lane produced no data,
   and records `leadObserved` plus the concrete `errors` array on conflict.
2. `collectEvidenceBundle` reassigns the lead lane to the binding-mismatch
   envelope only when the conflict was observed against available lead data.
3. `validateSessionPopulationBundle` accepts `leadObserved` and skips
   lead-attributed structural checks when the lead is unobserved.

## Test and review evidence

- New regression test `lead lane keeps its own failure code instead of a
  fabricated binding mismatch` fails on the pre-fix implementation (verified by
  stashing the source change) and passes after it.
- The existing conflict tests are extended with `leadObserved` and `errors`
  assertions and keep passing unchanged in their fail-closed expectations.
- `npx vitest run test/reporting/better-harness-evidence-bundle.test.mjs
  test/sessions/session-population.test.mjs` — 42 tests pass.
