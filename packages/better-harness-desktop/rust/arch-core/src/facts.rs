//! OXC-based per-file fact extraction.
//!
//! Uses the OXC parser via the `Visit` trait to extract symbols, imports,
//! and call sites from JS/TS/TSX. The output matches the semantic shape of
//! `blast-radius`'s `extractSymbolsFromSource`.

use oxc_allocator::Allocator;
use oxc_ast::ast::{
    ArrowFunctionBody, BindingPattern, CallExpression, ExportDefaultDeclarationKind, Expression,
    FormalParameters, ImportDeclaration, ImportDeclarationSpecifier, JSXAttributeItem, JSXAttributeValue,
    JSXElementName, JSXMemberExpressionObject, JSXOpeningElement, MethodDefinition, NewExpression,
    Program, PropertyKey, Statement, VariableDeclarator,
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

/** A member's name, so a method is registered as the symbol its calls belong to. */
fn attribute_name(key: &PropertyKey<'_>) -> String {
    match key {
        PropertyKey::StaticIdentifier(id) => id.name.as_str().to_string(),
        PropertyKey::StringLiteral(literal) => literal.value.as_str().to_string(),
        PropertyKey::NumericLiteral(literal) => literal.value.to_string(),
        _ => String::new(),
    }
}

/**
 * How a JSX element names what it renders.
 *
 * `<Component />` is a module's own code reaching another module's code, just as
 * a call is, and for a UI it is the common case: without it a change to a
 * component has no callers and its radius reads empty.
 */
fn jsx_usage(name: &JSXElementName<'_>) -> (String, Option<String>, Option<String>) {
    match name {
        JSXElementName::IdentifierReference(id) => {
            let identifier = id.name.as_str().to_string();
            if !is_component_name(&identifier) { return (String::new(), None, None); }
            (identifier, None, None)
        }
        JSXElementName::MemberExpression(member) => {
            let object = match &member.object {
                JSXMemberExpressionObject::IdentifierReference(id) => id.name.as_str().to_string(),
                _ => return (String::new(), None, None),
            };
            if !is_component_name(&object) { return (String::new(), None, None); }
            let property = member.property.name.as_str().to_string();
            (format!("{object}.{property}"), Some(object), Some(property))
        }
        _ => (String::new(), None, None),
    }
}

/** A lower-case JSX name is a host tag (`<div>`), not a module's own component. */
fn is_component_name(name: &str) -> bool {
    name.chars().next().is_some_and(|first| first.is_ascii_uppercase())
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
    /// Enclosing functions, innermost last: what a call site belongs to. Without
    /// this every edge in the graph is keyed by nobody, so a caller can never be
    /// found and the impact radius is always empty.
    callers: Vec<(String, String)>,
}

impl<'a> FactsVisitor<'a> {
    fn new(path: &'a str, source: &'a str) -> Self {
        Self { path, source, symbols: vec![], imports: vec![], call_sites: vec![],
               export_depth: 0, default_export: false, callers: vec![] }
    }

    /// The symbol a call site right now belongs to, if any.
    fn current_caller(&self) -> (Option<String>, Option<String>) {
        match self.callers.last() {
            Some((id, name)) => (Some(id.clone()), Some(name.clone())),
            None => (None, None),
        }
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

    fn register_func(&mut self, name: &str, start: usize, end: usize, params: &FormalParameters<'_>, has_body: bool) -> Option<String> {
        if name.is_empty() { return None; }
        let (p, a, sig) = param_info(params);
        let sl = line_number(self.source, start);
        let el = line_number(self.source, end);
        let id = symbol_id(self.path, name, &sig, sl);
        self.symbols.push(Symbol {
            id: id.clone(),
            name: name.to_owned(),
            export_names: self.export_names(name),
            kind: SymbolKind::Function,
            file_path: self.path.to_owned(),
            start_line: sl, end_line: el, arity: a, params: p, signature: sig, has_body,
        });
        Some(id)
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

    /// Run `walk` with `caller` on the stack, so calls inside it are attributed.
    fn with_caller<R>(&mut self, caller: Option<(String, String)>, walk: impl FnOnce(&mut Self) -> R) -> R {
        let pushed = caller.is_some();
        if let Some(frame) = caller { self.callers.push(frame); }
        let result = walk(self);
        if pushed { self.callers.pop(); }
        result
    }

    /// Walk a function body with its own symbol as the caller of everything in it.
    fn walk_body_as_caller(&mut self, caller: Option<(String, String)>, body: &[Statement<'a>]) {
        self.with_caller(caller, |this| {
            for stmt in body { this.visit_statement(stmt); }
        });
    }

    /// Walk function body statements for call sites. Returns the last pushed symbol if any.
    fn register_and_walk_func(&mut self, f: &oxc_ast::ast::Function<'a>) {
        let name = f.id.as_ref().map(|id| id.name.as_str().to_string()).unwrap_or_default();
        let id = self.register_func(&name, f.span.start as usize, f.span.end as usize, &f.params, f.body.is_some());
        let body = f.body.as_ref().map(|body| body.statements.as_slice()).unwrap_or(&[]);
        self.walk_body_as_caller(id.map(|id| (id, name)), body);
    }

    /// Register an arrow as a named variable function.
    fn register_arrow(&mut self, name: &str, arrow: &oxc_ast::ast::ArrowFunctionExpression<'a>) -> Option<String> {
        self.register_func(name, arrow.span.start as usize, arrow.span.end as usize, &arrow.params, true)
    }

    /// A class method is a function the visitor would otherwise not read: its
    /// body is where an object's calls live, and those calls need a caller.
    fn walk_method(&mut self, method: &MethodDefinition<'a>) {
        let name = attribute_name(&method.key);
        let value = &method.value;
        let id = self.register_func(&name, value.span.start as usize, value.span.end as usize, &value.params, value.body.is_some());
        let body = value.body.as_ref().map(|body| body.statements.as_slice()).unwrap_or(&[]);
        self.walk_body_as_caller(id.map(|id| (id, name)), body);
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

    fn visit_method_definition(&mut self, it: &MethodDefinition<'a>) {
        self.walk_method(it);
    }

    fn visit_jsx_opening_element(&mut self, it: &JSXOpeningElement<'a>) {
        let (raw, receiver, member) = jsx_usage(&it.name);
        if !raw.is_empty() {
            let name = member.clone().unwrap_or_else(|| raw.clone());
            let (caller_id, caller_name) = self.current_caller();
            self.call_sites.push(CallSite {
                raw_name: format!("<{raw} />"), name, receiver, member,
                argument_count: it.attributes.len() as u32,
                argument_types: vec![],
                file_path: self.path.to_owned(),
                line: line_number(self.source, it.span.start as usize),
                caller_id, caller_name,
                is_test: is_test(self.path),
            });
        }
        // Attribute expressions are their own code: `<Row onClick={() => save()} />`
        // still calls `save`.
        for attribute in &it.attributes {
            if let JSXAttributeItem::Attribute(attribute) = attribute {
                if let Some(JSXAttributeValue::ExpressionContainer(container)) = &attribute.value {
                    if let Some(expression) = container.expression.as_expression() {
                        self.visit_expression(expression);
                    }
                }
            }
        }
    }

    fn visit_variable_declarator(&mut self, it: &VariableDeclarator<'a>) {
        if let Some(init) = &it.init {
            let name = bp_name(&it.id);
            match init {
                Expression::ArrowFunctionExpression(arrow) => {
                    let id = self.register_arrow(&name, arrow);
                    let statements = match &arrow.body {
                        ArrowFunctionBody::FunctionBody(body) => Some(body.statements.as_slice()),
                        _ => None,
                    };
                    // An expression-bodied arrow has no statement list, so its
                    // calls are only reached by walking the expression — inside
                    // the caller frame, or they belong to nobody.
                    let expression = arrow.body.as_expression();
                    self.with_caller(id.map(|id| (id, name)), |this| {
                        if let Some(statements) = statements {
                            for stmt in statements { this.visit_statement(stmt); }
                        }
                        if let Some(expression) = expression { this.visit_expression(expression); }
                    });
                }
                Expression::FunctionExpression(func) => {
                    let id = self.register_func(&name, func.span.start as usize, func.span.end as usize, &func.params, func.body.is_some());
                    let body = func.body.as_ref().map(|body| body.statements.as_slice()).unwrap_or(&[]);
                    self.walk_body_as_caller(id.map(|id| (id, name)), body);
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
        let (caller_id, caller_name) = self.current_caller();
        self.call_sites.push(CallSite {
            raw_name: raw, name, receiver: recv, member,
            argument_count: it.arguments.len() as u32,
            argument_types: arg_types,
            file_path: self.path.to_owned(),
            line: line_number(self.source, it.span.start as usize),
            caller_id, caller_name,
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
        let (caller_id, caller_name) = self.current_caller();
        self.call_sites.push(CallSite {
            raw_name: format!("new {raw}"), name, receiver: recv, member,
            argument_count: it.arguments.len() as u32,
            argument_types: arg_types,
            file_path: self.path.to_owned(),
            line: line_number(self.source, it.span.start as usize),
            caller_id, caller_name,
            is_test: is_test(self.path),
        });
        for arg in &it.arguments {
            if let Some(e) = arg.as_expression() {
                self.visit_expression(e);
            }
        }
    }
}