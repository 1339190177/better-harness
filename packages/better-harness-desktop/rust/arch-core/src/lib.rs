//! Architecture facts, graph, and C4 projection.
//!
//! This crate is the reusable Rust core for architecture-level code analysis.
//! It has no filesystem access: callers supply file content and tracked paths.
//!
//! # Layers
//!
//! | Module | Purpose |
//! |---|---|
//! | `facts` | OXC-based per-file fact extraction (symbols, imports, call sites) |
//! | `graph` | Module index, import resolution, symbol graph, impact radius |
//! | `project` | Declared model (`ArchitectureModel`) + source bindings → snapshot |
//! | `delta` | Snapshot vs baseline diff |
//! | `dsl` | Snapshot → Structurizr DSL emitter |

mod dsl;
mod facts;
mod graph;
mod hash;
mod project;

pub use dsl::emit_dsl;
pub use facts::extract_file_facts;
pub use graph::{build_graph, compute_change_overlay, ChangeOverlay, CodeGraph, CodeGraphLimits};
pub use project::{
    project_snapshot, elements_owning_paths, ArchitectureDelta, ArchitectureModel, ArchitectureSnapshot,
    Binding, C4Element, C4Relationship, compute_delta, ElementKind, RelationshipKind, SourceBinding,
};

use serde::{Deserialize, Serialize};

/// One file's worth of extracted code facts.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileFacts {
    pub path: String,
    pub language: String,
    pub source_digest: String,
    pub symbols: Vec<Symbol>,
    pub imports: Vec<Import>,
    pub call_sites: Vec<CallSite>,
    /// Diagnostics for unsupported or partial extraction.
    pub diagnostics: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Symbol {
    pub id: String,
    pub name: String,
    pub export_names: Vec<String>,
    pub kind: SymbolKind,
    pub file_path: String,
    pub start_line: u32,
    pub end_line: u32,
    pub arity: u32,
    pub params: Vec<ParamInfo>,
    pub signature: String,
    pub has_body: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SymbolKind {
    Function,
    Class,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParamInfo {
    pub name: String,
    pub type_text: String,
    pub optional: bool,
    pub rest: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Import {
    pub local_name: String,
    pub imported_name: String,
    pub source: String,
    pub kind: String,
    pub file_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CallSite {
    pub raw_name: String,
    pub name: String,
    pub receiver: Option<String>,
    pub member: Option<String>,
    pub argument_count: u32,
    pub argument_types: Vec<String>,
    pub file_path: String,
    pub line: u32,
    pub caller_id: Option<String>,
    pub caller_name: Option<String>,
    pub is_test: bool,
}