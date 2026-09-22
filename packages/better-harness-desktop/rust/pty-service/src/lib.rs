//! The pseudo-terminal capability, spoken as newline-delimited JSON.
//!
//! ```text
//!  Studio (Node) <stdio> harness-pty-host <C core> openpty/login_tty child
//! ```
//!
//! One driver hosts many PTY sessions keyed by a `ptyId` it assigns. Each
//! session owns a master fd and a child pid; a dedicated blocking reader thread
//! forwards that session's output as `pty.data` events and, on EOF, reaps the
//! child and emits one `pty.exit`. Requests (`pty.write`, `pty.resize`, …) are
//! answered on the caller's schedule; output arrives on the child's. Both share
//! the driver's single outbound stream, which is what keeps a command's bytes
//! ahead of the exit that describes them.

pub mod ffi;
pub mod wire;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::Deserialize;
use serde_json::{json, Value};

use crate::ffi::{ExitStatus, PtyProcess};
use crate::wire::{
    RequestFrame, base64_decode, data_event, encode_error, encode_ok, exit_event,
    HOST_PROTOCOL_VERSION,
};

/// A default read buffer; terminal writes are small and bursty, and this keeps
/// one screen's worth of output in a single `pty.data` event.
const READ_BUFFER_BYTES: usize = 64 * 1024;

type Sessions = Arc<Mutex<HashMap<u64, Arc<PtyProcess>>>>;

/// The driver's shared state: the live sessions and the outbound line channel
/// every reply and event is written to.
pub struct PtyHost {
    sessions: Sessions,
    next_id: AtomicU64,
    outbound: tokio::sync::mpsc::Sender<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SpawnParams {
    command: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    env: Option<HashMap<String, String>>,
    #[serde(default)]
    rows: Option<u16>,
    #[serde(default)]
    cols: Option<u16>,
    #[serde(default)]
    term: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WriteParams {
    #[serde(rename = "ptyId")]
    pty_id: u64,
    #[serde(rename = "dataBase64")]
    data_base64: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ResizeParams {
    #[serde(rename = "ptyId")]
    pty_id: u64,
    rows: u16,
    cols: u16,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SignalParams {
    #[serde(rename = "ptyId")]
    pty_id: u64,
    signal: i32,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RefParams {
    #[serde(rename = "ptyId")]
    pty_id: u64,
}

impl PtyHost {
    pub fn new(outbound: tokio::sync::mpsc::Sender<String>) -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            next_id: AtomicU64::new(1),
            outbound,
        }
    }

    /// Dispatch one parsed frame to a reply line. Errors are replies, not process
    /// failures: a bad `pty.write` costs the caller one request, not every live
    /// session.
    pub fn dispatch(&self, frame: RequestFrame) -> String {
        let id = frame.id;
        match frame.method.as_str() {
            "host.describe" => encode_ok(
                id,
                json!({
                    "protocol": HOST_PROTOCOL_VERSION,
                    "pid": std::process::id(),
                    "capabilities": ["pty.spawn", "pty.write", "pty.resize", "pty.signal", "pty.close"],
                }),
            ),
            "pty.spawn" => match parse::<SpawnParams>(&frame) {
                Ok(params) => self.spawn(id, params),
                Err(message) => encode_error(id, "bad-params", message),
            },
            "pty.write" => match parse::<WriteParams>(&frame) {
                Ok(params) => self.write(id, params),
                Err(message) => encode_error(id, "bad-params", message),
            },
            "pty.resize" => match parse::<ResizeParams>(&frame) {
                Ok(params) => self.resize(id, params),
                Err(message) => encode_error(id, "bad-params", message),
            },
            "pty.signal" => match parse::<SignalParams>(&frame) {
                Ok(params) => self.session_signal(id, params),
                Err(message) => encode_error(id, "bad-params", message),
            },
            "pty.close" => match parse::<RefParams>(&frame) {
                Ok(params) => self.close(id, params.pty_id),
                Err(message) => encode_error(id, "bad-params", message),
            },
            "shutdown" => {
                self.signal_all(libc::SIGHUP);
                encode_ok(id, json!({ "status": "shutting-down" }))
            }
            other => encode_error(id, "unknown-method", format!("unknown method {other}")),
        }
    }

    fn spawn(&self, id: u32, params: SpawnParams) -> String {
        let rows = params.rows.unwrap_or(24);
        let cols = params.cols.unwrap_or(80);
        // TERM is what a curses program keys off; injecting it means inheriting
        // (or replacing) the environment, so it forces a full env vector.
        let env = build_env(params.env, params.term.as_deref());
        let process = match PtyProcess::spawn(
            &params.command,
            &params.args,
            params.cwd.as_deref(),
            env.as_deref(),
            rows,
            cols,
        ) {
            Ok(process) => Arc::new(process),
            Err(error) => return encode_error(id, "spawn-failed", error.to_string()),
        };
        let pty_id = self.next_id.fetch_add(1, Ordering::Relaxed);
        self.sessions
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .insert(pty_id, process.clone());
        self.start_reader(pty_id, process);
        encode_ok(id, json!({ "ptyId": pty_id }))
    }

    fn write(&self, id: u32, params: WriteParams) -> String {
        let Some(process) = self.get(params.pty_id) else {
            return unknown_pty(id, params.pty_id);
        };
        let bytes = match base64_decode(&params.data_base64) {
            Ok(bytes) => bytes,
            Err(message) => return encode_error(id, "bad-params", message),
        };
        match process.write(&bytes) {
            Ok(written) => encode_ok(id, json!({ "written": written })),
            Err(error) => encode_error(id, "write-failed", error.to_string()),
        }
    }

    fn resize(&self, id: u32, params: ResizeParams) -> String {
        let Some(process) = self.get(params.pty_id) else {
            return unknown_pty(id, params.pty_id);
        };
        match process.resize(params.rows, params.cols) {
            Ok(()) => encode_ok(id, json!({ "ok": true })),
            Err(error) => encode_error(id, "resize-failed", error.to_string()),
        }
    }

    fn session_signal(&self, id: u32, params: SignalParams) -> String {
        let Some(process) = self.get(params.pty_id) else {
            return unknown_pty(id, params.pty_id);
        };
        match process.signal(params.signal) {
            Ok(()) => encode_ok(id, json!({ "ok": true })),
            Err(error) => encode_error(id, "signal-failed", error.to_string()),
        }
    }

    /// Ask the child to hang up. Removal from the registry and the `pty.exit`
    /// event are left to the reader thread, so there is one owner of teardown and
    /// no `pty.exit` can arrive for a session already forgotten.
    fn close(&self, id: u32, pty_id: u64) -> String {
        let Some(process) = self.get(pty_id) else {
            return unknown_pty(id, pty_id);
        };
        // SIGHUP mirrors closing the last terminal handle; a child that ignores
        // it keeps running, which is the child's prerogative.
        let _ = process.signal(libc::SIGHUP);
        encode_ok(id, json!({ "ok": true }))
    }

    /// Signal every live session, used by `shutdown` to hang up children before
    /// the driver leaves.
    pub fn signal_all(&self, signal: i32) {
        let processes: Vec<Arc<PtyProcess>> = self
            .sessions
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .values()
            .cloned()
            .collect();
        for process in processes {
            let _ = process.signal(signal);
        }
    }

    fn get(&self, pty_id: u64) -> Option<Arc<PtyProcess>> {
        self.sessions
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .get(&pty_id)
            .cloned()
    }

    /// One blocking reader per session. `libc::read` on the master has no async
    /// equivalent, so it runs on its own thread and forwards through the outbound
    /// channel with `blocking_send`.
    fn start_reader(&self, pty_id: u64, process: Arc<PtyProcess>) {
        let outbound = self.outbound.clone();
        let sessions = self.sessions.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; READ_BUFFER_BYTES];
            loop {
                match process.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if outbound.blocking_send(data_event(pty_id, &buf[..n])).is_err() {
                            return;
                        }
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    // On Linux a master read after the slave closes returns EIO
                    // rather than EOF; both mean the same thing here.
                    Err(_) => break,
                }
            }
            let (code, signal) = match process.wait() {
                Ok(ExitStatus::Exited(code)) => (Some(code), None),
                Ok(ExitStatus::Signaled(sig)) => (None, Some(sig)),
                Err(_) => (Some(-1), None),
            };
            let _ = outbound.blocking_send(exit_event(pty_id, code, signal));
            sessions
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .remove(&pty_id);
        });
    }
}

fn parse<T: for<'de> Deserialize<'de>>(frame: &RequestFrame) -> Result<T, String> {
    serde_json::from_value(frame.params.clone()).map_err(|error| error.to_string())
}

fn unknown_pty(id: u32, pty_id: u64) -> String {
    encode_error(id, "unknown-pty", format!("no live pty with id {pty_id}"))
}

/// Resolve the child environment.
///
/// `None` means inherit the driver's environment untouched. A caller that sets
/// `env` replaces it wholesale; a caller that sets only `term` inherits and
/// overrides `TERM`. Either way, once anything is specified the vector must be
/// complete, because the C core passes it straight to `execve`.
fn build_env(env: Option<HashMap<String, String>>, term: Option<&str>) -> Option<Vec<(String, String)>> {
    if env.is_none() && term.is_none() {
        return None;
    }
    let mut map: HashMap<String, String> = match env {
        Some(explicit) => explicit,
        None => std::env::vars().collect(),
    };
    if let Some(term) = term {
        map.insert("TERM".into(), term.into());
    }
    Some(map.into_iter().collect())
}

/// Convenience for the driver and tests: parse a request line and dispatch it.
pub fn handle_line(host: &PtyHost, line: &str) -> String {
    match crate::wire::parse_request_frame(line) {
        Ok(frame) => host.dispatch(frame),
        Err(error) => encode_error(0, "bad-frame", error.to_string()),
    }
}

/// A parsed representation of one outbound event, for tests that read the stream.
pub fn parse_event(line: &str) -> Option<Value> {
    let value: Value = serde_json::from_str(line.trim_end()).ok()?;
    value.get("event").cloned()
}
