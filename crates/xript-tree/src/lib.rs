//! `xript-tree/1` — the tree contract a fragment renderer consumes.
//!
//! A renderer turns a fragment into pixels, cells, or widgets. It does not load
//! mods, hold capabilities, evaluate expressions, or own storage. It walks a tree
//! it is handed and draws it, and it applies a list of mutations it is handed and
//! redraws.
//!
//! This crate is that seam, and it is engine-free on purpose. The node, condition,
//! diagnostic, and op shapes used to live inside `xript-runtime`, which pulls in a
//! full QuickJS build — so naming the type a renderer needs meant compiling a
//! JavaScript engine to draw a terminal widget, and the one Rust renderer in
//! existence went around the contract instead. The tree is produced after the
//! sandbox has finished and asks nothing of an engine, so the types belong here,
//! sibling to `xript-expr`.
//!
//! See `spec/renderers.md` for the normative contract.

pub mod contract;
pub mod diagnostic;
pub mod node;
pub mod ops;

pub use contract::{ContentType, FragmentCondition, RenderedFragment, CONTRACT_VERSION};
pub use diagnostic::{DiagnosticCode, DiagnosticSeverity, FragmentDiagnostic};
pub use node::{
    is_forbidden_prop_name, js_number_to_string, js_string, matches_json_type, FragmentElement,
    FragmentNode, FragmentTree, Props, FORBIDDEN_PROP_NAMES,
};
pub use ops::{
    apply_ops, node_at, parse_node_ref, path_reference, resolve_target, FragmentOp, NodeRef,
};
