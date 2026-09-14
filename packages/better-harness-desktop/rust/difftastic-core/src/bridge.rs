//! The stable structural-diff surface.
//!
//! difftastic's internals are `pub(crate)`, so `harness-diff-service` cannot
//! use them directly. This module is the single seam: it runs the vendored
//! engine and returns a self-contained result whose lines already carry their
//! own text. Neither byte offsets nor a second fetch of the file bodies have to
//! cross the process boundary.
//!
//! Offsets stay in the engine. difftastic reports byte columns and the Studio
//! client is UTF-16, so converting here is the only place both are known: every
//! span is widened to a character boundary before it is sliced, which is why a
//! multi-byte line can never be split.

use std::collections::HashMap;
use std::path::PathBuf;

use serde_json::Value;

use crate::display::json::file_value;
use crate::options::{DiffOptions, DisplayOptions, FileArgument};
use crate::summary::DiffResult;

/// One contiguous run of characters inside a line.
pub struct StructuralSegment {
    /// The run's text, exactly as it appears on that side.
    pub text: String,
    /// Whether the engine considers this run changed on this side.
    pub novel: bool,
    /// difftastic's highlight kind, lowercased (for example `keyword`).
    pub highlight: String,
}

/// One side of a rendered line.
pub struct StructuralSide {
    /// 1-based line number in that revision.
    pub line_number: u32,
    pub segments: Vec<StructuralSegment>,
}

/// One rendered row: an aligned pair, or a line present on only one side.
pub struct StructuralLine {
    pub lhs: Option<StructuralSide>,
    pub rhs: Option<StructuralSide>,
}

/// A structural diff of two revisions of one file.
pub struct StructuralDiff {
    /// The language the engine detected, for example `TypeScript TSX`, or `Text`.
    pub language: String,
    /// `changed`, `created`, `deleted`, or `unchanged`.
    pub status: String,
    pub lines: Vec<StructuralLine>,
}

/// Which revision a span belongs to.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
enum Revision {
    Lhs,
    Rhs,
}

/// One novel run the engine reported, in byte columns.
#[derive(Clone)]
struct Change {
    start: usize,
    end: usize,
    highlight: String,
}

/// Diff two revisions of one file as text.
///
/// `display_path` selects the language and is never opened, matching the
/// engine's own contract.
pub fn structural_diff(display_path: &str, lhs_src: &str, rhs_src: &str) -> StructuralDiff {
    // Normalize before diffing, not after: line numbers and columns are only
    // consistent when the engine and the segment builder see the same bytes.
    let lhs = without_carriage_returns(lhs_src);
    let rhs = without_carriage_returns(rhs_src);

    let result = crate::diff_file_content(
        display_path,
        None,
        &FileArgument::DevNull,
        &FileArgument::NamedPath(PathBuf::from(display_path)),
        &lhs,
        &rhs,
        &DisplayOptions::default(),
        &DiffOptions::default(),
        &[],
    );

    assemble(&lhs, &rhs, &result)
}

fn without_carriage_returns(src: &str) -> String {
    if src.contains('\r') {
        src.replace('\r', "")
    } else {
        src.to_owned()
    }
}

fn assemble(lhs_src: &str, rhs_src: &str, result: &DiffResult) -> StructuralDiff {
    let projection = file_value(result);
    let language = text_field(&projection, "language").unwrap_or_else(|| "Text".to_owned());
    let status = text_field(&projection, "status").unwrap_or_else(|| "changed".to_owned());
    let lhs_lines = lines_of(lhs_src);
    let rhs_lines = lines_of(rhs_src);

    let mut lines = match status.as_str() {
        // A created or deleted file has nothing to align against, so every line
        // of the surviving side is novel by definition.
        "created" => rhs_lines
            .iter()
            .enumerate()
            .map(|(index, text)| StructuralLine {
                lhs: None,
                rhs: Some(whole_line(index, text, true)),
            })
            .collect(),
        "deleted" => lhs_lines
            .iter()
            .enumerate()
            .map(|(index, text)| StructuralLine {
                lhs: Some(whole_line(index, text, true)),
                rhs: None,
            })
            .collect(),
        "changed" => aligned_lines(&projection, &lhs_lines, &rhs_lines),
        _ => Vec::new(),
    };
    trim_trailing_blank(&mut lines);

    StructuralDiff {
        language,
        status,
        lines,
    }
}

fn aligned_lines(projection: &Value, lhs_lines: &[&str], rhs_lines: &[&str]) -> Vec<StructuralLine> {
    let changes = change_index(projection);
    let Some(aligned) = projection.get("aligned_lines").and_then(Value::as_array) else {
        return Vec::new();
    };
    aligned
        .iter()
        .filter_map(|pair| {
            let pair = pair.as_array()?;
            let lhs = pair
                .first()
                .and_then(Value::as_u64)
                .map(|number| side(number, Revision::Lhs, &changes, lhs_lines));
            let rhs = pair
                .get(1)
                .and_then(Value::as_u64)
                .map(|number| side(number, Revision::Rhs, &changes, rhs_lines));
            if lhs.is_none() && rhs.is_none() {
                return None;
            }
            Some(StructuralLine { lhs, rhs })
        })
        .collect()
}

/// Index every novel span by the revision and 0-based line it sits on.
fn change_index(projection: &Value) -> HashMap<(Revision, u64), Vec<Change>> {
    let mut index: HashMap<(Revision, u64), Vec<Change>> = HashMap::new();
    let Some(chunks) = projection.get("chunks").and_then(Value::as_array) else {
        return index;
    };
    for chunk in chunks {
        let Some(rows) = chunk.as_array() else {
            continue;
        };
        for row in rows {
            for (revision, key) in [(Revision::Lhs, "lhs"), (Revision::Rhs, "rhs")] {
                let Some(entry) = row.get(key) else {
                    continue;
                };
                let Some(number) = entry.get("line_number").and_then(Value::as_u64) else {
                    continue;
                };
                let spans = index.entry((revision, number)).or_default();
                let Some(changes) = entry.get("changes").and_then(Value::as_array) else {
                    continue;
                };
                for change in changes {
                    let (Some(start), Some(end)) = (
                        change.get("start").and_then(Value::as_u64),
                        change.get("end").and_then(Value::as_u64),
                    ) else {
                        continue;
                    };
                    spans.push(Change {
                        start: start as usize,
                        end: end as usize,
                        highlight: text_field(change, "highlight")
                            .unwrap_or_else(|| "normal".to_owned()),
                    });
                }
            }
        }
    }
    index
}

fn side(
    number: u64,
    revision: Revision,
    changes: &HashMap<(Revision, u64), Vec<Change>>,
    lines: &[&str],
) -> StructuralSide {
    let text = lines.get(number as usize).copied().unwrap_or("");
    let mut spans = changes.get(&(revision, number)).cloned().unwrap_or_default();
    spans.sort_by_key(|change| change.start);
    StructuralSide {
        line_number: number as u32 + 1,
        segments: segments(text, &spans),
    }
}

fn whole_line(index: usize, text: &str, novel: bool) -> StructuralSide {
    StructuralSide {
        line_number: index as u32 + 1,
        segments: vec![StructuralSegment {
            text: text.to_owned(),
            novel,
            highlight: "normal".to_owned(),
        }],
    }
}

/// Cover the whole line with segments, marking the engine's spans and leaving
/// everything between them unchanged.
fn segments(text: &str, spans: &[Change]) -> Vec<StructuralSegment> {
    let mut segments = Vec::new();
    let mut cursor = 0;
    for span in spans {
        let start = floor_boundary(text, span.start).max(cursor);
        let end = ceil_boundary(text, span.end);
        if start >= end {
            continue;
        }
        if start > cursor {
            segments.push(unchanged(&text[cursor..start]));
        }
        segments.push(StructuralSegment {
            text: text[start..end].to_owned(),
            novel: true,
            highlight: span.highlight.clone(),
        });
        cursor = end;
    }
    if cursor < text.len() {
        segments.push(unchanged(&text[cursor..]));
    }
    if segments.is_empty() {
        segments.push(unchanged(text));
    }
    segments
}

fn unchanged(text: &str) -> StructuralSegment {
    StructuralSegment {
        text: text.to_owned(),
        novel: false,
        highlight: "normal".to_owned(),
    }
}

fn floor_boundary(text: &str, offset: usize) -> usize {
    let mut offset = offset.min(text.len());
    while offset > 0 && !text.is_char_boundary(offset) {
        offset -= 1;
    }
    offset
}

fn ceil_boundary(text: &str, offset: usize) -> usize {
    let mut offset = offset.min(text.len());
    while offset < text.len() && !text.is_char_boundary(offset) {
        offset += 1;
    }
    offset
}

/// Drop the empty line a trailing newline leaves behind, which is an artifact
/// of splitting rather than content of either revision.
fn trim_trailing_blank(lines: &mut Vec<StructuralLine>) {
    let blank = |side: &Option<StructuralSide>| {
        side.as_ref().is_none_or(|side| {
            side.segments.iter().all(|segment| segment.text.is_empty())
        })
    };
    if lines
        .last()
        .is_some_and(|line| blank(&line.lhs) && blank(&line.rhs))
    {
        lines.pop();
    }
}

fn lines_of(src: &str) -> Vec<&str> {
    src.split('\n').collect()
}

fn text_field(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}
