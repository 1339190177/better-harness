# Vendored third-party software

## difftastic

- Source: https://github.com/wilfred/difftastic
- Revision: `40de92908fe370e7eedb7eb7c1b7b98e286ac938` (v0.71.0)
- License: MIT (see `LICENSE`)

`src/` and `vendored_parsers/highlights/` are copied from that revision. This
copy is built as a library rather than a binary. The only additions are:

- `src/bridge.rs`, the stable surface `harness-diff-service` calls.
- A `[lib]` target in `Cargo.toml`, and the removal of the process-global
  allocator and the compiled-out CLI entrypoint in `src/lib.rs` (formerly
  `main.rs`).
- `env!("CARGO_PKG_NAME")` in place of the bin-only `env!("CARGO_BIN_NAME")`.
- `display::json::file_value`, a `pub(crate)` accessor over the existing
  serializer.

The `Janet`, `Kotlin`, `LaTeX`, and `Smali` languages are removed, along with
the C grammar sources upstream vendors for them. Adding one back requires its
grammar source and the corresponding arms in `src/parse/guess_language.rs` and
`src/parse/tree_sitter_parser.rs`.

Engine behaviour is otherwise unchanged. See
`docs/specs/2026-09-14-structural-commit-diff.md`.
