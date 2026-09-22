//! Node ↔ pty-host JSONL contract (`pty-rust-1.0.0+jsonl-v1`).
//!
//! The stream is duplex: replies are correlated by request `id`, while terminal
//! output and exit arrive unsolicited as `event` frames with no `id`. That is
//! the one structural difference from the request/reply capability hosts, and
//! it is inherent to a terminal — bytes come on the child's schedule, not the
//! caller's.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const WIRE_VERSION: u32 = 1;
pub const MAX_REQUEST_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;
pub const HOST_PROTOCOL_VERSION: &str = "pty-rust-1.0.0+jsonl-v1";

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RequestFrame {
    pub version: u32,
    pub id: u32,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FrameError {
    Malformed(String),
    UnsupportedVersion(u32),
    TooLarge { bytes: usize, limit: usize },
}

impl std::fmt::Display for FrameError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Malformed(detail) => write!(f, "malformed request frame: {detail}"),
            Self::UnsupportedVersion(v) => write!(
                f,
                "request frame version {v} is not supported; this host speaks version {WIRE_VERSION}"
            ),
            Self::TooLarge { bytes, limit } => {
                write!(f, "request frame is {bytes} bytes, over the {limit} byte limit")
            }
        }
    }
}

impl std::error::Error for FrameError {}

pub fn parse_request_frame(line: &str) -> Result<RequestFrame, FrameError> {
    if line.len() > MAX_REQUEST_BYTES {
        return Err(FrameError::TooLarge {
            bytes: line.len(),
            limit: MAX_REQUEST_BYTES,
        });
    }
    let frame: RequestFrame =
        serde_json::from_str(line).map_err(|error| FrameError::Malformed(error.to_string()))?;
    if frame.version != WIRE_VERSION {
        return Err(FrameError::UnsupportedVersion(frame.version));
    }
    if frame.id == 0 {
        return Err(FrameError::Malformed("id must be a positive u32".into()));
    }
    Ok(frame)
}

#[derive(Debug, Serialize)]
struct ResponseFrame {
    version: u32,
    id: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<Value>,
}

pub fn encode_ok(id: u32, result: Value) -> String {
    encode_response(&ResponseFrame {
        version: WIRE_VERSION,
        id,
        result: Some(result),
        error: None,
    })
}

pub fn encode_error(id: u32, code: &str, message: impl Into<String>) -> String {
    encode_response(&ResponseFrame {
        version: WIRE_VERSION,
        id,
        result: None,
        error: Some(json!({ "code": code, "message": message.into() })),
    })
}

fn encode_response(frame: &ResponseFrame) -> String {
    // A response that cannot serialize is a bug, not a runtime input, so a fixed
    // fallback keeps the driver answering rather than crashing the caller.
    let mut line = serde_json::to_string(frame)
        .unwrap_or_else(|_| String::from("{\"version\":1,\"id\":0,\"error\":{\"code\":\"encode-failed\"}}"));
    line.push('\n');
    line
}

/// Serialize one unsolicited event frame (terminal output or exit).
pub fn encode_event(event: Value) -> String {
    let mut line = serde_json::to_string(&json!({ "version": WIRE_VERSION, "event": event }))
        .unwrap_or_else(|_| String::from("{\"version\":1,\"event\":{\"type\":\"encode-failed\"}}"));
    line.push('\n');
    line
}

/// `pty.data`: raw master output for one session, base64-encoded.
pub fn data_event(pty_id: u64, bytes: &[u8]) -> String {
    encode_event(json!({
        "type": "pty.data",
        "ptyId": pty_id,
        "dataBase64": base64_encode(bytes),
    }))
}

/// `pty.exit`: the child was reaped. Exactly one of `code`/`signal` is non-null.
pub fn exit_event(pty_id: u64, code: Option<i32>, signal: Option<i32>) -> String {
    encode_event(json!({
        "type": "pty.exit",
        "ptyId": pty_id,
        "code": code,
        "signal": signal,
    }))
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Standard base64 with padding. Inlined to keep the driver's dependency set to
/// what the other hosts already vet; terminal chunks are small and this is not
/// on any measured hot path.
pub fn base64_encode(input: &[u8]) -> String {
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as usize;
        let b1 = chunk.get(1).copied().unwrap_or(0) as usize;
        let b2 = chunk.get(2).copied().unwrap_or(0) as usize;
        out.push(B64[b0 >> 2] as char);
        out.push(B64[((b0 & 0x03) << 4) | (b1 >> 4)] as char);
        if chunk.len() > 1 {
            out.push(B64[((b1 & 0x0f) << 2) | (b2 >> 6)] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(B64[b2 & 0x3f] as char);
        } else {
            out.push('=');
        }
    }
    out
}

/// Decode standard base64 (padding optional, embedded whitespace rejected).
pub fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    fn value(byte: u8) -> Result<u8, String> {
        match byte {
            b'A'..=b'Z' => Ok(byte - b'A'),
            b'a'..=b'z' => Ok(byte - b'a' + 26),
            b'0'..=b'9' => Ok(byte - b'0' + 52),
            b'+' => Ok(62),
            b'/' => Ok(63),
            other => Err(format!("invalid base64 byte {other:#x}")),
        }
    }
    let trimmed: &[u8] = input.trim_end_matches('=').as_bytes();
    let mut out = Vec::with_capacity(trimmed.len() / 4 * 3);
    let mut acc: u32 = 0;
    let mut bits = 0u32;
    for &byte in trimmed {
        acc = (acc << 6) | u32::from(value(byte)?);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_wrong_version() {
        let frame = "{\"version\":2,\"id\":1,\"method\":\"host.describe\"}";
        assert!(matches!(
            parse_request_frame(frame),
            Err(FrameError::UnsupportedVersion(2))
        ));
    }

    #[test]
    fn rejects_zero_id() {
        let frame = "{\"version\":1,\"id\":0,\"method\":\"host.describe\"}";
        assert!(matches!(
            parse_request_frame(frame),
            Err(FrameError::Malformed(_))
        ));
    }

    #[test]
    fn base64_round_trips_arbitrary_bytes() {
        for case in [
            &b""[..],
            b"f",
            b"fo",
            b"foo",
            b"foob",
            b"\x00\xff\x10\x81\x7f",
        ] {
            let encoded = base64_encode(case);
            assert_eq!(base64_decode(&encoded).unwrap(), case);
        }
    }

    #[test]
    fn event_frames_are_single_lines() {
        let data = data_event(3, b"hi\n");
        assert!(data.ends_with('\n'));
        assert_eq!(data.matches('\n').count(), 1);
        let value: Value = serde_json::from_str(data.trim_end()).unwrap();
        assert_eq!(value["event"]["type"], "pty.data");
        assert_eq!(value["event"]["ptyId"], 3);
        assert_eq!(value["event"]["dataBase64"], base64_encode(b"hi\n"));
    }

    #[test]
    fn exit_event_carries_code_or_signal() {
        let value: Value =
            serde_json::from_str(exit_event(1, Some(0), None).trim_end()).unwrap();
        assert_eq!(value["event"]["code"], 0);
        assert!(value["event"]["signal"].is_null());
    }
}
