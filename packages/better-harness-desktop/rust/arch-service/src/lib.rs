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
    MAX_FRAME_BYTES,
};

pub const MAX_REVISION_BYTES: usize = 2 * 1024 * 1024;
const MAX_PATH_BYTES: usize = 4096;
pub const MAX_FILE_COUNT: usize = 800;
pub const MAX_FILE_BYTES: usize = 512_000;
/// How many unreadable files one reply names before it just counts them.
const MAX_SKIPPED_FILES: usize = 50;

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
            // A reply over the frame limit is a refusal, not a reason to end the
            // process: the caller asked a bounded question and deserves a bounded
            // answer, and the next request must still be served.
            Ok(value) => encode_ok(frame.id, value).or_else(|_| {
                encode_error(
                    frame.id,
                    "limit/response",
                    format!("the projection exceeds the {MAX_FRAME_BYTES} byte reply limit"),
                )
            }),
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

    // Step 8: Which declared elements the change reached without landing in them:
    // the radius a reader looks for on the diagram, not only in the count.
    let reached = arch_core::elements_owning_paths(&bindings, &overlay.impacted_files);
    let impacted_hit_ids: Vec<String> = reached
        .into_iter()
        .filter(|id| !snapshot.changed_hit_ids.contains(id))
        .collect();

    Ok(json!({
        "snapshot": snapshot,
        "dsl": dsl,
        // Per-file facts stay behind: what leaves the host is the projection and
        // what could not be read, so the reply does not grow with how many files
        // the caller sent.
        "skipped": facts
            .iter()
            .filter(|fact| !fact.diagnostics.is_empty())
            .take(MAX_SKIPPED_FILES)
            .map(|fact| json!({ "path": fact.path, "diagnostics": fact.diagnostics }))
            .collect::<Vec<_>>(),
        "skippedCount": facts.iter().filter(|fact| !fact.diagnostics.is_empty()).count(),
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
        // Elements the radius reached. The projection's own change hits are not
        // repeated here: those are the elements the commit changed.
        "impactedHitIds": impacted_hit_ids,
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
        // What crosses the wire is the projection, not the per-file facts, so a
        // reply stays bounded however many files the caller sent.
        assert_eq!(reply["result"]["graph"]["parsedFiles"], 1);
        assert_eq!(reply["result"]["skippedCount"], 0);
        assert!(reply["result"]["snapshot"]["model"]["elements"].as_array().unwrap().is_empty());
        assert!(!reply["result"]["dsl"].as_str().unwrap().is_empty());
        // The change overlay reports the impacted paths, so a caller never has
        // to read a count where the contract promises a list. Nothing called this
        // file, so the radius is empty: the changed file is the change, not its
        // own impact, and naming it here would paint an element the commit
        // changed as one it only reached.
        assert!(
            reply["result"]["overlay"]["impactedFiles"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn names_a_file_it_could_not_extract() {
        let reply = call("arch.snapshot", json!({
            "sources": [{ "path": "notes.md", "source": "# Notes\n" }],
            "tracked_paths": ["notes.md"],
        }));
        assert!(reply.get("error").is_none(), "unexpected error: {reply}");
        assert_eq!(reply["result"]["skippedCount"], 1);
        assert_eq!(reply["result"]["skipped"][0]["path"], "notes.md");
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
    fn counts_a_caller_the_commit_did_not_change_as_impacted() {
        // `api.ts` is not part of the change; it calls what is. Without a caller
        // on each call site the graph has no edge to find, and this reads 0.
        let reply = call("arch.snapshot", json!({
            "sources": [
                {
                    "path": "store.ts",
                    "source": "export function load(): number {\n  return 2;\n}\n",
                },
                {
                    "path": "api.ts",
                    "source": "import { load } from \"./store\";\nexport const read = () => load();\n",
                },
            ],
            "tracked_paths": ["store.ts", "api.ts"],
            "changed_paths": ["store.ts"],
        }));
        assert!(reply.get("error").is_none(), "unexpected error: {reply}");
        assert_eq!(reply["result"]["overlay"]["changedSymbols"], 1);
        assert_eq!(reply["result"]["overlay"]["impactedSymbols"], 1);
        assert!(reply["result"]["overlay"]["impactedFiles"]
            .as_array()
            .unwrap()
            .iter()
            .any(|path| path == "api.ts"));
    }

    #[test]
    fn names_the_elements_the_change_reached() {
        // `store.ts` is bound to `store` and changed; `api.ts` is bound to `api`,
        // unchanged, and calls it — so the radius reached `api` without landing in it.
        let reply = call("arch.snapshot", json!({
            "sources": [
                {
                    "path": "store.ts",
                    "source": "export function load(): number {\n  return 2;\n}\n",
                },
                {
                    "path": "api.ts",
                    "source": "import { load } from \"./store\";\nexport const read = () => load();\n",
                },
            ],
            "tracked_paths": ["store.ts", "api.ts"],
            "changed_paths": ["store.ts"],
            "model_json": {
                "elements": [
                    { "id": "store", "name": "Store", "kind": "Component", "description": null, "technology": null, "tags": [], "parent_id": null },
                    { "id": "api", "name": "API", "kind": "Component", "description": null, "technology": null, "tags": [], "parent_id": null },
                ],
                "relationships": [],
            },
            "bindings": [
                { "path_glob": "store.ts", "element_id": "store" },
                { "path_glob": "api.ts", "element_id": "api" },
            ],
        }));
        assert!(reply.get("error").is_none(), "unexpected error: {reply}");
        assert_eq!(reply["result"]["snapshot"]["changed_hit_ids"][0], "store");
        // The element the change reached is named, and the one it landed in is not
        // repeated: a reader has to be able to tell the two apart.
        assert_eq!(reply["result"]["impactedHitIds"], json!(["api"]));
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