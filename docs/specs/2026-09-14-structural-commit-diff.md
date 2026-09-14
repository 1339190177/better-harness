# Structural Commit Diff

## Traceability

- Spec ID: `2026-09-14-structural-commit-diff`
- Status: In Progress

## Intent

The Git history view (commit detail) renders a file's change as a unified diff
produced by `git diff`, parsed by `@pierre/diffs`. That is a line-oriented view:
a one-token change inside a formatted expression shows the whole line rewritten.

This spec adds a second, **structural** reading of the same commit file change,
computed by a vendored build of [difftastic](https://github.com/wilfred/difftastic)
and delivered through the existing native capability channel:

```
Studio (Node) -> harness-diff-client <NSXPC> harness-diff-xpc <stdio> harness-diff-host -> difftastic-core
```

The commit view gains a Textual/Structural switch. Textual stays the default and
the fallback; structural is opt-in per file.

### Why a vendored library, not a `difft` subprocess

- difftastic is published as a binary crate only. It has no `[lib]` target and
  its internals are `pub(crate)`, so it cannot be consumed as a dependency as-is.
- Its only machine-readable output, `--display json`, requires `DFT_UNSTABLE=yes`
  and its format is documented as changing between releases. Binding our wire
  contract to it would make our contract unstable too.
- Vendoring the engine lets us emit our own stable, self-contained contract and
  keeps difftastic's raw byte-offset spans off our client boundary.

## Non-Goals

- Replacing the textual diff. It remains the default and the fallback.
- Structural diff for binary files, submodules, mode-only changes, or renames
  without a textual counterpart.
- diffing whole commit trees in one request. v1 is one file at a time, matching
  the existing patch route.
- A three-way merge or conflict view.
- Language parity with upstream. Janet, Kotlin, LaTeX, and Smali are deliberately
  dropped (see Decisions) because they are the only grammars difftastic vendors
  as C sources (~62 MB). Every crates.io-hosted grammar is retained.
- Windows/Linux NSXPC. Those platforms use the same stdio driver the other
  capability services already use.

## Acceptance Scenarios

- **AC-1** The commit detail view offers a Textual/Structural switch for a changed
  text file, and Textual is selected by default.
- **AC-2** Selecting Structural renders aligned old/new line pairs with
  token-level highlights, and marks the language difftastic detected.
- **AC-3** A structural response is self-contained: rendering needs no byte-offset
  arithmetic in the client and no second fetch of the file bodies. Each rendered
  line carries its segments as text, so a multi-byte line cannot split a
  character.
- **AC-4** When the file is binary, the patch is empty, the file is missing from
  the commit, or the path is invalid, the endpoint reports the same error class
  the textual patch route already uses (`INVALID_PATH`, `FILE_NOT_FOUND`,
  `PATCH_TOO_LARGE`), and the client keeps showing the textual diff.
- **AC-5** When the native diff service is unavailable, the structural request
  fails with `DIFF_HOST_UNAVAILABLE` and the UI falls back to the textual diff
  without an unhandled error.
- **AC-6** A file above the request byte bound is answered with
  `STRUCTURAL_DIFF_TOO_LARGE` (413) instead of invoking the engine.
- **AC-7** A structural request that exceeds the per-request time bound is
  answered with `STRUCTURAL_DIFF_TIMEOUT` (504) and the native host remains
  usable for the next request.
- **AC-8** On macOS the service proves the NSXPC hop with a `transport` frame
  before its first result; a stdio host is refused when NSXPC was required
  (`DIFF_HOST_TRANSPORT`). No silent fallback.
- **AC-9** Request and response frames are bounded; an over-limit request is
  rejected with `limit/request` and the connection is not left half-written.
- **AC-10** The parser-detected language name and the change counts are stable
  across repeated requests for the same commit and path (cached), and a second
  request does not re-invoke the engine for an unchanged key.

## Plan / Tasks

1. **Vendored engine** - `packages/better-harness-desktop/rust/difftastic-core/`
   - Copy difftastic 0.71.0 `src/` and `vendored_parsers/highlights/`.
   - Add `[lib]`; rename `main.rs` to `lib.rs`; drop `fn main`, the global
     allocator, and the SIGPIPE handler.
   - Replace `env!("CARGO_BIN_NAME")` (bin-only) with `env!("CARGO_PKG_NAME")`.
   - Remove the `Janet`, `Kotlin`, `LaTeX`, `Smali` variants and their arms in
     `guess_language.rs`, `tree_sitter_parser.rs`, `diff/sliders.rs`, and the
     matching entries in `build.rs` and `highlights/`.
   - Add `bridge.rs`: a `pub` function returning a self-contained structure.
   - Ship `LICENSE` and `NOTICE.md`.
2. **Diff service** - `packages/better-harness-desktop/rust/diff-service/`
   - `harness-diff-host`: protocol v1 JSONL over stdio, `--version`/`--help`.
   - `harness-diff-xpc`: Foundation NSXPC listener (`com.qoder.harness-studio.diff`).
   - `harness-diff-client`: stdio bridge with the `transport` proof frame.
   - `diff-protocol.m`: ABI protocol declarations only.
3. **Build wiring** - `scripts/rust.mjs`, `scripts/nsxpc-bundle.mjs`
   (`installDiffXpc`), `packages/better-harness-desktop/package.json`
   (`extraResources` filter, third-party notices).
4. **Studio server** - `contracts/structural-diff.ts`,
   `server/workspace/rust-diff-provider.ts`, `server/structural-diff.ts`,
   route in `server/git/routes.ts` + `server/server.ts`, provider wiring in
   `server/workspace/routes.ts` and desktop options.
5. **Studio UI** - `app/code/StructuralDiffView.tsx`, switch in
   `app/GitHistoryView.tsx`, i18n resources, stylesheet roles.

## Test / Review Evidence

Recorded on 2026-09-14, macOS arm64, Rust 1.96.0.

- `cargo test --locked` in `difftastic-core`: 122 upstream unit tests + 10 bridge
  tests. The bridge's central assertion is that every rendered side rebuilds its
  own source line, which is what proves byte columns never split a character.
- `cargo test --locked` in `diff-service`: 8 protocol tests + 2 driver tests. The
  driver tests run the real binary over stdin/stdout, and assert that an
  oversized frame ends the host rather than leaving it half-written.
- `vitest`: 686 tests pass, including 14 new ones (contract validator, revision
  extraction, cache, binary/absent-path refusal, host failure mapping) and the
  updated `/api/config` contract.
- `playwright`: 3 new tests cover wide (1440), compact (1080) and narrow (390)
  widths in both themes, with a screenshot each. They assert the switch is
  keyboard reachable, that only the newer side marks novel runs, that both sides
  are on screen at equal width, that nothing wraps, that the document does not
  overflow, and that the console stays clean. `git-history.spec.mjs` still passes,
  which is the regression guard for the textual reading.
- Real-chain test `structural-diff.native.ts` passes over **both** transports:
  stdio, and the macOS NSXPC bridge through the launchd-managed service.
- Measured engine cost: ~0.5 s for 750 lines and ~1.2 s for 7.4k lines, against
  ~0.03 s for `git diff` on the same pair.

## Decisions and Boundaries

- **Vendored, not forked.** The changes are the minimum needed to build the
  engine as a library: one visibility bridge and the language removal. Engine
  behaviour is not modified.
- **Language boundary.** Dropping the four vendored-grammar languages keeps the
  in-repo payload at ~70 KB of highlights instead of ~62 MB of generated C.
  Re-adding one requires its grammar source and an arm in the language tables.
- **We own the wire contract.** difftastic's `--display json` is never exposed;
  `StructuralDiffV1` is ours and is what the renderer and tests assert on.
- **Segments, not offsets.** The bridge converts difftastic's byte columns into
  ordered text segments per side, because the client is UTF-16 and difftastic
  reports byte offsets.
- **Opt-in.** Structural diff is materially slower than a line diff (measured
  ~0.5 s for 750 lines, ~1.2 s for 7.4k lines), so it is requested on demand and
  bounded, never prefetched for the commit list.
- **No jemalloc.** Upstream links `tikv-jemallocator` for allocator throughput.
  No other service in this repository does, and the request bound caps the input
  size, so adding it would be an unusual dependency for an unmeasured gain.

## Open Items

- **Bundle size.** `harness-diff-host` is 103 MB, of which ~100 MB is tree-sitter
  parse tables in `__TEXT`, not strippable symbols (`strip = true` already
  applies; `__text` is only 5.7 MB). Verilog alone is 17 MB, F# 11 MB, Fortran
  6 MB. This roughly doubles the native payload (the box host is 80 MB).
  [NEEDS CLARIFICATION: should the language set be trimmed to the grammars this
  product actually reviews?] Dropping the large, rarely-relevant grammars
  (Verilog, VHDL, F#, Fortran, Ada, Pascal, Racket, Scheme, Common Lisp, Elisp,
  Julia, R, Erlang, Elm, Gleam, Dart, Apex, Solidity, Newick, Device Tree) is
  worth roughly half the binary and requires an arm removed per language in
  `guess_language.rs` and `tree_sitter_parser.rs`. The current build keeps every
  grammar available on crates.io.
