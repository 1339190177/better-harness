# PTY Terminal Driver (C core)

A native pseudo-terminal driver that runs a child command under a real TTY and
streams its byte output, resize, and exit as a duplex newline-delimited JSON
stream. It is the first D3 "Terminal/TUI driver" implementation for the harness
drive-plane ladder, and the first native capability whose hot path is a
continuous byte stream rather than a single request/reply.

## Traceability

- Spec ID: SPEC-2026-09-22-pty-terminal-driver
- Status: Proposed (POC)

## Intent

Interactive and TUI coding agents behave differently — or refuse to start —
when their stdio is a pipe rather than a terminal. Every current native path in
this repository spawns children with `stdio: ["pipe","pipe","pipe"]`
([acp-sdk.ts](../../packages/harness/src/exec/acp-sdk.ts),
[acp-rust.ts](../../packages/harness/src/exec/acp-rust.ts)), so no harness plane
can observe a program that needs `isatty()` to be true. A PTY driver closes that
gap and, because a terminal session is inherently a timed byte stream, it
produces a structured step trace (bytes, timing, resize, exit) suitable for
offline failure localization — the judging criterion named in
[ui-and-system-drivers.md](../../references/project-harness/ui-and-system-drivers.md).

This spec covers a **proof-of-concept** scoped to value verification. It builds
the C PTY core and a stdio JSONL driver, and a Node harness that compares a
command's behavior with and without a TTY. It deliberately does **not** wire the
driver into the Studio server, add the NSXPC macOS bundle, or ship it in an
installer; those belong to a follow-up once the value is proven.

## Non-goals

- Windows ConPTY support (POSIX `openpty`/`login_tty` only for the POC).
- NSXPC transport bundle, code signing, and Studio provider wiring.
- Terminal emulation / screen buffer parsing (the driver forwards raw bytes;
  interpretation is the reader's job).
- A UI surface in Harness Studio or the desktop renderer.

## Wire contract (`pty-rust-1.0.0+jsonl-v1`)

One driver process hosts many PTY sessions keyed by a `ptyId` it assigns. The
stream is duplex: replies are correlated by request `id`; PTY output and exit
arrive unsolicited as `event` frames. All request and reply frames carry
`"version": 1`.

Requests (`{"version":1,"id":<u32>,"method":...,"params":{...}}`):

- `host.describe` → `{ protocol, pid, capabilities }`
- `pty.spawn` `{ command, args?, cwd?, env?, rows?, cols?, term? }` → `{ ptyId }`
- `pty.write` `{ ptyId, dataBase64 }` → `{ written }`
- `pty.resize` `{ ptyId, rows, cols }` → `{ ok: true }`
- `pty.signal` `{ ptyId, signal }` (POSIX signal number) → `{ ok: true }`
- `pty.close` `{ ptyId }` → `{ ok: true }` (sends `SIGHUP`, closes the master)
- `shutdown` → closes every session and exits

Events (`{"version":1,"event":{...}}`, no `id`):

- `{ type: "pty.data", ptyId, dataBase64 }` — raw master output, base64-encoded
- `{ type: "pty.exit", ptyId, code, signal }` — child reaped; `code` is the
  exit status when it exited normally, `signal` the POSIX signal otherwise (the
  other is `null`)

Errors are replies (`{ id, error: { code, message } }`), never process
failures: a bad `pty.write` costs the caller one request, not every live
session. Refusal codes: `bad-params`, `unknown-pty`, `spawn-failed`,
`unknown-method`.

## Acceptance scenarios

- AC1 `host.describe` reports protocol `pty-rust-1.0.0+jsonl-v1` and lists the
  `pty.*` capabilities.
- AC2 `pty.spawn` of a command that checks `isatty(1)` observes a terminal
  (e.g. `test -t 1` exits 0; `tty` prints a device path), whereas the same
  command spawned with piped stdio does not.
- AC3 Bytes written with `pty.write` are echoed back as `pty.data` events by a
  line-discipline default `cat`, proving the master/slave round-trip.
- AC4 `pty.resize` changes the winsize a child reads back (`stty size` reports
  the new rows/cols).
- AC5 When the child exits, exactly one `pty.exit` event carries its code or
  signal, after all preceding `pty.data`.
- AC6 An unknown `ptyId` on any session method returns an `unknown-pty` refusal
  and the driver keeps serving other sessions.

## Plan / tasks

- C core `pty-core.c`: `harness_pty_spawn` (openpty + fork + `login_tty` +
  optional `chdir` + `execvp`/`execve`) and `harness_pty_resize`
  (`ioctl(TIOCSWINSZ)`), compiled via the `cc` crate on unix in `build.rs`.
- Rust FFI wrapper `ffi.rs` around the C core; master I/O, `waitpid` reaping,
  and `kill` via `libc`.
- `wire.rs`: frame parse/encode plus event encoders.
- `lib.rs`: session registry and `dispatch`, emitting events on a channel.
- `main.rs`: tokio duplex driver (a reader thread per session forwards output;
  the outbound channel serializes replies and events).
- Node POC harness `scripts/pty-poc.mjs`: runs the built `harness-pty-host`,
  drives a command through it, records a JSONL step trace, and prints the
  TTY-vs-pipe difference.

## Test / review evidence

- Rust: `cargo +1.96.0 test` in `rust/pty-service` covers wire round-trips and a
  spawn→echo→exit integration path (AC1–AC6).
- Manual: `node scripts/pty-poc.mjs -- <command>` produces the trace and the
  side-by-side TTY difference.
- Build: added to `scripts/rust.mjs` as a POSIX-only compile+test target; not
  staged, not bundled, not consumed by Studio.
