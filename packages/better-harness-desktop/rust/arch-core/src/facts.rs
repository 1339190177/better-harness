//! OXC-based per-file fact extraction.
//!
//! Uses the OXC parser via the `Visit` trait to extract symbols, imports,
//! and call sites from JS/TS/TSX. The output matches the semantic shape of
//! `blast-radius`'s `extractSymbolsFromSource`.

use oxc_allocator::Allocator;
use oxc_ast::ast::{
    ArrowFunctionBody, BindingPattern, CallExpression, ExportDefaultDeclarationKind, Expression,
    FormalParameters, ImportDeclaration, ImportDeclarationSpecifier, NewExpression, Program,
    Statement, VariableDeclarator,
};
use oxc_syntax::scope::ScopeFlags;
use oxc_ast_visit::Visit;
use oxc_parser::Parser;
use oxc_span::SourceType;

use crate::{CallSite, FileFacts, Import, ParamInfo, Symbol, SymbolKind};

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/// Extract facts from one source file.
pub fn extract_file_facts(path: &str, source: &str) -> FileFacts {
    let source_type = match SourceType::from_path(path) {
        Ok(st) if st.is_javascript() || st.is_typescript() || st.is_jsx() => st,
        _ => return unsupported_facts(path, source),
    };

    let allocator = Allocator::default();
    let parser = Parser::new(&allocator, source, source_type);
    let ret = parser.parse();

    if !ret.diagnostics.is_empty() {
        let diags: Vec<String> = ret.diagnostics.iter()
            .map(|d| {
                let msg = d.message.to_string();
                let off = d.labels.first().map(|l| l.offset()).unwrap_or(0) as usize;
                format!("line {}: {}", line_number(source, off), msg)
            })
            .collect();
        return FileFacts {
            path: path.to_owned(),
            language: resolve_language(source_type),
            source_digest: crate::hash::digest(source),
            symbols: vec![], imports: vec![], call_sites: vec![],
            diagnostics: diags,
        };
    }

    let mut visitor = FactsVisitor::new(path, source);
    visitor.visit_program(&ret.program);
    visitor.into_facts()
}

fn unsupported_facts(path: &str, source: &str) -> FileFacts {
    FileFacts {
        path: path.to_owned(),
        language: resolve_language(SourceType::mjs()),
        source_digest: crate::hash::digest(source),
        symbols: vec![], imports: vec![], call_sites: vec![],
        diagnostics: vec![format!("unsupported language for {path}")],
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn resolve_language(st: SourceType) -> String {
    if st.is_typescript() && st.is_jsx() { "TypeScript TSX".into() }
    else if st.is_typescript() { "TypeScript".into() }
    else if st.is_jsx() { "JavaScript JSX".into() }
    else { "JavaScript".into() }
}

fn line_number(source: &str, offset: usize) -> u32 {
    let offset = offset.min(source.len());
    source[..offset].matches('\n').count() as u32 + 1
}

fn symbol_id(path: &str, name: &str, sig: &str, line: u32) -> String {
    format!("{path}:{name}:{sig}:{line}")
}

fn is_test(path: &str) -> bool { path.contains(".test.") || path.contains(".spec.") || path.contains("/__tests__/") || path.contains("/tests/") }

fn bp_name(pat: &BindingPattern<'_>) -> String {
    match pat {
        BindingPattern::BindingIdentifier(b) => b.name.as_str().to_string(),
        _ => String::new(),
    }
}

fn param_info(fp: &FormalParameters<'_>) -> (Vec<ParamInfo>, u32, String) {
    let mut ps = Vec::new();
    let mut ts = Vec::new();
    for item in &fp.items {
        let name = bp_name(&item.pattern);
        let type_text = item.type_annotation.as_ref()
            .map(|ta| format!("{:?}", ta.type_annotation))
            .unwrap_or_default();
        let rest = false;
        ps.push(ParamInfo { name, type_text: type_text.clone(), optional: item.optional, rest });
        ts.push(if type_text.is_empty() { "unknown".into() } else { type_text });
    }
    let arity = ps.iter().filter(|p| !p.rest).count() as u32;
    (ps, arity, format!("({})", ts.join(",")))
}

fn callee_info(callee: &Expression<'_>) -> (String, Option<String>, Option<String>) {
    match callee {
        Expression::Identifier(id) => {
            let n = id.name.as_str().to_string();
            (n.clone(), if n.contains('.') { Some(n.clone()) } else { None }, None)
        }
        Expression::StaticMemberExpression(m) => {
            let o = expr_name(&m.object);
            let p = m.property.name.as_str().to_string();
            (format!("{o}.{p}"), Some(o), Some(p))
        }
        Expression::ComputedMemberExpression(m) => {
            let o = expr_name(&m.object);
            let p = infer_type(&m.expression);
            (format!("{o}[{p}]"), Some(o), Some(p))
        }
        _ => (String::new(), None, None),
    }
}

fn expr_name(expr: &Expression<'_>) -> String {
    match expr {
        Expression::Identifier(id) => id.name.as_str().to_string(),
        Expression::StaticMemberExpression(m) => format!("{}.{}", expr_name(&m.object), m.property.name.as_str()),
        Expression::StringLiteral(s) => s.value.as_str().to_string(),
        Expression::ThisExpression(_) => "this".into(),
        _ => String::new(),
    }
}

fn infer_type(expr: &Expression<'_>) -> String {
    match expr {
        Expression::StringLiteral(_) | Expression::TemplateLiteral(_) => "string".into(),
        Expression::NumericLiteral(_) => "number".into(),
        Expression::BooleanLiteral(l) => if l.value { "true".into() } else { "boolean".into() },
        Expression::NullLiteral(_) => "null".into(),
        Expression::ObjectExpression(_) => "object".into(),
        Expression::ArrayExpression(_) => "array".into(),
        Expression::ArrowFunctionExpression(_) | Expression::FunctionExpression(_) => "function".into(),
        Expression::Identifier(id) => id.name.as_str().to_string(),
        _ => "unknown".into(),
    }
}

fn arg_type(arg: &oxc_ast::ast::Argument<'_>) -> String {
    match arg {
        oxc_ast::ast::Argument::SpreadElement(s) => infer_type(&s.argument),
        _ => arg.as_expression().map(|e| infer_type(e)).unwrap_or_else(|| "unknown".into()),
    }
}

fn import_spec(spec: &ImportDeclarationSpecifier<'_>) -> (String, String, String) {
    match spec {
        ImportDeclarationSpecifier::ImportSpecifier(s) => {
            let i = match &s.imported {
                oxc_ast::ast::ModuleExportName::IdentifierName(n) => n.name.as_str().to_string(),
                oxc_ast::ast::ModuleExportName::IdentifierReference(r) => r.name.as_str().to_string(),
                oxc_ast::ast::ModuleExportName::StringLiteral(l) => l.value.as_str().to_string(),
            };
            (i.clone(), i, "named".into())
        }
        ImportDeclarationSpecifier::ImportDefaultSpecifier(s) => (s.local.name.as_str().to_string(), "default".into(), "default".into()),
        ImportDeclarationSpecifier::ImportNamespaceSpecifier(s) => (s.local.name.as_str().to_string(), "*".into(), "namespace".into()),
    }
}

// ---------------------------------------------------------------------------
// Visitor
// ---------------------------------------------------------------------------

struct FactsVisitor<'a> {
    path: &'a str,
    source: &'a str,
    symbols: Vec<Symbol>,
    imports: Vec<Import>,
    call_sites: Vec<CallSite>,
    export_depth: u32,
    default_export: bool,
}

impl<'a> FactsVisitor<'a> {
    fn new(path: &'a str, source: &'a str) -> Self {
        Self { path, source, symbols: vec![], imports: vec![], call_sites: vec![],
               export_depth: 0, default_export: false }
    }

    fn into_facts(self) -> FileFacts {
        let st = SourceType::from_path(self.path).unwrap_or(SourceType::mjs());
        FileFacts {
            path: self.path.to_owned(),
            language: resolve_language(st),
            source_digest: crate::hash::digest(self.source),
            symbols: self.symbols,
            imports: self.imports,
            call_sites: self.call_sites,
            diagnostics: vec![],
        }
    }

    fn in_export(&self) -> bool { self.export_depth > 0 }

    fn export_names(&self, name: &str) -> Vec<String> {
        if self.default_export { vec!["default".into()] }
        else if self.in_export() { vec![name.to_owned()] }
        else { vec![] }
    }

    fn register_func(&mut self, name: &str, start: usize, end: usize, params: &FormalParameters<'_>, has_body: bool) {
        if name.is_empty() { return; }
        let (p, a, sig) = param_info(params);
        let sl = line_number(self.source, start);
        let el = line_number(self.source, end);
        self.symbols.push(Symbol {
            id: symbol_id(self.path, name, &sig, sl),
            name: name.to_owned(),
            export_names: self.export_names(name),
            kind: SymbolKind::Function,
            file_path: self.path.to_owned(),
            start_line: sl, end_line: el, arity: a, params: p, signature: sig, has_body,
        });
    }

    fn register_class(&mut self, name: &str, start: usize, end: usize) {
        if name.is_empty() { return; }
        let sl = line_number(self.source, start);
        let el = line_number(self.source, end);
        self.symbols.push(Symbol {
            id: symbol_id(self.path, name, "", sl),
            name: name.to_owned(),
            export_names: self.export_names(name),
            kind: SymbolKind::Class,
            file_path: self.path.to_owned(),
            start_line: sl, end_line: el, arity: 0, params: vec![], signature: String::new(), has_body: true,
        });
    }

    /// Walk function body statements for call sites. Returns the last pushed symbol if any.
    fn register_and_walk_func(&mut self, f: &oxc_ast::ast::Function<'a>) {
        let name = f.id.as_ref().map(|id| id.name.as_str().to_string()).unwrap_or_default();
        if name.is_empty() { return; }
        self.register_func(&name, f.span.start as usize, f.span.end as usize, &f.params, f.body.is_some());
        if let Some(ref body) = f.body {
            for stmt in &body.statements {
                self.visit_statement(stmt);
            }
        }
    }

    /// Register an arrow as a named variable function.
    fn register_arrow(&mut self, name: &str, arrow: &oxc_ast::ast::ArrowFunctionExpression<'a>) {
        if name.is_empty() { return; }
        self.register_func(name, arrow.span.start as usize, arrow.span.end as usize, &arrow.params, true);
    }

    fn walk_body_for_calls(&mut self, body: &ArrowFunctionBody<'a>) {
        match body {
            ArrowFunctionBody::FunctionBody(fb) => {
                for s in &fb.statements { self.visit_statement(s); }
            }
            _ => {
                if let Some(expr) = body.as_expression() {
                    self.visit_expression(expr);
                }
            }
        }
    }
}

impl<'a> Visit<'a> for FactsVisitor<'a> {
    fn visit_program(&mut self, it: &Program<'a>) {
        for stmt in &it.body {
            self.visit_statement(stmt);
        }
    }

    // ── Imports ────────────────────────────────────────────────────────
    fn visit_import_declaration(&mut self, it: &ImportDeclaration<'a>) {
        let src = it.source.value.as_str().to_string();
        if let Some(specs) = &it.specifiers {
            for spec in specs {
                let (local, imported, kind) = import_spec(spec);
                self.imports.push(Import {
                    local_name: local, imported_name: imported, source: src.clone(),
                    kind, file_path: self.path.to_owned(),
                });
            }
        }
    }

    // ── Exports ────────────────────────────────────────────────────────
    fn visit_export_declaration(&mut self, it: &oxc_ast::ast::ExportDeclaration<'a>) {
        self.export_depth += 1;
        match &it.declaration {
            oxc_ast::ast::Declaration::FunctionDeclaration(f) => self.visit_function(f, ScopeFlags::Function),
            oxc_ast::ast::Declaration::VariableDeclaration(v) => self.visit_variable_declaration(v),
            oxc_ast::ast::Declaration::ClassDeclaration(c) => self.visit_class(c),
            _ => {}
        }
        self.export_depth -= 1;
    }

    fn visit_export_default_declaration(&mut self, it: &oxc_ast::ast::ExportDefaultDeclaration<'a>) {
        self.export_depth += 1;
        self.default_export = true;
        match &it.declaration {
            ExportDefaultDeclarationKind::FunctionDeclaration(f) => {
                self.register_and_walk_func(f);
            }
            ExportDefaultDeclarationKind::ClassDeclaration(c) => {
                if let Some(id) = &c.id {
                    self.register_class(id.name.as_str(), c.span.start as usize, c.span.end as usize);
                }
            }
            _ => {
                if let Some(expr) = it.declaration.as_expression() {
                    self.visit_expression(expr);
                }
            }
        }
        self.default_export = false;
        self.export_depth -= 1;
    }

    // ── Functions ──────────────────────────────────────────────────────
    fn visit_function(&mut self, it: &oxc_ast::ast::Function<'a>, _flags: ScopeFlags) {
        self.register_and_walk_func(it);
    }

    fn visit_arrow_function_expression(&mut self, it: &oxc_ast::ast::ArrowFunctionExpression<'a>) {
        // Anonymous arrow in expression; walk body for calls
        self.walk_body_for_calls(&it.body);
    }

    fn visit_variable_declarator(&mut self, it: &VariableDeclarator<'a>) {
        if let Some(init) = &it.init {
            let name = bp_name(&it.id);
            match init {
                Expression::ArrowFunctionExpression(arrow) => {
                    if !name.is_empty() { self.register_arrow(&name, arrow); }
                    self.walk_body_for_calls(&arrow.body);
                }
                Expression::FunctionExpression(func) => {
                    self.register_func(&name, func.span.start as usize, func.span.end as usize, &func.params, func.body.is_some());
                    if let Some(body) = &func.body {
                        for s in &body.statements { self.visit_statement(s); }
                    }
                }
                other => { self.visit_expression(other); }
            }
        }
    }

    fn visit_class(&mut self, it: &oxc_ast::ast::Class<'a>) {
        if let Some(id) = &it.id {
            self.register_class(id.name.as_str(), it.span.start as usize, it.span.end as usize);
        }
    }

    // ── Call sites ─────────────────────────────────────────────────────
    fn visit_call_expression(&mut self, it: &CallExpression<'a>) {
        let (raw, recv, member) = callee_info(&it.callee);
        let name = member.as_deref().unwrap_or(&raw).to_string();
        let arg_types: Vec<_> = it.arguments.iter().map(|a| arg_type(a)).collect();
        self.call_sites.push(CallSite {
            raw_name: raw, name, receiver: recv, member,
            argument_count: it.arguments.len() as u32,
            argument_types: arg_types,
            file_path: self.path.to_owned(),
            line: line_number(self.source, it.span.start as usize),
            caller_id: None, caller_name: None,
            is_test: is_test(self.path),
        });
        // Walk arguments for nested calls
        for arg in &it.arguments {
            if let Some(e) = arg.as_expression() {
                self.visit_expression(e);
            }
        }
    }

    fn visit_new_expression(&mut self, it: &NewExpression<'a>) {
        let (raw, recv, member) = callee_info(&it.callee);
        let name = member.as_deref().unwrap_or(&raw).to_string();
        let arg_types: Vec<_> = it.arguments.iter().map(|a| arg_type(a)).collect();
        self.call_sites.push(CallSite {
            raw_name: format!("new {raw}"), name, receiver: recv, member,
            argument_count: it.arguments.len() as u32,
            argument_types: arg_types,
            file_path: self.path.to_owned(),
            line: line_number(self.source, it.span.start as usize),
            caller_id: None, caller_name: None,
            is_test: is_test(self.path),
        });
        for arg in &it.arguments {
            if let Some(e) = arg.as_expression() {
                self.visit_expression(e);
            }
        }
    }
}