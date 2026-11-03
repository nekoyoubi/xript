use std::sync::OnceLock;

use serde_json::Value;

/// The machine-readable XEG reference (`spec/expression-reference.json`): builtin signatures
/// and descriptions, operators by precedence, evaluation rules, and the fragment attributes
/// that carry expressions. Editors and tooling read it for completion and hover text; the
/// crate's builtin table is held to it by test.
pub const EXPRESSION_REFERENCE: &str = include_str!("../expression-reference.json");

/// [`EXPRESSION_REFERENCE`], parsed once.
pub fn expression_reference() -> &'static Value {
    static PARSED: OnceLock<Value> = OnceLock::new();
    PARSED.get_or_init(|| serde_json::from_str(EXPRESSION_REFERENCE).expect("the embedded expression reference is valid JSON"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{builtin_arity, BUILTIN_NAMES};

    #[test]
    fn embedded_copy_matches_the_spec() {
        let spec = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../spec/expression-reference.json"))
            .expect("spec/expression-reference.json is readable");
        assert_eq!(
            EXPRESSION_REFERENCE.replace("\r\n", "\n"),
            spec.replace("\r\n", "\n"),
            "crates/xript-expr/expression-reference.json has drifted from spec/; copy the spec file over it"
        );
    }

    #[test]
    fn builtin_table_matches_the_reference_signatures() {
        let builtins = expression_reference()["builtins"].as_array().expect("builtins is an array");
        let names: Vec<&str> = builtins.iter().map(|b| b["name"].as_str().unwrap()).collect();
        assert_eq!(names, BUILTIN_NAMES, "BUILTIN_NAMES must list the reference's builtins in order");

        for builtin in builtins {
            let name = builtin["name"].as_str().unwrap();
            let params = builtin["params"].as_array().unwrap();
            let min = params.iter().filter(|p| !p["optional"].as_bool().unwrap_or(false)).count();
            let variadic = params.iter().any(|p| p["variadic"].as_bool().unwrap_or(false));
            let max = if variadic { usize::MAX } else { params.len() };
            assert_eq!(builtin_arity(name), Some((min, max)), "arity of `{name}` disagrees with its reference signature");
        }
    }
}
