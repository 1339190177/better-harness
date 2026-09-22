//! Integration coverage for the pty host: spawn, TTY presence, echo round-trip,
//! resize, exit reporting, and unknown-session refusal. POSIX only, matching the
//! driver's own platform gate.

#![cfg(unix)]

use std::time::Duration;

use harness_pty_service::wire::{base64_decode, base64_encode};
use harness_pty_service::{handle_line, parse_event, PtyHost};
use serde_json::{json, Value};
use tokio::sync::mpsc;

/// Drive one request line and return its reply as parsed JSON.
///
/// `dispatch` returns the reply synchronously, so the reply never travels the
/// outbound stream; that stream carries only unsolicited `pty.*` events, which
/// the event collectors below read separately.
fn call(host: &PtyHost, method: &str, params: Value) -> Value {
    let line = json!({ "version": 1, "id": 1, "method": method, "params": params }).to_string();
    let reply = handle_line(host, &line);
    serde_json::from_str::<Value>(reply.trim_end()).unwrap()
}

/// Collect a session's output until its `pty.exit`, returning the concatenated
/// bytes and the exit event. Fails the test on timeout.
async fn drain_until_exit(rx: &mut mpsc::Receiver<String>, pty_id: u64) -> (Vec<u8>, Value) {
    let mut output = Vec::new();
    loop {
        let line = tokio::time::timeout(Duration::from_secs(10), rx.recv())
            .await
            .expect("timed out waiting for a pty event")
            .expect("outbound channel closed before pty.exit");
        let Some(event) = parse_event(&line) else {
            continue; // a reply, not an event
        };
        if event["ptyId"].as_u64() != Some(pty_id) {
            continue;
        }
        match event["type"].as_str() {
            Some("pty.data") => {
                let encoded = event["dataBase64"].as_str().unwrap_or_default();
                output.extend(base64_decode(encoded).expect("valid base64"));
            }
            Some("pty.exit") => return (output, event),
            _ => {}
        }
    }
}

/// Read the next `pty.data` chunk for a session, ignoring replies. Used when the
/// child stays alive (no exit to wait for).
async fn next_data(rx: &mut mpsc::Receiver<String>, pty_id: u64) -> Vec<u8> {
    loop {
        let line = tokio::time::timeout(Duration::from_secs(10), rx.recv())
            .await
            .expect("timed out waiting for pty.data")
            .expect("outbound channel closed");
        let Some(event) = parse_event(&line) else { continue };
        if event["ptyId"].as_u64() == Some(pty_id) && event["type"] == "pty.data" {
            let encoded = event["dataBase64"].as_str().unwrap_or_default();
            return base64_decode(encoded).expect("valid base64");
        }
    }
}

fn spawn_id(reply: &Value) -> u64 {
    reply["result"]["ptyId"].as_u64().expect("spawn returned a ptyId")
}

#[tokio::test]
async fn describe_names_capabilities() {
    let (tx, _rx) = mpsc::channel(64);
    let host = PtyHost::new(tx);
    let reply = call(&host, "host.describe", json!({}));
    assert_eq!(reply["result"]["protocol"], "pty-rust-1.0.0+jsonl-v1");
    let caps = reply["result"]["capabilities"].as_array().unwrap();
    assert!(caps.iter().any(|c| c == "pty.spawn"));
    assert!(reply["result"]["pid"].as_u64().unwrap() > 0);
}

#[tokio::test]
async fn child_sees_a_controlling_tty() {
    let (tx, mut rx) = mpsc::channel(256);
    let host = PtyHost::new(tx);
    // `tty` prints the terminal device path and exits 0 when stdin is a tty.
    let reply = call(
        &host,
        "pty.spawn",
        json!({ "command": "/bin/sh", "args": ["-c", "tty"] }),
    );
    let pty_id = spawn_id(&reply);
    let (output, exit) = drain_until_exit(&mut rx, pty_id).await;
    let text = String::from_utf8_lossy(&output);
    assert!(text.contains("/dev/"), "expected a tty device path, got: {text:?}");
    assert_eq!(exit["code"], 0, "tty should exit 0 under a real terminal");
}

#[tokio::test]
async fn master_echoes_written_bytes() {
    let (tx, mut rx) = mpsc::channel(256);
    let host = PtyHost::new(tx);
    // `cat` with the default line discipline echoes input back on the master.
    let reply = call(&host, "pty.spawn", json!({ "command": "/bin/cat" }));
    let pty_id = spawn_id(&reply);

    let written = call(
        &host,
        "pty.write",
        json!({ "ptyId": pty_id, "dataBase64": base64_encode(b"ping\n") }),
    );
    assert_eq!(written["result"]["written"], 5);

    // The terminal echoes the typed line and cat prints it back; either way the
    // bytes we sent must surface as output.
    let mut seen = Vec::new();
    while !String::from_utf8_lossy(&seen).contains("ping") {
        seen.extend(next_data(&mut rx, pty_id).await);
    }

    // Close the session and confirm it reaps.
    call(&host, "pty.close", json!({ "ptyId": pty_id }));
    let (_output, exit) = drain_until_exit(&mut rx, pty_id).await;
    assert!(exit["type"] == "pty.exit");
}

#[tokio::test]
async fn resize_changes_winsize() {
    let (tx, mut rx) = mpsc::channel(256);
    let host = PtyHost::new(tx);
    // Block on a read first so the resize lands before `stty size` runs.
    let reply = call(
        &host,
        "pty.spawn",
        json!({ "command": "/bin/sh", "args": ["-c", "read x; stty size"], "rows": 24, "cols": 80 }),
    );
    let pty_id = spawn_id(&reply);

    let resized = call(
        &host,
        "pty.resize",
        json!({ "ptyId": pty_id, "rows": 40, "cols": 100 }),
    );
    assert_eq!(resized["result"]["ok"], true);

    // Unblock the read so the shell proceeds to `stty size`.
    call(
        &host,
        "pty.write",
        json!({ "ptyId": pty_id, "dataBase64": base64_encode(b"go\n") }),
    );

    let (output, _exit) = drain_until_exit(&mut rx, pty_id).await;
    let text = String::from_utf8_lossy(&output);
    assert!(text.contains("40 100"), "expected resized winsize, got: {text:?}");
}

#[tokio::test]
async fn exit_reports_status_code() {
    let (tx, mut rx) = mpsc::channel(64);
    let host = PtyHost::new(tx);
    let reply = call(
        &host,
        "pty.spawn",
        json!({ "command": "/bin/sh", "args": ["-c", "exit 7"] }),
    );
    let pty_id = spawn_id(&reply);
    let (_output, exit) = drain_until_exit(&mut rx, pty_id).await;
    assert_eq!(exit["code"], 7);
    assert!(exit["signal"].is_null());
}

#[tokio::test]
async fn unknown_pty_is_a_refusal_not_a_crash() {
    let (tx, _rx) = mpsc::channel(64);
    let host = PtyHost::new(tx);
    let reply = call(
        &host,
        "pty.write",
        json!({ "ptyId": 4242, "dataBase64": base64_encode(b"x") }),
    );
    assert_eq!(reply["error"]["code"], "unknown-pty");
    // The host still answers afterward.
    let describe = call(&host, "host.describe", json!({}));
    assert_eq!(describe["result"]["protocol"], "pty-rust-1.0.0+jsonl-v1");
}
