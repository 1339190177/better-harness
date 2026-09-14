//! The driver binary, exercised the way Studio will use it: one process, many
//! newline-delimited frames, replies correlated by id.
//!
//! Asserting on the real binary rather than `handle_line` is what proves the
//! framing, the flush-per-reply, and the shutdown-on-`shutdown` behaviour the
//! Node provider depends on.

use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};

struct Driver {
    child: std::process::Child,
    stdin: std::process::ChildStdin,
    stdout: BufReader<std::process::ChildStdout>,
}

impl Driver {
    fn start() -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_harness-diff-host"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("the diff host should start");
        let stdin = child.stdin.take().unwrap();
        let stdout = BufReader::new(child.stdout.take().unwrap());
        Self {
            child,
            stdin,
            stdout,
        }
    }

    fn call(&mut self, frame: &str) -> serde_json::Value {
        self.stdin.write_all(frame.as_bytes()).unwrap();
        self.stdin.write_all(b"\n").unwrap();
        self.stdin.flush().unwrap();
        let mut line = String::new();
        assert!(
            self.stdout.read_line(&mut line).unwrap() > 0,
            "the diff host closed its output early"
        );
        serde_json::from_str(line.trim_end()).expect("every reply is one JSON document")
    }
}

fn request(id: u32, method: &str, params: &str) -> String {
    format!(r#"{{"version":1,"id":{id},"method":"{method}","params":{params}}}"#)
}

#[test]
fn answers_frames_in_order_and_correlates_them_by_id() {
    let mut driver = Driver::start();

    let described = driver.call(&request(1, "host.describe", "{}"));
    assert_eq!(described["id"], 1);
    assert!(described["result"]["pid"].as_u64().unwrap() > 0);

    let diffed = driver.call(&request(
        2,
        "diff.structural",
        r#"{"path":"value.js","before":"const v = compute(1, 2);\n","after":"const v = compute(1, 2, 3);\n"}"#,
    ));
    assert_eq!(diffed["id"], 2);
    assert_eq!(diffed["result"]["status"], "changed");
    assert_eq!(diffed["result"]["lines"][0]["rhs"]["lineNumber"], 1);

    // A second request proves the host stays usable after a real diff.
    let again = driver.call(&request(
        3,
        "diff.structural",
        r#"{"path":"value.js","before":"same\n","after":"same\n"}"#,
    ));
    assert_eq!(again["id"], 3);
    assert_eq!(again["result"]["status"], "unchanged");

    let shutdown = driver.call(&request(4, "shutdown", "{}"));
    assert_eq!(shutdown["result"]["status"], "shutting-down");
    assert!(driver.child.wait().unwrap().success());
}

#[test]
fn an_oversized_request_ends_the_host_rather_than_leaving_it_half_written() {
    // The frame limit is enforced while reading, so the host must not attempt
    // to answer a frame it never finished reading.
    let mut driver = Driver::start();
    let padding = "x".repeat(4 * 1024 * 1024 + 64);
    let frame = request(1, "host.describe", &format!(r#"{{"pad":"{padding}"}}"#));
    let _ = driver.stdin.write_all(frame.as_bytes());
    let _ = driver.stdin.write_all(b"\n");
    let _ = driver.stdin.flush();

    let mut line = String::new();
    let _ = driver.stdout.read_line(&mut line);
    assert!(!driver.child.wait().unwrap().success());
}
