//! Newline-delimited JSON driver for the pty host.
//!
//! Duplex, like `box-host` and unlike the request/reply capability hosts:
//! terminal output arrives on the child's schedule, so replies and `pty.data`
//! events share one outbound queue. Sharing it is what keeps a command's output
//! ahead of the `pty.exit` that describes it.

use std::process::ExitCode;
use std::sync::Arc;

use harness_pty_service::wire::parse_request_frame;
use harness_pty_service::PtyHost;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

/// Bound on queued outbound lines. Finite so a child that prints faster than
/// Studio reads throttles the reader thread instead of growing this process.
const OUTBOUND_CAPACITY: usize = 4096;

/// How long the writer gets to flush after the last request.
const FLUSH_GRACE: std::time::Duration = std::time::Duration::from_secs(3);

#[tokio::main(flavor = "current_thread")]
async fn main() -> ExitCode {
    let (outbound, mut queue) = mpsc::channel::<String>(OUTBOUND_CAPACITY);
    let writer = tokio::spawn(async move {
        let mut out = tokio::io::stdout();
        while let Some(line) = queue.recv().await {
            if out.write_all(line.as_bytes()).await.is_err() || out.flush().await.is_err() {
                return;
            }
        }
    });

    let host = Arc::new(PtyHost::new(outbound.clone()));
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let frame = match parse_request_frame(trimmed) {
            Ok(frame) => frame,
            Err(error) => {
                eprintln!("[pty-host] {error}");
                return ExitCode::FAILURE;
            }
        };
        let shutting_down = frame.method == "shutdown";
        // Dispatch is non-blocking: it spawns reader threads but never waits on
        // one, so answering on this task cannot stall the input loop.
        let reply = host.dispatch(frame);
        if outbound.send(reply).await.is_err() {
            break;
        }
        if shutting_down {
            break;
        }
    }

    // Reader threads hold outbound senders too; dropping this one lets the writer
    // drain and finish once every session has ended. Bound the wait so a child
    // that ignored SIGHUP cannot keep the driver alive forever.
    drop(outbound);
    let _ = tokio::time::timeout(FLUSH_GRACE, writer).await;
    ExitCode::SUCCESS
}
