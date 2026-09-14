//! Structurizr DSL emitter.

use crate::ArchitectureSnapshot;

/// Emit a Structurizr DSL representation of an architecture snapshot.
///
/// The output is valid `.dsl` that re-parses into the same element and
/// relationship set (round-trip asserted by tests).
pub fn emit_dsl(snapshot: &ArchitectureSnapshot) -> String {
    let mut buf = String::new();
    buf.push_str(r#"workspace "Architecture Impact" "Declared architecture with observed code facts." {"#);
    buf.push('\n');
    buf.push_str("    !identifiers hierarchical\n");
    buf.push('\n');
    emit_model(&snapshot.model, &mut buf);
    buf.push_str("}\n");
    buf
}

fn emit_model(model: &crate::ArchitectureModel, buf: &mut String) {
    // Group elements by parent (top-level: software systems and people)
    buf.push_str("    model {\n");

    // Top-level: Person, SoftwareSystem
    let top: Vec<_> = model
        .elements
        .iter()
        .filter(|e| e.parent_id.is_none())
        .collect();
    for elem in &top {
        emit_element(elem, &model.elements, buf, 2);
    }

    // Declared relationships
    for rel in &model.relationships {
        let line = format!(
            "        {} -> {} \"{}\"",
            rel.source_id, rel.target_id, rel.description.as_deref().unwrap_or("")
        );
        buf.push_str(&line);
        if let Some(tech) = &rel.technology {
            buf.push_str(&format!(" \"{tech}\""));
        }
        buf.push('\n');
    }

    buf.push_str("    }\n");
}

fn emit_element(
    elem: &crate::C4Element,
    all_elements: &[crate::C4Element],
    buf: &mut String,
    indent: usize,
) {
    let indent_str = " ".repeat(indent);
    let kind_str = match elem.kind {
        crate::ElementKind::Person => "person",
        crate::ElementKind::SoftwareSystem => "softwareSystem",
        crate::ElementKind::Container => "container",
        crate::ElementKind::Component => "component",
    };
    let desc = elem
        .description
        .as_deref()
        .map(|d| format!(" \"{}\"", d))
        .unwrap_or_default();
    let tech = elem
        .technology
        .as_deref()
        .map(|t| format!(" \"{}\"", t))
        .unwrap_or_default();
    buf.push_str(&format!(
        "{indent_str}{} = {kind_str} \"{}\"{desc}{tech}",
        elem.id, elem.name
    ));
    // Check children
    let children: Vec<_> = all_elements
        .iter()
        .filter(|c| c.parent_id.as_deref() == Some(&elem.id))
        .collect();
    if !children.is_empty() {
        buf.push_str(" {\n");
        for child in &children {
            emit_element(child, all_elements, buf, indent + 4);
        }
        buf.push_str(&format!("{indent_str}}}\n"));
    } else {
        buf.push('\n');
    }
}