//! The structural-diff capability, spoken as newline-delimited JSON.
//!
//! ```text
//!  Studio (Node)                 launchd service
//!  ────────────                  ──────────────
//!  harness-diff-client <NSXPC> harness-diff-xpc <stdio> harness-diff-host <in-process> difftastic-core
//! ```
//!
//! The host owns the contract. `difftastic_core` returns a self-contained
//! result whose lines already carry their own text, so nothing here has to
//! translate offsets and the client never needs a second copy of the file.

pub mod wire;

#[cfg(target_os = "macos")]
pub mod xpc;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::wire::{
    encode_error, encode_ok, parse_request_frame, RequestFrame, HOST_PROTOCOL_VERSION,
};

/// The largest single revision this host will accept.
///
/// The engine has its own byte limit, but that is a fallback rather than a
/// budget: a structural diff of a very large file is slow enough that the
/// request should be refused before any of it is parsed. The bound is applied
/// per revision, so a caller cannot smuggle size in through the other side.
pub const MAX_REVISION_BYTES: usize = 2 * 1024 * 1024;

/// Longest accepted path. The path is language detection input, never opened.
const MAX_PATH_BYTES: usize = 4096;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DiffParams {
    path: String,
    before: String,
    after: String,
}

/// A refusal that is the caller's fault, carrying a stable code.
struct Refusal {
    code: &'static str,
    message: String,
}

impl Refusal {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

pub fn handle_line(line: &str) -> Result<String, String> {
    let frame = parse_request_frame(line).map_err(|error| error.to_string())?;
    dispatch(&frame)
}

fn dispatch(frame: &RequestFrame) -> Result<String, String> {
    match frame.method.as_str() {
        "host.describe" => encode_ok(
            frame.id,
            json!({
                "protocol": HOST_PROTOCOL_VERSION,
                "pid": std::process::id(),
                "capabilities": ["diff.structural"],
                "maxRevisionBytes": MAX_REVISION_BYTES,
            }),
        ),
        "diff.structural" => match structural(&frame.params) {
            Ok(value) => encode_ok(frame.id, value),
            Err(refusal) => encode_error(frame.id, refusal.code, refusal.message),
        },
        "shutdown" => encode_ok(frame.id, json!({ "status": "shutting-down" })),
        other => encode_error(
            frame.id,
            "unknown-method",
            format!("unknown method {other}"),
        ),
    }
}

fn structural(params: &Value) -> Result<Value, Refusal> {
    let request: DiffParams = serde_json::from_value(params.clone())
        .map_err(|error| Refusal::new("invalid-params", error.to_string()))?;
    if request.path.is_empty() || request.path.len() > MAX_PATH_BYTES || request.path.contains('\0')
    {
        return Err(Refusal::new(
            "invalid-path",
            "path is empty, too long, or contains a NUL byte",
        ));
    }
    for (side, revision) in [("before", &request.before), ("after", &request.after)] {
        if revision.len() > MAX_REVISION_BYTES {
            return Err(Refusal::new(
                "limit/revision",
                format!(
                    "the {side} revision is {} bytes, over the {MAX_REVISION_BYTES} byte limit",
                    revision.len()
                ),
            ));
        }
    }

    let diff = difftastic_core::structural_diff(&request.path, &request.before, &request.after);
    Ok(json!({
        "language": diff.language,
        "status": diff.status,
        "lines": diff.lines.iter().map(|line| json!({
            "lhs": line.lhs.as_ref().map(encode_side),
            "rhs": line.rhs.as_ref().map(encode_side),
        })).collect::<Vec<Value>>(),
    }))
}

fn encode_side(side: &difftastic_core::StructuralSide) -> Value {
    json!({
        "lineNumber": side.line_number,
        "segments": side.segments.iter().map(|segment| json!({
            "text": segment.text,
            "novel": segment.novel,
            "highlight": segment.highlight,
        })).collect::<Vec<Value>>(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(method: &str, params: Value) -> Value {
        let request = json!({ "version": 1, "id": 7, "method": method, "params": params });
        let reply = handle_line(&request.to_string()).unwrap();
        serde_json::from_str(reply.trim_end()).unwrap()
    }

    fn diff(path: &str, before: &str, after: &str) -> Value {
        call(
            "diff.structural",
            json!({ "path": path, "before": before, "after": after }),
        )
    }

    #[test]
    fn describe_names_the_capability_and_the_revision_bound() {
        let reply = call("host.describe", json!({}));

        assert_eq!(reply["result"]["protocol"], HOST_PROTOCOL_VERSION);
        assert_eq!(reply["result"]["capabilities"][0], "diff.structural");
        assert_eq!(reply["result"]["maxRevisionBytes"], MAX_REVISION_BYTES);
        assert!(reply["result"]["pid"].as_u64().unwrap() > 0);
    }

    #[test]
    fn a_structural_request_answers_with_self_contained_lines() {
        let reply = diff("greeting.js", "const a = \"hello\";\n", "const a = \"hi\";\n");

        assert!(reply.get("error").is_none(), "unexpected error: {reply}");
        let result = &reply["result"];
        assert_eq!(result["status"], "changed");
        assert_eq!(result["language"], "JavaScript");
        let line = &result["lines"][0];
        assert_eq!(line["lhs"]["lineNumber"], 1);
        assert_eq!(line["rhs"]["lineNumber"], 1);
        // The novel run arrives as text, so the client never slices offsets.
        let novel: Vec<&str> = line["rhs"]["segments"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|segment| segment["novel"] == true)
            .map(|segment| segment["text"].as_str().unwrap())
            .collect();
        assert_eq!(novel, vec!["\"hi\""]);
    }

    #[test]
    fn an_absent_side_is_null_rather_than_missing() {
        let reply = diff("added.js", "", "one\ntwo\n");

        let result = &reply["result"];
        assert_eq!(result["status"], "created");
        assert_eq!(result["lines"].as_array().unwrap().len(), 2);
        for line in result["lines"].as_array().unwrap() {
            assert!(line["lhs"].is_null());
            assert!(line["rhs"]["lineNumber"].as_u64().unwrap() >= 1);
        }
    }

    #[test]
    fn a_revision_over_the_bound_is_refused_before_the_engine_runs() {
        let oversized = "x".repeat(MAX_REVISION_BYTES + 1);
        let reply = diff("big.js", &oversized, "small\n");

        assert_eq!(reply["error"]["code"], "limit/revision");
        assert!(reply["error"]["message"]
            .as_str()
            .unwrap()
            .contains("before revision"));
    }

    #[test]
    fn an_empty_path_is_refused() {
        let reply = diff("", "a\n", "b\n");

        assert_eq!(reply["error"]["code"], "invalid-path");
    }

    #[test]
    fn missing_parameters_are_a_call_error_not_a_process_fault() {
        let reply = call("diff.structural", json!({ "path": "a.js" }));

        assert_eq!(reply["error"]["code"], "invalid-params");
        assert_eq!(reply["id"], 7);
    }

    #[test]
    fn unknown_methods_and_bad_envelopes_are_reported_not_crashed_on() {
        assert_eq!(call("nope", json!({}))["error"]["code"], "unknown-method");
        let error = parse_request_frame(r#"{"version":1,"id":1,"method":"host.describe","x":1}"#)
            .unwrap_err();
        assert!(error.to_string().contains("malformed"));
    }

    #[test]
    fn transport_proof_names_distinct_pids() {
        let line = crate::wire::transport_proof(10, 11);
        let value: Value = serde_json::from_str(line.trim()).unwrap();
        assert_eq!(value["event"]["transport"], "nsxpc");
        assert_eq!(value["event"]["servicePid"], 10);
        assert_eq!(value["event"]["bridgePid"], 11);
        assert_ne!(value["event"]["servicePid"], value["event"]["bridgePid"]);
    }
}
