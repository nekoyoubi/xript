//! Capability subsumption with a read/write mode lattice.
//!
//! A capability string has the form `[<mode>:]<scope>` where `<mode>` is `read`
//! or `write` (absent means `write`, the top of the lattice) and `<scope>` is a
//! dot-delimited path of `[a-z][a-z0-9-]*` segments. A grant satisfies a require
//! when its mode is at least the require's mode AND its scope equals or is a
//! proper dotted ancestor of the require's scope. The two axes never collapse
//! into one comparison: mode is a lattice (`write` covers `read`), scope is a
//! prefix tree on whole segments.

use std::collections::HashSet;

/// Splits `[<mode>:]<scope>` into its mode and scope halves on the first colon.
/// An absent prefix yields `write` (top of the lattice). An unrecognized prefix
/// is returned verbatim so the matcher fails closed against it.
fn split_mode(cap: &str) -> (&str, &str) {
    match cap.find(':') {
        None => ("write", cap),
        Some(i) => (&cap[..i], &cap[i + 1..]),
    }
}

/// `write` dominates `read`: a `write` grant covers any require; otherwise the
/// modes must match exactly.
fn mode_satisfies(grant_mode: &str, require_mode: &str) -> bool {
    grant_mode == "write" || grant_mode == require_mode
}

/// The grant scope must equal the require scope or be a proper dotted ancestor.
/// The mandatory `+ "."` boundary keeps matching on whole segments so `run`
/// subsumes `run.command` but not `runner`.
fn scope_subsumes(grant_scope: &str, require_scope: &str) -> bool {
    grant_scope == require_scope
        || require_scope
            .strip_prefix(grant_scope)
            .is_some_and(|rest| rest.starts_with('.'))
}

/// Whether a single grant covers a require on both the mode and scope axes.
/// One grant must independently satisfy both — there is no cross-grant
/// composition.
pub fn satisfies(grant: &str, require: &str) -> bool {
    let (grant_mode, grant_scope) = split_mode(grant);
    let (require_mode, require_scope) = split_mode(require);
    mode_satisfies(grant_mode, require_mode) && scope_subsumes(grant_scope, require_scope)
}

/// Whether any grant in the set satisfies the require. An empty set denies.
pub fn granted_satisfies(granted: &HashSet<String>, require: &str) -> bool {
    granted.iter().any(|grant| satisfies(grant, require))
}

#[cfg(test)]
mod tests {
    use super::*;

    const CORPUS: &str = include_str!("../../../spec/capability-tests.json");

    #[derive(serde::Deserialize)]
    struct Case {
        description: String,
        #[serde(default)]
        grant: Option<String>,
        #[serde(default)]
        granted: Option<Vec<String>>,
        require: String,
        expected: bool,
    }

    #[test]
    fn matches_canonical_capability_corpus() {
        let cases: Vec<Case> = serde_json::from_str(CORPUS).expect("corpus parses");
        let mut failures = Vec::new();
        for case in &cases {
            let granted: HashSet<String> = match (&case.grant, &case.granted) {
                (Some(grant), _) => std::iter::once(grant.clone()).collect(),
                (None, Some(set)) => set.iter().cloned().collect(),
                (None, None) => HashSet::new(),
            };
            let got = granted_satisfies(&granted, &case.require);
            if got != case.expected {
                failures.push(format!(
                    "case '{}'\n  granted:  {:?}\n  require:  {}\n  expected: {}\n  got:      {}",
                    case.description, granted, case.require, case.expected, got
                ));
            }
        }
        assert!(
            failures.is_empty(),
            "{} of {} capability corpus cases failed:\n{}",
            failures.len(),
            cases.len(),
            failures.join("\n")
        );
    }
}
