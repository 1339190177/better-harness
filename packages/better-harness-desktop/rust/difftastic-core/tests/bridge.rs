//! Behaviour of the added bridge surface.
//!
//! Every assertion calls `structural_diff` and checks what it returns. The
//! central invariant is that a rendered side reconstructs its own source line
//! exactly: that is what makes the result safe to hand to a UTF-16 client, and
//! it is the property that would break if difftastic's byte columns were ever
//! sliced without widening them to a character boundary.

use difftastic_core::{structural_diff, StructuralLine, StructuralSide};

fn joined(side: &StructuralSide) -> String {
    side.segments.iter().map(|segment| &segment.text).fold(String::new(), |mut text, part| {
        text.push_str(part);
        text
    })
}

fn novel(side: &StructuralSide) -> Vec<&str> {
    side.segments
        .iter()
        .filter(|segment| segment.novel)
        .map(|segment| segment.text.as_str())
        .collect()
}

/// Every row side must rebuild the revision's own line, character for
/// character.
fn assert_self_consistent(lhs_src: &str, rhs_src: &str, lines: &[StructuralLine]) {
    let lhs_lines: Vec<&str> = lhs_src.split('\n').collect();
    let rhs_lines: Vec<&str> = rhs_src.split('\n').collect();
    for line in lines {
        if let Some(side) = &line.lhs {
            assert_eq!(
                joined(side),
                lhs_lines[side.line_number as usize - 1],
                "left side of line {} is incomplete",
                side.line_number
            );
        }
        if let Some(side) = &line.rhs {
            assert_eq!(
                joined(side),
                rhs_lines[side.line_number as usize - 1],
                "right side of line {} is incomplete",
                side.line_number
            );
        }
    }
}

#[test]
fn identical_text_has_no_rows_and_says_so() {
    let src = "function greet(name) {\n  return name;\n}\n";
    let diff = structural_diff("greet.js", src, src);

    assert_eq!(diff.status, "unchanged");
    assert!(diff.lines.is_empty());
    assert_eq!(diff.language, "JavaScript");
}

#[test]
fn a_changed_string_literal_narrows_to_that_literal() {
    let lhs = "const greeting = \"hello\";\n";
    let rhs = "const greeting = \"hi there\";\n";
    let diff = structural_diff("greeting.js", lhs, rhs);

    assert_eq!(diff.status, "changed");
    assert_eq!(diff.lines.len(), 1);
    let line = &diff.lines[0];
    assert_eq!(novel(line.lhs.as_ref().unwrap()), vec!["\"hello\""]);
    assert_eq!(novel(line.rhs.as_ref().unwrap()), vec!["\"hi there\""]);
    assert_self_consistent(lhs, rhs, &diff.lines);
}

#[test]
fn an_inserted_argument_marks_only_the_added_tokens() {
    let lhs = "const value = compute(1, 2);\n";
    let rhs = "const value = compute(1, 2, 3);\n";
    let diff = structural_diff("value.js", lhs, rhs);

    assert_eq!(diff.status, "changed");
    let line = &diff.lines[0];
    assert!(novel(line.lhs.as_ref().unwrap()).is_empty());
    assert_eq!(novel(line.rhs.as_ref().unwrap()), vec![",", "3"]);
    assert_self_consistent(lhs, rhs, &diff.lines);
}

#[test]
fn multi_byte_characters_are_never_split_across_segments() {
    // Byte columns and UTF-16 code units disagree here, which is the case the
    // bridge exists to absorb.
    let lhs = "const a = \"你好\";\nconst b = 1;\nconst c = \"🎈\";\n";
    let rhs = "const a = \"世界\";\nconst b = 2;\nconst c = \"🎈🎈\";\n";
    let diff = structural_diff("unicode.js", lhs, rhs);

    assert_eq!(diff.status, "changed");
    assert!(diff.lines.len() >= 3);
    assert_self_consistent(lhs, rhs, &diff.lines);
    assert_eq!(
        novel(diff.lines[0].rhs.as_ref().unwrap()),
        vec!["\"世界\""]
    );
}

#[test]
fn a_created_file_marks_every_line_of_the_new_revision() {
    let rhs = "line one\nline two\nline three\n";
    let diff = structural_diff("added.js", "", rhs);

    assert_eq!(diff.status, "created");
    assert_eq!(diff.lines.len(), 3);
    for (index, line) in diff.lines.iter().enumerate() {
        assert!(line.lhs.is_none());
        let side = line.rhs.as_ref().unwrap();
        assert_eq!(side.line_number, index as u32 + 1);
        assert_eq!(novel(side), vec![rhs.split('\n').nth(index).unwrap()]);
    }
}

#[test]
fn a_deleted_file_marks_every_line_of_the_old_revision() {
    let lhs = "line one\nline two\n";
    let diff = structural_diff("removed.js", lhs, "");

    assert_eq!(diff.status, "deleted");
    assert_eq!(diff.lines.len(), 2);
    for line in &diff.lines {
        assert!(line.rhs.is_none());
        assert!(!novel(line.lhs.as_ref().unwrap()).is_empty());
    }
}

#[test]
fn unknown_languages_still_produce_a_line_level_diff() {
    let lhs = "alpha beta\n";
    let rhs = "alpha gamma\n";
    let diff = structural_diff("notes.unknownext", lhs, rhs);

    assert_eq!(diff.language, "Text");
    assert_eq!(diff.status, "changed");
    assert_eq!(diff.lines.len(), 1);
    assert!(!novel(diff.lines[0].rhs.as_ref().unwrap()).is_empty());
}

#[test]
fn the_language_name_comes_from_the_path_the_engine_was_given() {
    let script = "const a = 1;\n";
    assert_eq!(
        structural_diff("view.tsx", script, "const a = 2;\n").language,
        "TypeScript TSX"
    );

    let rust = "fn main() {\n    let a = 1;\n}\n";
    assert_eq!(
        structural_diff("main.rs", rust, "fn main() {\n    let a = 2;\n}\n").language,
        "Rust"
    );
}

#[test]
fn text_the_engine_cannot_parse_names_why_it_fell_back() {
    // The language label is passed through verbatim, so a caller can show the
    // engine's own reason rather than pretending the diff is structural.
    let diff = structural_diff("not-really.rs", "const a = 1;\n", "const a = 2;\n");

    assert!(diff.language.starts_with("Text"), "unexpected label: {}", diff.language);
    assert!(diff.language.contains("parse error"), "unexpected label: {}", diff.language);
    assert_eq!(diff.status, "changed");
    assert_eq!(diff.lines.len(), 1);
}

#[test]
fn carriage_returns_do_not_reach_a_rendered_line() {
    let lhs = "const a = 1;\r\nconst b = 2;\r\n";
    let rhs = "const a = 1;\r\nconst b = 3;\r\n";
    let diff = structural_diff("crlf.js", lhs, rhs);

    let rendered: String = diff
        .lines
        .iter()
        .filter_map(|line| line.rhs.as_ref())
        .flat_map(|side| side.segments.iter())
        .map(|segment| segment.text.as_str())
        .collect();
    assert!(!rendered.contains('\r'), "a rendered line kept a carriage return");
}
