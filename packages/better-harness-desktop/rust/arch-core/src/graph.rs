//! Module index, import resolution, symbol graph, and impact radius.

use std::collections::HashMap;

use crate::{CallSite, FileFacts, Import, Symbol};

/// A resolved symbol graph for a set of files.
#[derive(Debug, Clone)]
pub struct CodeGraph {
    pub all_symbols: Vec<Symbol>,
    pub symbol_by_id: HashMap<String, Symbol>,
    pub symbols_by_file: HashMap<String, Vec<Symbol>>,
    /// Per-file import with resolved source file.
    pub resolved_imports: HashMap<String, Vec<ResolvedImport>>,
    /// edge from caller symbol id → called symbol id
    pub forward_edges: HashMap<String, Vec<String>>,
    /// edge from called symbol id → caller symbol id
    pub reverse_edges: HashMap<String, Vec<String>>,
    pub parsed_files: usize,
    pub truncated: bool,
}

#[derive(Debug, Clone)]
pub struct ResolvedImport {
    pub local_name: String,
    pub imported_name: String,
    pub source: String,
    pub kind: String,
    pub file_path: String,
    /// Resolved source file(s).
    pub source_files: Vec<String>,
}

/// How the changed-file ↔ symbol resolution is computed.
#[derive(Debug, Clone)]
pub struct ChangeOverlay {
    pub changed_symbols: Vec<Symbol>,
    pub impacted_symbols: Vec<Symbol>,
    pub impacted_files: Vec<String>,
}

/// Bounded construction limits.
#[derive(Debug, Clone)]
pub struct CodeGraphLimits {
    pub max_files: usize,
    pub max_bytes: usize,
}

impl Default for CodeGraphLimits {
    fn default() -> Self {
        Self {
            max_files: 800,
            max_bytes: 512_000,
        }
    }
}

pub enum SymbolResolution {
    Resolved {
        symbol_id: String,
        file: String,
    },
    Unresolved {
        name: String,
        import_source: Option<String>,
    },
}

/// Build a symbol graph from per-file facts and a tracked path list.
///
/// * `facts` — per-file extracted facts (caller supplies content).
/// * `changed_paths` — the changed paths for overlay marking.
/// * `module_index_keys` — the full tracked path list for import resolution.
/// * `limits` — construction bounds.
pub fn build_graph(
    facts: &[FileFacts],
    changed_paths: &[String],
    module_index_keys: &[String],
    limits: &CodeGraphLimits,
) -> CodeGraph {
    // Filter and sort facts
    let _prioritized = prioritize_facts(facts, changed_paths, limits);

    let mut symbol_by_id: HashMap<String, Symbol> = HashMap::new();
    let mut symbols_by_file: HashMap<String, Vec<Symbol>> = HashMap::new();
    let mut local_symbols_by_file: HashMap<String, HashMap<String, Vec<String>>> =
        HashMap::new();
    let mut exports_by_file: HashMap<String, HashMap<String, Vec<String>>> =
        HashMap::new();

    let mut all_symbols = Vec::new();

    for fact in facts {
        for symbol in &fact.symbols {
            all_symbols.push(symbol.clone());
            symbol_by_id.insert(symbol.id.clone(), symbol.clone());
            symbols_by_file
                .entry(fact.path.clone())
                .or_default()
                .push(symbol.clone());

            local_symbols_by_file
                .entry(fact.path.clone())
                .or_default()
                .entry(symbol.name.clone())
                .or_default()
                .push(symbol.id.clone());

            for export_name in &symbol.export_names {
                exports_by_file
                    .entry(fact.path.clone())
                    .or_default()
                    .entry(export_name.clone())
                    .or_default()
                    .push(symbol.id.clone());
            }
        }
    }

    // Build module index from keys
    let module_index = build_module_index(module_index_keys);

    // Resolve imports
    let mut resolved_imports: HashMap<String, Vec<ResolvedImport>> = HashMap::new();
    for fact in facts {
        let mut resolved = Vec::new();
        for imp in &fact.imports {
            let source_files =
                resolve_import_source(&fact.path, &imp.source, &module_index);
            resolved.push(ResolvedImport {
                local_name: imp.local_name.clone(),
                imported_name: imp.imported_name.clone(),
                source: imp.source.clone(),
                kind: imp.kind.clone(),
                file_path: fact.path.clone(),
                source_files,
            });
        }
        resolved_imports.insert(fact.path.clone(), resolved);
    }

    // Build edges from call sites
    let mut forward_edges: HashMap<String, Vec<String>> = HashMap::new();
    let mut reverse_edges: HashMap<String, Vec<String>> = HashMap::new();

    let draft = GraphDraft {
        symbol_by_id: &symbol_by_id,
        local_symbols_by_file: &local_symbols_by_file,
        exports_by_file: &exports_by_file,
        resolved_imports: &resolved_imports,
    };

    for fact in facts {
        for call_site in &fact.call_sites {
            let target_ids = resolve_call_targets(call_site, &draft);
            for target_id in &target_ids {
                forward_edges
                    .entry(
                        call_site
                            .caller_id
                            .clone()
                            .unwrap_or_default(),
                    )
                    .or_default()
                    .push(target_id.clone());
                reverse_edges
                    .entry(target_id.clone())
                    .or_default()
                    .push(
                        call_site
                            .caller_id
                            .clone()
                            .unwrap_or_default(),
                    );
            }
        }
    }

    CodeGraph {
        all_symbols,
        symbol_by_id,
        symbols_by_file,
        resolved_imports,
        forward_edges,
        reverse_edges,
        parsed_files: facts.len(),
        truncated: facts.len() > limits.max_files,
    }
}

// ---------------------------------------------------------------------------
// Module index
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct ModuleIndex {
    /// path → canonical (resolved) path
    modules: HashMap<String, String>,
    /// directory → list of files
    packages: HashMap<String, Vec<String>>,
    /// tsconfig alias → resolved path
    aliases: HashMap<String, String>,
}

fn build_module_index(keys: &[String]) -> ModuleIndex {
    let mut modules = HashMap::new();
    let mut packages: HashMap<String, Vec<String>> = HashMap::new();

    for key in keys {
        let normalized = key.replace('\\', "/");
        modules.insert(normalized.clone(), normalized.clone());
        // Without extension
        if let Some(idx) = normalized.rfind('.') {
            let without_ext = &normalized[..idx];
            modules.insert(without_ext.to_string(), normalized.clone());
        }
        // Directory-based packages
        if let Some(dir_idx) = normalized.rfind('/') {
            let directory = &normalized[..dir_idx];
            if !directory.is_empty() {
                packages
                    .entry(directory.to_string())
                    .or_default()
                    .push(normalized.clone());
            }
        }
        // Index deduction: strip /index
        if normalized.ends_with("/index") {
            let key = normalized[..normalized.len() - 6].to_string();
            modules.entry(key).or_insert_with(|| normalized.clone());
        }
    }

    ModuleIndex {
        modules,
        packages,
        aliases: HashMap::new(),
    }
}

fn resolve_import_source(
    from_file: &str,
    source: &str,
    idx: &ModuleIndex,
) -> Vec<String> {
    // Check aliases first
    if let Some(resolved) = idx.aliases.get(source) {
        return vec![resolved.clone()];
    }

    // Only resolve relative sources
    if !source.starts_with('.') {
        return vec![];
    }

    let from_dir = from_file
        .rfind('/')
        .map(|i| &from_file[..i])
        .unwrap_or("");

    // Normalize: resolve ../
    let base = if source.starts_with("..") || source.starts_with("./") {
        let joined = if from_dir.is_empty() {
            source.to_string()
        } else {
            format!("{}/{}", from_dir, source)
        };
        normalize_path(&joined)
    } else {
        source.to_string()
    };

    let bases = candidate_bases(&base);
    for candidate in &bases {
        if let Some(resolved) = idx.modules.get(candidate) {
            return vec![resolved.clone()];
        }
        // Try with each extension
        for ext in &[".ts", ".tsx", ".js", ".mjs", ".jsx", ".d.ts"] {
            let with_ext = format!("{candidate}{ext}");
            if let Some(resolved) = idx.modules.get(&with_ext) {
                return vec![resolved.clone()];
            }
        }
        // Try /index
        for ext in &[".ts", ".tsx", ".js", ".mjs", ".jsx"] {
            let index_path = format!("{candidate}/index{ext}");
            if let Some(resolved) = idx.modules.get(&index_path) {
                return vec![resolved.clone()];
            }
        }
    }

    vec![]
}

fn candidate_bases(base: &str) -> Vec<String> {
    let without_ext = base
        .rfind('.')
        .filter(|&i| i > base.rfind('/').unwrap_or(0))
        .map(|i| &base[..i])
        .unwrap_or(base)
        .to_string();
    if base == without_ext {
        vec![base.to_string()]
    } else {
        vec![base.to_string(), without_ext]
    }
}

fn normalize_path(path_str: &str) -> String {
    let mut parts: Vec<&str> = path_str.split('/').collect();
    let mut result: Vec<&str> = Vec::new();
    for part in parts {
        match part {
            "." => {}
            ".." => {
                result.pop();
            }
            other => result.push(other),
        }
    }
    result.join("/")
}

// ---------------------------------------------------------------------------
// Call target resolution
// ---------------------------------------------------------------------------

struct GraphDraft<'a> {
    symbol_by_id: &'a HashMap<String, Symbol>,
    local_symbols_by_file: &'a HashMap<String, HashMap<String, Vec<String>>>,
    exports_by_file: &'a HashMap<String, HashMap<String, Vec<String>>>,
    resolved_imports: &'a HashMap<String, Vec<ResolvedImport>>,
}

fn resolve_call_targets(call: &CallSite, draft: &GraphDraft) -> Vec<String> {
    let imports = draft.resolved_imports.get(&call.file_path);
    let mut candidates: Vec<String> = Vec::new();

    if let Some(receiver) = &call.receiver {
        // Method call: resolve through namespace import
        if let Some(ref imports) = imports {
            let ns_import = imports.iter().find(|imp| {
                imp.kind == "namespace"
                    && imp.local_name == *receiver
                    && !imp.source_files.is_empty()
            });
            if let Some(ns) = ns_import {
                if let Some(member) = &call.member {
                    candidates = exported_candidates(
                        draft.exports_by_file,
                        &ns.source_files,
                        member,
                    );
                }
            }
        }
    } else {
        // Direct call: try named import, then local symbol
        if let Some(ref imports) = imports {
            let named = imports.iter().find(|imp| {
                imp.local_name == call.name && !imp.source_files.is_empty()
            });
            if let Some(imp) = named {
                let export_name = if imp.kind == "default" {
                    "default"
                } else {
                    &imp.imported_name
                };
                candidates =
                    exported_candidates(draft.exports_by_file, &imp.source_files, export_name);
            }
        }

        if candidates.is_empty() {
            // Fallback to local symbol
            if let Some(local_map) = draft.local_symbols_by_file.get(&call.file_path) {
                if let Some(ids) = local_map.get(&call.name) {
                    candidates = ids.clone();
                }
            }
        }
    }

    candidates
}

fn exported_candidates(
    exports_by_file: &HashMap<String, HashMap<String, Vec<String>>>,
    source_files: &[String],
    export_name: &str,
) -> Vec<String> {
    let mut result = Vec::new();
    for file in source_files {
        if let Some(export_map) = exports_by_file.get(file) {
            if let Some(ids) = export_map.get(export_name) {
                result.extend(ids.iter().cloned());
            }
        }
    }
    result
}

// ---------------------------------------------------------------------------
// Priority sort
// ---------------------------------------------------------------------------

fn prioritize_facts<'a>(
    facts: &'a [FileFacts],
    changed_paths: &[String],
    limits: &CodeGraphLimits,
) -> Vec<&'a FileFacts> {
    let changed_set: std::collections::HashSet<&str> =
        changed_paths.iter().map(|s| s.as_str()).collect();

    let mut prioritized: Vec<&FileFacts> = facts
        .iter()
        .filter(|f| f.source_digest.len() <= limits.max_bytes)
        .collect();

    prioritized.sort_by_key(|f| !changed_set.contains(f.path.as_str()));
    prioritized.truncate(limits.max_files);
    prioritized
}

// ---------------------------------------------------------------------------
// Change overlay
// ---------------------------------------------------------------------------

/// Map changed files to overlapping symbols.
pub fn compute_change_overlay(
    changed_paths: &[String],
    graph: &CodeGraph,
) -> ChangeOverlay {
    let mut changed_symbols = Vec::new();
    let mut impacted_set: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut affected_files: std::collections::HashSet<String> =
        changed_paths.iter().cloned().collect();

    for path in changed_paths {
        if let Some(symbols) = graph.symbols_by_file.get(path) {
            for symbol in symbols {
                changed_symbols.push(symbol.clone());
                if let Some(callers) = graph.reverse_edges.get(&symbol.id) {
                    for caller in callers {
                        impacted_set.insert(caller.clone());
                        if let Some(caller_symbol) = graph.symbol_by_id.get(caller) {
                            affected_files.insert(caller_symbol.file_path.clone());
                        }
                    }
                }
            }
        }
    }

    let impacted_symbols: Vec<Symbol> = impacted_set
        .iter()
        .filter_map(|id| graph.symbol_by_id.get(id))
        .cloned()
        .collect();

    ChangeOverlay {
        changed_symbols,
        impacted_symbols,
        impacted_files: affected_files.into_iter().collect(),
    }
}