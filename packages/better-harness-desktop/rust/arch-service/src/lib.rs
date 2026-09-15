//! The architecture-snapshot capability, spoken as newline-delimited JSON.
//!
//! ```text
//!  Studio (Node)                 launchd service
//!  ────────────                  ──────────────
//!  harness-arch-client <NSXPC> harness-arch-xpc <stdio> harness-arch-host <in-process> arch-core
//! ```

pub mod wire;

#[cfg(target_os = "macos")]
pub mod xpc;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::wire::{
    encode_error, encode_ok, parse_request_frame, RequestFrame, HOST_PROTOCOL_VERSION,
};

pub const MAX_REVISION_BYTES: usize = 2 * 1024 * 1024;
const MAX_PATH_BYTES: usize = 4096;
pub const MAX_FILE_COUNT: usize = 800;
pub const MAX_FILE_BYTES: usize = 512_000;

/// Common refusal type.
struct Refusal {
    code: &'static str,
    message: String,
}

impl Refusal {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
}

/// Params for `arch.snapshot`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SnapshotParams {
    /// Changed file contents (source) for fact extraction.
    sources: Vec<SourceEntry>,
    /// Full tracked path list for import resolution.
    tracked_paths: Vec<String>,
    /// Changed paths for overlay marking (subset of sources).
    #[serde(default)]
    changed_paths: Vec<String>,
    /// Declared model DSL text or JSON.
    #[serde(default)]
    model_dsl: String,
    /// Declared model as workspace JSON.
    #[serde(default)]
    model_json: Option<Value>,
    /// Source bindings.
    #[serde(default)]
    bindings: Vec<BindingEntry>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SourceEntry {
    path: String,
    source: String,
}

#[derive(Deserialize)]
struct BindingEntry {
    path_glob: String,
    element_id: String,
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
                "capabilities": ["arch.snapshot"],
            }),
        ),
        "arch.snapshot" => match snapshot(&frame.params) {
            Ok(value) => encode_ok(frame.id, value),
            Err(refusal) => encode_error(frame.id, refusal.code, refusal.message),
        },
        "shutdown" => encode_ok(frame.id, json!({ "status": "shutting-down" })),
        other => encode_error(frame.id, "unknown-method", format!("unknown method {other}")),
    }
}

/// Execute `arch.snapshot`: extract facts, build graph, project onto model.
fn snapshot(params: &Value) -> Result<Value, Refusal> {
    let request: SnapshotParams = serde_json::from_value(params.clone())
        .map_err(|error| Refusal::new("invalid-params", error.to_string()))?;

    if request.sources.len() > MAX_FILE_COUNT {
        return Err(Refusal::new("limit/files", format!("too many source files: {} > {}", request.sources.len(), MAX_FILE_COUNT)));
    }

    // Validate paths
    for entry in &request.sources {
        if entry.path.is_empty() || entry.path.len() > MAX_PATH_BYTES || entry.path.contains('\0') {
            return Err(Refusal::new("invalid-path", "path is empty, too long, or contains a NUL byte"));
        }
        if entry.source.len() > MAX_FILE_BYTES {
            return Err(Refusal::new("limit/source", format!("source file {} exceeds {} bytes", entry.path, MAX_FILE_BYTES)));
        }
    }

    // Step 1: Extract facts from each source file
    let mut facts = Vec::new();
    for entry in &request.sources {
        let fact = arch_core::extract_file_facts(&entry.path, &entry.source);
        facts.push(fact);
    }

    // Step 2: Build symbol graph from extracted facts
    let limits = arch_core::CodeGraphLimits {
        max_files: MAX_FILE_COUNT,
        max_bytes: MAX_FILE_BYTES,
    };
    let graph = arch_core::build_graph(
        &facts,
        &request.changed_paths,
        &request.tracked_paths,
        &limits,
    );

    // Step 3: Build model from DSL or JSON
    let model = build_model(&request.model_dsl, &request.model_json)?;

    // Step 4: Build bindings
    let bindings: Vec<arch_core::SourceBinding> = request.bindings.iter().map(|b| arch_core::SourceBinding {
        path_glob: b.path_glob.clone(),
        element_id: b.element_id.clone(),
    }).collect();

    // Step 5: Project onto model
    let snapshot = arch_core::project_snapshot(
        &model,
        &bindings,
        &facts,
        &graph,
        &request.changed_paths,
    );

    // Step 6: Generate DSL
    let dsl = arch_core::emit_dsl(&snapshot);

    // Step 7: Compute change overlay
    let overlay = arch_core::compute_change_overlay(
        &request.changed_paths,
        &graph,
    );

    Ok(json!({
        "snapshot": snapshot,
        "dsl": dsl,
        "facts": facts,
        "graph": {
            "parsedFiles": graph.parsed_files,
            "truncated": graph.truncated,
            "edges": graph.forward_edges.len(),
        },
        "overlay": {
            "changedSymbols": overlay.changed_symbols.len(),
            "impactedSymbols": overlay.impacted_symbols.len(),
            // Paths, not a count: the Studio contract carries the impacted file
            // list so a reader can see where the change reached.
            "impactedFiles": &overlay.impacted_files,
        },
    }))
}

/// Build `ArchitectureModel` from DSL text or JSON.
///
/// A declared model that cannot be read is a refusal, never an empty model:
/// answering an empty projection would present "this project declares no
/// boundaries" as the finding, which is the one answer that must not be invented.
fn build_model(dsl: &str, json: &Option<Value>) -> Result<arch_core::ArchitectureModel, Refusal> {
    if let Some(value) = json {
        return serde_json::from_value::<arch_core::ArchitectureModel>(value.clone())
            .map_err(|error| Refusal::new("invalid-model", format!("declared model cannot be read: {error}")));
    }
    if !dsl.trim().is_empty() {
        return Err(Refusal::new(
            "unreadable-model",
            "a Structurizr DSL model is not readable by this host; supply the arch-core model JSON",
        ));
    }
    Ok(arch_core::ArchitectureModel {
        elements: vec![],
        relationships: vec![],
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

    #[test]
    fn describe_names_capabilities() {
        let reply = call("host.describe", json!({}));
        assert_eq!(reply["result"]["protocol"], HOST_PROTOCOL_VERSION);
        assert_eq!(reply["result"]["capabilities"][0], "arch.snapshot");
        assert!(reply["result"]["pid"].as_u64().unwrap() > 0);
    }

    #[test]
    fn snapshot_on_js_source_returns_facts_and_graph() {
        let reply = call("arch.snapshot", json!({
            "sources": [{
                "path": "/test.js",
                "source": "import { createHash } from 'node:crypto';\nexport function main() { return createHash('sha256'); }\n"
            }],
            "tracked_paths": ["/test.js"],
            "changed_paths": ["/test.js"],
        }));
        assert!(reply.get("error").is_none(), "unexpected error: {reply}");
        assert_eq!(reply["result"]["facts"][0]["imports"].as_array().unwrap().len(), 1);
        assert!(reply["result"]["snapshot"]["model"]["elements"].as_array().unwrap().is_empty());
        assert!(!reply["result"]["dsl"].as_str().unwrap().is_empty());
        // The change overlay reports the impacted paths, so a caller never has
        // to read a count where the contract promises a list.
        assert_eq!(
            reply["result"]["overlay"]["impactedFiles"].as_array().unwrap(),
            &vec![serde_json::json!("/test.js")]
        );
    }

    #[test]
    fn unknown_method_is_reported() {
        let reply = call("nope", json!({}));
        assert_eq!(reply["error"]["code"], "unknown-method");
    }

    #[test]
    fn projects_a_change_onto_the_declared_model() {
        let reply = call("arch.snapshot", json!({
            "sources": [{
                "path": "packages/studio/src/a.ts",
                "source": "export function run(): number {\n  return 1;\n}\n",
            }],
            "tracked_paths": ["packages/studio/src/a.ts"],
            "changed_paths": ["packages/studio/src/a.ts"],
            "model_json": {
                "elements": [{
                    "id": "studio",
                    "name": "Studio",
                    "kind": "Container",
                    "description": null,
                    "technology": null,
                    "tags": [],
                    "parent_id": null,
                }],
                "relationships": [],
            },
            "bindings": [{ "path_glob": "packages/studio/**", "element_id": "studio" }],
        }));
        assert!(reply.get("error").is_none(), "unexpected error: {reply}");
        assert_eq!(reply["result"]["snapshot"]["model"]["elements"][0]["id"], "studio");
        // The binding is what turns a changed file into a marked boundary.
        assert_eq!(reply["result"]["snapshot"]["changed_hit_ids"][0], "studio");
        assert_eq!(reply["result"]["overlay"]["changedSymbols"], 1);
    }

    #[test]
    fn refuses_a_declared_model_it_cannot_read() {
        // An unreadable model must not come back as an empty projection: a
        // reader would take that for "this commit crosses no boundary".
        let reply = call("arch.snapshot", json!({
            "sources": [],
            "tracked_paths": [],
            "model_json": { "elements": "not an array", "relationships": [] },
        }));
        assert_eq!(reply["error"]["code"], "invalid-model");

        let dsl = call("arch.snapshot", json!({
            "sources": [],
            "tracked_paths": [],
            "model_dsl": "workspace {}",
        }));
        assert_eq!(dsl["error"]["code"], "unreadable-model");
    }

    #[test]
    fn rejects_oversized_source() {
        let oversized = "x".repeat(MAX_FILE_BYTES + 1);
        let reply = call("arch.snapshot", json!({
            "sources": [{ "path": "/big.js", "source": oversized }],
            "tracked_paths": [],
        }));
        assert_eq!(reply["error"]["code"], "limit/source");
    }
}