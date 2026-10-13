//! `data-each` expansions as a renderer sees them: where the copies sit, how they are
//! keyed, and how to patch the previous render's copies into this one.

use std::collections::{HashMap, HashSet};

use serde_json::Value;

use crate::node::js_number_to_string;

/// How a repeat's copies are identified across updates.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RepeatMode {
    /// Every copy has a distinct `data-key`; updates patch by key.
    Keyed,
    /// `data-key` produced a duplicate or invalid key, so copies fall back to position.
    Index,
    /// No `data-key`; updates replace the repeated range.
    Replace,
}

impl RepeatMode {
    pub fn as_str(self) -> &'static str {
        match self {
            RepeatMode::Keyed => "keyed",
            RepeatMode::Index => "index",
            RepeatMode::Replace => "replace",
        }
    }
}

/// A copy's identity: a string or a finite number. Index keys are numbers.
pub type RepeatKey = Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RepeatPatchKind {
    Remove,
    Insert,
    Reuse,
    Move,
}

impl RepeatPatchKind {
    pub fn as_str(self) -> &'static str {
        match self {
            RepeatPatchKind::Remove => "remove",
            RepeatPatchKind::Insert => "insert",
            RepeatPatchKind::Reuse => "reuse",
            RepeatPatchKind::Move => "move",
        }
    }
}

/// One step of turning the previous render's copies into this render's. `from` is set
/// for `remove`, `reuse`, and `move`; `to` for `insert`, `reuse`, and `move`.
#[derive(Debug, Clone, PartialEq)]
pub struct RepeatPatchOp {
    pub op: RepeatPatchKind,
    pub key: RepeatKey,
    pub from: Option<usize>,
    pub to: Option<usize>,
}

/// Identifies a repeat across renders: its template's source path and the keys of the
/// copies enclosing it.
#[derive(Debug, Clone, PartialEq)]
pub struct RepeatSite {
    pub template: Vec<usize>,
    pub within: Vec<RepeatKey>,
}

impl RepeatSite {
    /// A stable string for the site, for keying per-instance repeat state.
    pub fn id(&self) -> String {
        let within: Vec<String> = self.within.iter().map(key_token).collect();
        let template: Vec<String> = self.template.iter().map(|i| i.to_string()).collect();
        format!("{}|{}", template.join("."), within.join("\u{0}"))
    }
}

/// One `data-each` expansion in a bound tree.
#[derive(Debug, Clone, PartialEq)]
pub struct FragmentRepeat {
    pub site: RepeatSite,
    /// Child-index path of the copies' parent in the bound tree; empty is the root.
    pub path: Vec<usize>,
    /// Index of the first copy among the parent's children.
    pub start: usize,
    pub count: usize,
    /// The `data-each` source, verbatim.
    pub expression: String,
    /// The `data-key` source, or `None` when the template has none.
    pub key: Option<String>,
    pub mode: RepeatMode,
    pub keys: Vec<RepeatKey>,
    pub patch: Vec<RepeatPatchOp>,
}

/// What went wrong with a repeat's keys, when something did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RepeatKeyProblem {
    InvalidKey,
    DuplicateKey,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RepeatKeyResolution {
    pub mode: RepeatMode,
    pub keys: Vec<RepeatKey>,
    pub problem: Option<RepeatKeyProblem>,
}

fn key_token(key: &RepeatKey) -> String {
    match key {
        Value::Number(n) => format!("n:{}", js_number_to_string(n.as_f64().unwrap_or(0.0))),
        Value::String(s) => format!("s:{s}"),
        other => format!("x:{other}"),
    }
}

fn index_keys(count: usize) -> Vec<RepeatKey> {
    (0..count).map(Value::from).collect()
}

/// Index keys for a repeat with no `data-key`.
pub fn replace_keys(count: usize) -> Vec<RepeatKey> {
    index_keys(count)
}

/// Resolves a repeat's keys from each copy's evaluated `data-key`. A key must be a string
/// or a finite number. One invalid or duplicated key drops the whole repeat to index
/// keying, because a key set with a hole in it cannot say which copy is which.
pub fn resolve_repeat_keys(values: Vec<Value>) -> RepeatKeyResolution {
    let count = values.len();
    let mut seen = HashSet::new();
    let mut duplicate = false;
    for value in &values {
        let valid = match value {
            Value::String(_) => true,
            Value::Number(n) => n.as_f64().is_some_and(f64::is_finite),
            _ => false,
        };
        if !valid {
            return RepeatKeyResolution {
                mode: RepeatMode::Index,
                keys: index_keys(count),
                problem: Some(RepeatKeyProblem::InvalidKey),
            };
        }
        if !seen.insert(key_token(value)) {
            duplicate = true;
        }
    }
    if duplicate {
        return RepeatKeyResolution {
            mode: RepeatMode::Index,
            keys: index_keys(count),
            problem: Some(RepeatKeyProblem::DuplicateKey),
        };
    }
    RepeatKeyResolution { mode: RepeatMode::Keyed, keys: values, problem: None }
}

/// The indices of `sequence` that form its longest strictly increasing subsequence, by
/// the patience method: binary search for the leftmost tail not less than the value,
/// then walk predecessors back from the last tail. Every runtime runs this exact
/// procedure, so a sequence with more than one longest subsequence resolves the same way
/// everywhere.
pub fn longest_increasing_subsequence(sequence: &[usize]) -> Vec<usize> {
    let mut tails: Vec<usize> = Vec::new();
    let mut predecessors: Vec<Option<usize>> = vec![None; sequence.len()];
    for (i, &value) in sequence.iter().enumerate() {
        let (mut lo, mut hi) = (0, tails.len());
        while lo < hi {
            let mid = (lo + hi) / 2;
            if sequence[tails[mid]] < value {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        predecessors[i] = if lo > 0 { Some(tails[lo - 1]) } else { None };
        if lo == tails.len() {
            tails.push(i);
        } else {
            tails[lo] = i;
        }
    }
    let mut result = vec![0; tails.len()];
    let mut cursor = tails.last().copied();
    for slot in result.iter_mut().rev() {
        let at = cursor.expect("a predecessor exists for every position in the subsequence");
        *slot = at;
        cursor = predecessors[at];
    }
    result
}

/// Computes how a host turns the previous render of a repeat into the next one.
///
/// With no previous render every copy is an insert. When either render is `replace`, or
/// the mode changed, the previous copies are all removed and the next ones all inserted.
/// Otherwise copies match by key: removes first, in previous order; then every next copy
/// in order is an `insert`, a `reuse` (kept, already in relative order), or a `move`
/// (kept, but relocated). The copies marked `reuse` are the longest run already in
/// order, so a single removal or insertion moves nothing.
pub fn diff_repeat(
    previous: Option<(RepeatMode, &[RepeatKey])>,
    next: (RepeatMode, &[RepeatKey]),
) -> Vec<RepeatPatchOp> {
    let (next_mode, next_keys) = next;
    let insert = |key: &RepeatKey, to: usize| RepeatPatchOp {
        op: RepeatPatchKind::Insert,
        key: key.clone(),
        from: None,
        to: Some(to),
    };
    let remove = |key: &RepeatKey, from: usize| RepeatPatchOp {
        op: RepeatPatchKind::Remove,
        key: key.clone(),
        from: Some(from),
        to: None,
    };

    let Some((previous_mode, previous_keys)) = previous else {
        return next_keys.iter().enumerate().map(|(to, key)| insert(key, to)).collect();
    };

    let mut ops = Vec::new();
    if next_mode == RepeatMode::Replace || previous_mode != next_mode {
        ops.extend(previous_keys.iter().enumerate().map(|(from, key)| remove(key, from)));
        ops.extend(next_keys.iter().enumerate().map(|(to, key)| insert(key, to)));
        return ops;
    }

    let previous_index: HashMap<String, usize> = previous_keys
        .iter()
        .enumerate()
        .map(|(from, key)| (key_token(key), from))
        .collect();
    let next_tokens: HashSet<String> = next_keys.iter().map(key_token).collect();

    for (from, key) in previous_keys.iter().enumerate() {
        if !next_tokens.contains(&key_token(key)) {
            ops.push(remove(key, from));
        }
    }

    let mut kept_positions = Vec::new();
    let mut kept_from = Vec::new();
    for (to, key) in next_keys.iter().enumerate() {
        if let Some(&from) = previous_index.get(&key_token(key)) {
            kept_positions.push(to);
            kept_from.push(from);
        }
    }
    let stable: HashSet<usize> = longest_increasing_subsequence(&kept_from)
        .into_iter()
        .map(|i| kept_positions[i])
        .collect();

    for (to, key) in next_keys.iter().enumerate() {
        match previous_index.get(&key_token(key)) {
            None => ops.push(insert(key, to)),
            Some(&from) => ops.push(RepeatPatchOp {
                op: if stable.contains(&to) { RepeatPatchKind::Reuse } else { RepeatPatchKind::Move },
                key: key.clone(),
                from: Some(from),
                to: Some(to),
            }),
        }
    }
    ops
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subsequence_of_an_empty_sequence_is_empty() {
        assert!(longest_increasing_subsequence(&[]).is_empty());
    }

    #[test]
    fn subsequence_resolves_ties_toward_the_last_tail() {
        assert_eq!(longest_increasing_subsequence(&[1, 0]), vec![1]);
        assert_eq!(longest_increasing_subsequence(&[4, 0, 2, 1]), vec![1, 3]);
    }
}
