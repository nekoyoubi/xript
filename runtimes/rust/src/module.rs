use crate::error::XriptError;

/// A CommonJS artifact discovered in a mod entry source. The variant maps to the
/// stable `artifact` token surfaced in [`XriptError::CommonJsDetected`].
pub fn detect_commonjs(source: &str) -> Option<&'static str> {
    let stripped = strip_strings_and_comments(source);
    if contains_require_call(&stripped) {
        return Some("require()");
    }
    if stripped.contains("module.exports") {
        return Some("module.exports");
    }
    if contains_exports_assignment(&stripped) {
        return Some("exports.x");
    }
    None
}

fn contains_require_call(source: &str) -> bool {
    let bytes = source.as_bytes();
    let mut idx = 0;
    while let Some(found) = source[idx..].find("require") {
        let pos = idx + found;
        let before_ok = pos == 0 || !is_ident_char(bytes[pos - 1]);
        let mut after = pos + "require".len();
        while after < bytes.len() && (bytes[after] == b' ' || bytes[after] == b'\t') {
            after += 1;
        }
        let after_ok = after < bytes.len() && bytes[after] == b'(';
        if before_ok && after_ok {
            return true;
        }
        idx = pos + "require".len();
    }
    false
}

fn contains_exports_assignment(source: &str) -> bool {
    let bytes = source.as_bytes();
    let mut idx = 0;
    while let Some(found) = source[idx..].find("exports") {
        let pos = idx + found;
        let prev = if pos == 0 { None } else { Some(bytes[pos - 1]) };
        let before_ok = match prev {
            None => true,
            Some(b'.') => false,
            Some(b) => !is_ident_char(b),
        };
        let after = pos + "exports".len();
        if before_ok && exports_member_is_assigned(bytes, after) {
            return true;
        }
        idx = pos + "exports".len();
    }
    false
}

/// Given a byte offset just past a bare `exports` token, decides whether it is
/// a CommonJS assignment target: `exports.<ident> =` or `exports[...] =`. A
/// bare member read (`exports.foo` with no assignment) is not flagged.
fn exports_member_is_assigned(bytes: &[u8], after: usize) -> bool {
    match bytes.get(after).copied() {
        Some(b'.') => {
            let mut i = after + 1;
            while i < bytes.len() && is_ident_char(bytes[i]) {
                i += 1;
            }
            assignment_follows(bytes, i)
        }
        Some(b'[') => {
            let mut depth = 1;
            let mut i = after + 1;
            while i < bytes.len() && depth > 0 {
                match bytes[i] {
                    b'[' => depth += 1,
                    b']' => depth -= 1,
                    _ => {}
                }
                i += 1;
            }
            assignment_follows(bytes, i)
        }
        _ => false,
    }
}

fn assignment_follows(bytes: &[u8], mut i: usize) -> bool {
    while i < bytes.len() && (bytes[i] == b' ' || bytes[i] == b'\t' || bytes[i] == b'\n' || bytes[i] == b'\r') {
        i += 1;
    }
    match (bytes.get(i).copied(), bytes.get(i + 1).copied()) {
        (Some(b'='), Some(b'=')) => false,
        (Some(b'='), _) => true,
        _ => false,
    }
}

fn is_ident_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'$'
}

/// Replaces the contents of string literals and comments with spaces so the
/// CommonJS and import detectors do not match artifacts that appear inside
/// quoted text or comments. Conservative — favors keeping structure over
/// perfect tokenization.
fn strip_strings_and_comments(source: &str) -> String {
    let bytes = source.as_bytes();
    let mut out = String::with_capacity(source.len());
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        match c {
            b'/' if bytes.get(i + 1) == Some(&b'/') => {
                while i < bytes.len() && bytes[i] != b'\n' {
                    out.push(' ');
                    i += 1;
                }
            }
            b'/' if bytes.get(i + 1) == Some(&b'*') => {
                out.push(' ');
                out.push(' ');
                i += 2;
                while i < bytes.len() && !(bytes[i] == b'*' && bytes.get(i + 1) == Some(&b'/')) {
                    out.push(if bytes[i] == b'\n' { '\n' } else { ' ' });
                    i += 1;
                }
                if i < bytes.len() {
                    out.push(' ');
                    out.push(' ');
                    i += 2;
                }
            }
            b'"' | b'\'' | b'`' => {
                let quote = c;
                out.push(' ');
                i += 1;
                while i < bytes.len() && bytes[i] != quote {
                    if bytes[i] == b'\\' && i + 1 < bytes.len() {
                        out.push(' ');
                        out.push(' ');
                        i += 2;
                        continue;
                    }
                    out.push(if bytes[i] == b'\n' { '\n' } else { ' ' });
                    i += 1;
                }
                if i < bytes.len() {
                    out.push(' ');
                    i += 1;
                }
            }
            _ => {
                out.push(c as char);
                i += 1;
            }
        }
    }
    out
}

/// Scans module entry source for static `import`/`export ... from` specifiers
/// and dynamic `import(...)` calls, returning the first specifier found. Every
/// specifier — bare, absolute, URL, and relative — is reported; the runtime
/// rejects all of them at load time.
pub fn first_import_specifier(source: &str) -> Option<String> {
    let stripped = strip_strings_and_comments_keep_specifiers(source);
    for (clean_pos, raw_spec) in &stripped.specifiers {
        if let Some(spec) = import_specifier_at(&stripped.text, *clean_pos, raw_spec) {
            return Some(spec);
        }
    }
    None
}

struct StrippedWithSpecifiers {
    text: String,
    specifiers: Vec<(usize, String)>,
}

/// Like [`strip_strings_and_comments`] but records the byte offset and literal
/// value of every string literal so the import scanner can recover the
/// specifier text that follows an `import`/`from`/`import(` keyword.
fn strip_strings_and_comments_keep_specifiers(source: &str) -> StrippedWithSpecifiers {
    let bytes = source.as_bytes();
    let mut out = String::with_capacity(source.len());
    let mut specifiers: Vec<(usize, String)> = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        match c {
            b'/' if bytes.get(i + 1) == Some(&b'/') => {
                while i < bytes.len() && bytes[i] != b'\n' {
                    out.push(' ');
                    i += 1;
                }
            }
            b'/' if bytes.get(i + 1) == Some(&b'*') => {
                out.push(' ');
                out.push(' ');
                i += 2;
                while i < bytes.len() && !(bytes[i] == b'*' && bytes.get(i + 1) == Some(&b'/')) {
                    out.push(if bytes[i] == b'\n' { '\n' } else { ' ' });
                    i += 1;
                }
                if i < bytes.len() {
                    out.push(' ');
                    out.push(' ');
                    i += 2;
                }
            }
            b'"' | b'\'' | b'`' => {
                let quote = c;
                let literal_start = out.len();
                let mut literal = String::new();
                out.push(' ');
                i += 1;
                while i < bytes.len() && bytes[i] != quote {
                    if bytes[i] == b'\\' && i + 1 < bytes.len() {
                        out.push(' ');
                        out.push(' ');
                        literal.push(bytes[i] as char);
                        literal.push(bytes[i + 1] as char);
                        i += 2;
                        continue;
                    }
                    out.push(if bytes[i] == b'\n' { '\n' } else { ' ' });
                    literal.push(bytes[i] as char);
                    i += 1;
                }
                if i < bytes.len() {
                    out.push(' ');
                    i += 1;
                }
                specifiers.push((literal_start, literal));
            }
            _ => {
                out.push(c as char);
                i += 1;
            }
        }
    }
    StrippedWithSpecifiers {
        text: out,
        specifiers,
    }
}

/// Decides whether the string literal at `clean_pos` is an import/export
/// specifier by inspecting the preceding keyword in the comment/string-stripped
/// text.
fn import_specifier_at(text: &str, clean_pos: usize, raw_spec: &str) -> Option<String> {
    let prefix = text[..clean_pos].trim_end();
    if prefix.ends_with("from") && preceded_by_import_or_export(prefix) {
        return Some(unescape_specifier(raw_spec));
    }
    if prefix.ends_with("import") {
        let before = prefix[..prefix.len() - "import".len()].trim_end();
        if before.is_empty() || ends_at_statement_boundary(before) {
            return Some(unescape_specifier(raw_spec));
        }
    }
    if prefix.ends_with("import(") || prefix.ends_with("import (") {
        return Some(unescape_specifier(raw_spec));
    }
    None
}

fn preceded_by_import_or_export(prefix: &str) -> bool {
    let head = prefix[..prefix.len() - "from".len()].trim_end();
    head.contains("import") || head.contains("export")
}

fn ends_at_statement_boundary(before: &str) -> bool {
    before
        .chars()
        .last()
        .map(|c| c == ';' || c == '}' || c == '{')
        .unwrap_or(true)
}

fn unescape_specifier(raw: &str) -> String {
    raw.replace("\\\"", "\"").replace("\\'", "'").replace("\\\\", "\\")
}

/// An import discovered in module entry source: the specifier plus whether it
/// came from a dynamic `import(...)` call rather than a static form.
pub struct FoundImport {
    pub specifier: String,
    pub dynamic: bool,
}

/// Scans module entry source and returns every static and dynamic import
/// specifier, in source order.
pub fn all_import_specifiers(source: &str) -> Vec<FoundImport> {
    let stripped = strip_strings_and_comments_keep_specifiers(source);
    let mut found = Vec::new();
    for (clean_pos, raw_spec) in &stripped.specifiers {
        if let Some(dynamic) = import_specifier_kind_at(&stripped.text, *clean_pos) {
            found.push(FoundImport {
                specifier: unescape_specifier(raw_spec),
                dynamic,
            });
        }
    }
    found
}

/// Like [`import_specifier_at`] but reports the import's kind: `Some(true)`
/// for a dynamic `import(...)`, `Some(false)` for a static form, `None` when
/// the literal is not an import specifier at all.
fn import_specifier_kind_at(text: &str, clean_pos: usize) -> Option<bool> {
    let prefix = text[..clean_pos].trim_end();
    if prefix.ends_with("import(") || prefix.ends_with("import (") {
        return Some(true);
    }
    if prefix.ends_with("from") && preceded_by_import_or_export(prefix) {
        return Some(false);
    }
    if prefix.ends_with("import") {
        let before = prefix[..prefix.len() - "import".len()].trim_end();
        if before.is_empty() || ends_at_statement_boundary(before) {
            return Some(false);
        }
    }
    None
}

/// Runs the pre-evaluation guardrails common to both script and module mode.
/// CommonJS detection fires in both modes; import handling fires only when a
/// module-format entry declares an import: dynamic imports are always denied,
/// static imports are passed to `approve_import`, which errors unless the
/// specifier names an approved, registered, capability-satisfied library.
pub fn check_entry_source_with(
    mod_name: &str,
    source: &str,
    is_module: bool,
    approve_import: impl Fn(&str) -> Result<(), XriptError>,
) -> Result<(), XriptError> {
    if let Some(artifact) = detect_commonjs(source) {
        return Err(XriptError::CommonJsDetected {
            mod_name: mod_name.to_string(),
            artifact: artifact.to_string(),
        });
    }
    if is_module {
        for import in all_import_specifiers(source) {
            if import.dynamic {
                return Err(XriptError::ImportDenied {
                    mod_name: mod_name.to_string(),
                    specifier: import.specifier,
                });
            }
            approve_import(&import.specifier)?;
        }
    }
    Ok(())
}

/// [`check_entry_source_with`] under the historical deny-all import policy.
pub fn check_entry_source(
    mod_name: &str,
    source: &str,
    is_module: bool,
) -> Result<(), XriptError> {
    check_entry_source_with(mod_name, source, is_module, |specifier| {
        Err(XriptError::ImportDenied {
            mod_name: mod_name.to_string(),
            specifier: specifier.to_string(),
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_require_call() {
        assert_eq!(detect_commonjs("const x = require('fs');"), Some("require()"));
    }

    #[test]
    fn detects_module_exports() {
        assert_eq!(detect_commonjs("module.exports = {};"), Some("module.exports"));
    }

    #[test]
    fn detects_exports_assignment() {
        assert_eq!(detect_commonjs("exports.foo = 1;"), Some("exports.x"));
        assert_eq!(detect_commonjs("exports['foo'] = 1;"), Some("exports.x"));
    }

    #[test]
    fn ignores_require_inside_string() {
        assert_eq!(detect_commonjs("var s = 'please require() this';"), None);
    }

    #[test]
    fn ignores_require_inside_comment() {
        assert_eq!(detect_commonjs("// require('x')\nvar y = 1;"), None);
        assert_eq!(detect_commonjs("/* module.exports */ var y = 1;"), None);
    }

    #[test]
    fn ignores_xript_exports_register() {
        assert_eq!(
            detect_commonjs("xript.exports.register('a', function(){});"),
            None
        );
    }

    #[test]
    fn does_not_match_requirement_identifier() {
        assert_eq!(detect_commonjs("const requirement = 1;"), None);
    }

    #[test]
    fn finds_bare_import_specifier() {
        assert_eq!(
            first_import_specifier("import fs from 'fs';").as_deref(),
            Some("fs")
        );
    }

    #[test]
    fn finds_named_import_specifier() {
        assert_eq!(
            first_import_specifier("import { a, b } from \"lodash\";").as_deref(),
            Some("lodash")
        );
    }

    #[test]
    fn finds_relative_import_specifier() {
        assert_eq!(
            first_import_specifier("import x from './util.js';").as_deref(),
            Some("./util.js")
        );
    }

    #[test]
    fn finds_dynamic_import_specifier() {
        assert_eq!(
            first_import_specifier("const m = await import('os');").as_deref(),
            Some("os")
        );
    }

    #[test]
    fn finds_export_from_specifier() {
        assert_eq!(
            first_import_specifier("export { x } from 'mod';").as_deref(),
            Some("mod")
        );
    }

    #[test]
    fn ignores_import_keyword_in_string() {
        assert_eq!(
            first_import_specifier("const s = \"import x from 'y'\";"),
            None
        );
    }

    #[test]
    fn ignores_bare_module_with_no_imports() {
        assert_eq!(
            first_import_specifier("export function go() { return 1; }"),
            None
        );
    }
}
