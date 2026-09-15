//! Declared-architecture model, source bindings, and snapshot projection.

use serde::{Deserialize, Serialize};

use crate::{CodeGraph, FileFacts};

/// A declared architecture element in the C4 model.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct C4Element {
    pub id: String,
    pub name: String,
    pub kind: ElementKind,
    pub description: Option<String>,
    pub technology: Option<String>,
    pub tags: Vec<String>,
    pub parent_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ElementKind {
    Person,
    SoftwareSystem,
    Container,
    Component,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct C4Relationship {
    pub id: String,
    pub source_id: String,
    pub target_id: String,
    pub description: Option<String>,
    pub technology: Option<String>,
    pub kind: RelationshipKind,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum RelationshipKind {
    Contains,
    Imports,
    ResolvedCall,
    DeclaredHttp,
    DeclaredRelationship,
}

/// A binding from source paths to declared architecture elements.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceBinding {
    /// Glob pattern for matching source paths.
    pub path_glob: String,
    /// Declared element id this binding points to.
    pub element_id: String,
}

/// A declared architecture model.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArchitectureModel {
    pub elements: Vec<C4Element>,
    pub relationships: Vec<C4Relationship>,
}

/// An architecture snapshot: model projected with observed facts.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArchitectureSnapshot {
    pub model: ArchitectureModel,
    /// Code facts projected onto the model (edges from observed code).
    pub observed_edges: Vec<C4Relationship>,
    /// Which model nodes had code hits (by id).
    pub code_hit_ids: Vec<String>,
    /// Which model nodes had changed code hits.
    pub changed_hit_ids: Vec<String>,
}

/// A delta between two snapshots (baseline → current).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArchitectureDelta {
    pub added_elements: Vec<C4Element>,
    pub removed_elements: Vec<C4Element>,
    pub added_relationships: Vec<C4Relationship>,
    pub removed_relationships: Vec<C4Relationship>,
}

/// Binding definition.
pub type Binding = SourceBinding;

/// Project source facts onto a declared model.
///
/// * `model` — declared architecture model (from .dsl or workspace.json).
/// * `bindings` — source path → element id mapping.
/// * `facts` — per-file extracted code facts.
/// * `graph` — resolved symbol graph.
/// * `changed_paths` — which files were changed (for overlay marking).
pub fn project_snapshot(
    model: &ArchitectureModel,
    bindings: &[SourceBinding],
    facts: &[FileFacts],
    graph: &CodeGraph,
    changed_paths: &[String],
) -> ArchitectureSnapshot {
    // For each binding, determine which declared elements match which source files.
    let binding_map = build_binding_map(bindings, facts);

    // Build element-by-element coverage
    let code_hit_ids = find_code_hits(&binding_map);
    let changed_hit_ids = find_changed_hits(&binding_map, changed_paths);

    // Derive observed edges from the code graph: group symbols by their declared
    // element, and emit edges when a call crosses element boundaries.
    let observed_edges = derive_observed_edges(graph, &binding_map, &code_hit_ids);

    ArchitectureSnapshot {
        model: model.clone(),
        observed_edges,
        code_hit_ids,
        changed_hit_ids,
    }
}

/// Which declared elements own any of these paths.
///
/// The projection marks the elements a change landed in; this answers the wider
/// question — which elements the reach of that change also touched — from the same
/// bindings, so a reader sees the radius on the diagram and not only in a count.
pub fn elements_owning_paths(bindings: &[SourceBinding], paths: &[String]) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    for binding in bindings {
        if !paths.iter().any(|path| simple_glob_match(path, &binding.path_glob)) {
            continue;
        }
        if !ids.contains(&binding.element_id) {
            ids.push(binding.element_id.clone());
        }
    }
    ids
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

/// For each binding, record which FileFacts matched.
struct BindingMapEntry {
    binding: SourceBinding,
    matched_paths: Vec<String>,
}

fn build_binding_map(
    bindings: &[SourceBinding],
    facts: &[FileFacts],
) -> Vec<BindingMapEntry> {
    let mut entries = Vec::new();
    for binding in bindings {
        let mut matched = Vec::new();
        // Simple glob matching: if the path contains the glob (no wildcards) or
        // matches a glob pattern. For v1: exact prefix/suffix matching.
        for fact in facts {
            if simple_glob_match(&fact.path, &binding.path_glob) {
                matched.push(fact.path.clone());
            }
        }
        entries.push(BindingMapEntry {
            binding: binding.clone(),
            matched_paths: matched
        });
    }
    entries
}

fn simple_glob_match(path: &str, glob: &str) -> bool {
    // Very simple glob: **/prefix/**, or */suffix, or exact match.
    if glob.ends_with("/**") {
        let prefix = &glob[..glob.len() - 3];
        path.starts_with(prefix)
    } else if glob.ends_with("**") {
        let prefix = &glob[..glob.len() - 2];
        path.starts_with(prefix)
    } else if glob.starts_with("**/") {
        let suffix = &glob[3..];
        path.contains(suffix)
    } else if glob.contains('*') {
        // Fallback: naive glob with single *
        let parts: Vec<&str> = glob.split('*').collect();
        if parts.len() == 2 {
            path.starts_with(parts[0]) && path.ends_with(parts[1])
        } else {
            false
        }
    } else {
        path == glob
    }
}

fn find_code_hits(entries: &[BindingMapEntry]) -> Vec<String> {
    entries
        .iter()
        .filter(|e| !e.matched_paths.is_empty())
        .map(|e| e.binding.element_id.clone())
        .collect()
}

fn find_changed_hits(
    entries: &[BindingMapEntry],
    changed_paths: &[String],
) -> Vec<String> {
    let changed_set: std::collections::HashSet<&str> =
        changed_paths.iter().map(|s| s.as_str()).collect();
    let mut result = Vec::new();
    for entry in entries {
        if entry.matched_paths.iter().any(|p| changed_set.contains(p.as_str())) {
            result.push(entry.binding.element_id.clone());
        }
    }
    result
}

fn derive_observed_edges(
    graph: &CodeGraph,
    entries: &[BindingMapEntry],
    code_hit_ids: &[String],
) -> Vec<C4Relationship> {
    // Build a map from file path → element id
    let file_to_element: std::collections::HashMap<&str, &str> = entries
        .iter()
        .flat_map(|entry| {
            entry
                .matched_paths
                .iter()
                .map(move |p| (p.as_str(), entry.binding.element_id.as_str()))
        })
        .collect();

    if file_to_element.is_empty() || code_hit_ids.is_empty() {
        return vec![];
    }

    let mut edges = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut edge_counter = 0u32;

    for (from_id, to_ids) in &graph.forward_edges {
        // Find which file the caller belongs to
        let caller_file = graph
            .symbol_by_id
            .get(from_id)
            .map(|s| s.file_path.as_str());
        let from_element = caller_file.and_then(|f| file_to_element.get(f).copied());

        for to_id in to_ids {
            let callee_file = graph
                .symbol_by_id
                .get(to_id)
                .map(|s| s.file_path.as_str());
            let to_element = callee_file.and_then(|f| file_to_element.get(f).copied());

            if let (Some(fe), Some(te)) = (from_element, to_element) {
                if fe != te {
                    let key = format!("{}->{}", fe, te);
                    if seen.insert(key) {
                        edge_counter += 1;
                        edges.push(C4Relationship {
                            id: format!("obs-{edge_counter}"),
                            source_id: fe.to_owned(),
                            target_id: te.to_owned(),
                            description: Some("observed/source call".to_owned()),
                            technology: None,
                            kind: RelationshipKind::ResolvedCall,
                        });
                    }
                }
            }
        }
    }

    edges
}

// ---------------------------------------------------------------------------
// Delta computation
// ---------------------------------------------------------------------------

/// Compute a delta between two snapshots.
pub fn compute_delta(
    before: &ArchitectureSnapshot,
    after: &ArchitectureSnapshot,
) -> ArchitectureDelta {
    let before_ids: std::collections::HashSet<&str> =
        before.model.elements.iter().map(|e| e.id.as_str()).collect();
    let after_ids: std::collections::HashSet<&str> =
        after.model.elements.iter().map(|e| e.id.as_str()).collect();

    let mut added = Vec::new();
    let mut removed = Vec::new();

    for elem in &after.model.elements {
        if !before_ids.contains(elem.id.as_str()) {
            added.push(elem.clone());
        }
    }
    for elem in &before.model.elements {
        if !after_ids.contains(elem.id.as_str()) {
            removed.push(elem.clone());
        }
    }

    let before_rel_ids: std::collections::HashSet<&str> =
        before.model.relationships.iter().map(|r| r.id.as_str()).collect();
    let after_rel_ids: std::collections::HashSet<&str> =
        after.model.relationships.iter().map(|r| r.id.as_str()).collect();

    let mut added_rels = Vec::new();
    let mut removed_rels = Vec::new();

    for rel in &after.model.relationships {
        if !before_rel_ids.contains(rel.id.as_str()) {
            added_rels.push(rel.clone());
        }
    }
    for rel in &before.model.relationships {
        if !after_rel_ids.contains(rel.id.as_str()) {
            removed_rels.push(rel.clone());
        }
    }

    ArchitectureDelta {
        added_elements: added,
        removed_elements: removed,
        added_relationships: added_rels,
        removed_relationships: removed_rels,
    }
}