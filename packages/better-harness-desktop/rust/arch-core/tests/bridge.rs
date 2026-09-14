//! Integration-level tests for arch-core.

use arch_core::{extract_file_facts, FileFacts, SymbolKind};

fn digest(s: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(s.as_bytes());
    hex::encode(hasher.finalize())
}

#[test]
fn extracts_imports_from_esm() {
    let source = "import { createHash } from 'node:crypto';\nimport fs from 'node:fs';\nimport * as path from 'node:path';\n";
    let facts = extract_file_facts("/test.js", source);
    assert!(
        facts.diagnostics.is_empty(),
        "unexpected diagnostics: {:?}",
        facts.diagnostics
    );
    assert_eq!(facts.imports.len(), 3);
    assert_eq!(facts.imports[0].local_name, "createHash");
    assert_eq!(facts.imports[0].kind, "named");
    assert_eq!(facts.imports[1].local_name, "fs");
    assert_eq!(facts.imports[1].kind, "default");
    assert_eq!(facts.imports[2].local_name, "path");
    assert_eq!(facts.imports[2].kind, "namespace");
}

#[test]
fn extracts_function_symbol() {
    let source = "export function greet(name) { return `Hello, ${name}`; }\n";
    let facts = extract_file_facts("/greet.ts", source);
    assert!(facts.diagnostics.is_empty());
    assert_eq!(facts.symbols.len(), 1);
    let sym = &facts.symbols[0];
    assert_eq!(sym.name, "greet");
    assert_eq!(sym.export_names, vec!["greet"]);
    assert_eq!(sym.arity, 1);
    assert!(matches!(sym.kind, SymbolKind::Function));
}

#[test]
fn extracts_call_sites() {
    let source = r#"
import { say } from './utils';
export function main() {
  say("hello");
  const result = compute(1, 2);
}
"#;
    let facts = extract_file_facts("/main.ts", source);
    assert!(
        facts.diagnostics.is_empty(),
        "unexpected: {:?}",
        facts.diagnostics
    );
    assert!(facts.symbols.len() >= 1);
    assert!(facts.call_sites.len() >= 2, "got {} call sites", facts.call_sites.len());
    let first_call = &facts.call_sites[0];
    assert_eq!(first_call.name, "say");
    assert_eq!(first_call.argument_count, 1);
}

#[test]
fn class_symbol() {
    let source = "export class Counter { value = 0; increment() { this.value += 1; } }\n";
    let facts = extract_file_facts("/counter.ts", source);
    assert!(facts.diagnostics.is_empty());
    assert!(facts.symbols.iter().any(|s| s.name == "Counter" && matches!(s.kind, SymbolKind::Class)));
}

#[test]
fn unsupported_language_returns_diagnostic() {
    let facts = extract_file_facts("/foo.py", "def hello(): pass\n");
    assert!(!facts.diagnostics.is_empty());
    assert!(facts.diagnostics[0].contains("unsupported language"));
}