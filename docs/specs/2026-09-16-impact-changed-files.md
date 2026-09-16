# Impact lists the files a commit changed

## Traceability

- Spec ID: `2026-09-16-impact-changed-files`
- Status: Implemented
- Related:
  - [Commit architecture impact projection](2026-09-14-commit-architecture-impact.md)
  - [Generated architecture model](2026-09-15-architecture-model-generation.md)

## Intent

The Impact surface answers "what did this commit move in the architecture", and
it answers it only in the architecture's own vocabulary: a diagram plus one line
of symbol counts. When the commit changed code the reader can see the marked
elements; when it did not, the pane prints **"No architecture impact detected"**
and stops.

That sentence is true and still misleading. Over `canvas-sdk`, commit `bbae0a56`
(`feat(ontology-workbench): add plugin logo ...`) changed exactly one file —
`plugins/ontology-workbench/assets/icon.png`. The reading is `no-impact` because
an asset holds no symbols, which is the intended answer (AC-7 of the projection
spec). But the pane never says *which* files the commit changed, so a reader
cannot tell "this commit is genuinely architectural no-op" apart from "this
commit changed four files and none of them entered the projection". The same
gap hides the panel's own work: a file the reading did include but the host could
not parse is reported in the toolbar's omission notice, while the file it
included and parsed successfully is invisible as a file.

This spec adds the missing evidence layer: the commit's changed files, each one
named and labelled with the standing it had in the reading — in the projection,
not source, deleted, over a bound, or unread by the host — and the declared
element a binding maps it onto, so "which module changed" is answerable from the
file list and not only from the diagram.

## Acceptance Scenarios

- **AC-1** `GET /api/git/commits/:sha/architecture` answers a `files` array
  holding **every file the commit changed**, each with `path`, `status`,
  `additions`, `deletions`, `binary` and a `state` naming its standing in the
  reading: `in-projection`, `not-source`, `deleted`, `too-large`,
  `request-budget`, `unsupported-language` or `unparsed`. Files sent only as
  one-hop context are never listed: the array is the commit's change, not the
  request's payload. An `unavailable` reading carries `files: []`, because no
  change was read at all.
- **AC-2** Each file's `elementIds` come from the reading's own bindings, matched
  with the semantics `arch-core` uses (`**/suffix`, `dir/**`, `prefix**`, a
  single `*`, and exact equality), so the pane and the diagram never disagree
  about which boundary a path belongs to. A path matched by several bindings
  lists every element; a path no binding matches lists none.
- **AC-3** The pane renders a docked **Changed files** list under the diagram:
  one row per file with its change status, its path (clipped with the whole path
  in a tooltip, never widening the pane) and its standing. A file in the
  projection also names the declared element it belongs to. The list scrolls
  inside a bounded height of its own, and the toggle that collapses it reports
  its state through `aria-expanded` and is reachable by keyboard.
- **AC-4** A commit whose files are all non-source — the `bbae0a56` case — lists
  those files and labels them **not source**, so the pane never answers a
  no-impact reading with silence about what the commit did change. The diagram
  and its summary line are unchanged by this task.
- **AC-5** The `files` array is validated on the client with the rest of the
  reading: a payload whose `files` is not an array, or whose entries are missing
  `path` or `state`, is refused as an unsupported contract rather than rendered
  as an empty list.

## Non-goals

- Filling the diagram's missing edges. A generated model carries
  `relationships: []`, so the pane's `0 edges` is a separate question with a
  separate change.
- Selecting an element, opening its card, or scrolling the diagram when a file
  row is activated. The list is evidence, not a second navigator.
- Adding non-source files to `omitted`. The projection spec's decision stands:
  a file the projection is not about is not a gap in it, and the file list is
  where it is now named instead.
- Reading a file's patch, or showing line-level change inside the list.
- Localizing the pane. The projection's copy is hardcoded English today and this
  spec adds rows to it, not a translation layer.

## Plan and Tasks

### Contract (`packages/harness-studio/src/contracts/architecture-impact.ts`)

1. Add `ArchitectureImpactFileState` and `ArchitectureImpactFile`
   (`path`, `status`, `additions`, `deletions`, `binary`, `state`,
   `elementIds: string[]`), and a `files: ArchitectureImpactFile[]` field on
   `CommitArchitectureImpactV1`.
2. Extend `isArchitectureImpact` to require `files` as an array of objects with
   a string `path` and a known `state`.

### Server (`packages/harness-studio/src/server/`)

3. New `architecture-bindings.ts`: `simpleGlobMatch(path, glob)` mirroring
   `arch-core`'s `project.rs::simple_glob_match`, and
   `elementsOwningPath(path, bindings)` returning every bound element id in
   binding order, deduplicated.
4. `architecture-impact.ts` records one row per `detail.files` entry as the
   reading classifies it: `deleted` for a status whose content does not exist at
   the revision, `not-source` when `isSourceLike` refuses it, `too-large` /
   `request-budget` when the read bound leaves it out, and `in-projection`
   otherwise. After the host answers, a file it reported in `skipped` is
   re-labelled `unsupported-language` (not extractable) or `unparsed`
   (extractable but rejected). Each row's `elementIds` are resolved from the
   reading's bindings. The hop's context files are classified nowhere: they are
   not in `detail.files`.
5. `unavailableImpact` answers `files: []`.

### Studio UI (`packages/harness-studio/src/app/`)

6. `ArchitectureImpactView.tsx`: render a docked `Changed files` panel below the
   diagram, with a toggle in its own header, a row per file (status letter, path
   with `title`, standing, owning element names resolved from `data.elements`),
   and no panel at all when `files` is empty.
7. `styles/workbench.css`: extend `.arch-pane`'s row template to hold the panel,
   and style `.arch-files` as a bounded, self-scrolling pane in the design
   system's semantic tokens (no one-off colours or sizes).

### Tests

8. `test/architecture-impact.test.ts`: a commit of one asset answers
   `not-source` and not `omitted`; a deleted, an over-limit, an unread-language
   and an unparseable file each carry their own state; `elementIds` follows the
   binding globs (`**/x`, `dir/**`, exact) and can name more than one element;
   an unavailable reading answers `files: []`; the contract validator refuses a
   payload whose `files` is not an array.
9. `test/browser/impact.spec.mjs`: the list is visible for the selected commit,
   a non-source file is labelled as such, the toggle collapses and expands with
   `aria-expanded`, and the pane keeps a bounded overflow at the suite's narrow
   viewport.

## Test and Review Evidence

- AC-1/AC-2/AC-5 (unit): `npx vitest run test/architecture-impact.test.ts` — 33 passed.
  New cases: `lists the commit's files with the standing the reading gave each` (six
  changed files in one commit, each with its own state, and the hop's context absent from
  the list), `maps a changed file onto every element its bindings name` (one path, two
  elements, in binding order), `names a commit whose only change is an asset` (`no-impact`
  with the file named and `omitted: []`), `refuses a file list that is not the contract`,
  and `binding globs` over the shapes the host matches.
- AC-3/AC-4 (browser): `npx playwright test test/browser/impact.spec.mjs` — 8 passed.
  New cases: `lists the commit's changed files with the standing each had in the reading`
  (three rows, `in projection` / `not source` / `language not extracted`, the held file
  naming `Store`) and `keeps the changed-file pane bounded at every width the surface can
  take` (1600/1280/900/600 px: no page overflow, the list inside its pane, the fit never
  below 50%, and the toggle's `aria-expanded` flip).
- Visual: a dev-shell probe over a fixture commit that changes one file of each class, at
  1440x900, 1024x768 and 390x844 in both themes — no console or page errors, zero
  document overflow, five rows listed at every width, and the collapsed pane beside it.
  Screenshots: `.tmp/impact-files/impact-files-{wide,compact,narrow}-{dark,light}.png`
  and `impact-files-wide-collapsed-dark.png`.
- `tsc --noEmit` (`npm run typecheck`) is clean after the contract change.

### Still open

- The generated model still carries `relationships: []`, so the diagram's `0 edges` and
  the `bbae0a56` reading over `canvas-sdk` are unchanged: that commit is named in the
  file list now, but the picture still has no lines.
- The pane's copy is English only, the new list's standings included.

## Decisions and Risks

- **Decision**: the file list travels in the impact reading, not from a second
  `GET /api/git/commits/:sha` call. Only the server knows which files entered the
  projection and why the others did not; re-deriving that on the client would be
  a second, divergent reading of the same commit.
- **Decision**: `elementIds` is resolved on the server, beside the bindings it
  uses. The pane's `elements` array is a filter of the model, so resolving names
  client-side would silently drop an element the diagram omitted.
- **Risk**: the glob matcher is a second implementation of `arch-core`'s naive
  semantics. Mitigation: the unit tests use the same glob shapes the Rust
  fixtures use (`**/greeting.ts`, `store.ts`, `packages/studio/**`), and the
  matcher stays deliberately as naive as the original rather than growing into a
  real glob engine.
- **Risk**: a docked panel takes height from the diagram, and `fitView` falls
  back to a corner when the pane is shorter than `MIN_LEGIBLE_SCALE`. Mitigation:
  the panel is bounded and collapsible, and the visual check covers the three
  widths with the panel open.
