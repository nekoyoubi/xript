//! The command buffer's consumer-facing shape.
//!
//! Parsing, vocabulary checks, and value sanitization all happen in a runtime.
//! What lands here is what a renderer applies: a finalized op with a parsed
//! target.

use serde_json::Value;

use crate::node::{FragmentElement, FragmentNode, Props};

/// How an op names the node it targets.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NodeRef {
    /// A node id, without the leading `#`. Resolvable in every vocabulary.
    Id(String),
    /// A child-index path into the tree, the same grammar as
    /// [`FragmentCondition::path`](crate::FragmentCondition). Resolvable in every
    /// vocabulary, and the only way to reach a node that carries no `id`.
    Path(Vec<usize>),
    /// A CSS selector, meaningful only under an HTML vocabulary.
    Selector(String),
}

/// `^#[A-Za-z][A-Za-z0-9_.:-]*$`, spelled out so the contract crate carries no
/// regex engine. The grammar is normative and shared with every runtime.
fn is_id_reference(target: &str) -> bool {
    let Some(body) = target.strip_prefix('#') else { return false };
    let mut chars = body.chars();
    match chars.next() {
        Some(first) if first.is_ascii_alphabetic() => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | ':' | '-'))
}

/// Parses a raw target string.
///
/// `#name` is an id. `@0.2.1` is a child-index path — the sigil is `@` because no
/// CSS selector starts with one, so adding the grammar cannot reinterpret a target
/// that already parsed as a selector. Everything else stays a selector.
pub fn parse_node_ref(target: &str) -> NodeRef {
    if is_id_reference(target) {
        return NodeRef::Id(target[1..].to_string());
    }
    if let Some(path) = parse_path_reference(target) {
        return NodeRef::Path(path);
    }
    NodeRef::Selector(target.to_string())
}

fn parse_path_reference(target: &str) -> Option<Vec<usize>> {
    let body = target.strip_prefix('@')?;
    if body.is_empty() {
        return None;
    }
    body.split('.').map(|segment| segment.parse::<usize>().ok()).collect()
}

/// Renders a path back into its target string, so a renderer can name a node the
/// same way an op names one when it dispatches an event.
pub fn path_reference(path: &[usize]) -> String {
    let mut rendered = String::from("@");
    for (index, segment) in path.iter().enumerate() {
        if index > 0 {
            rendered.push('.');
        }
        rendered.push_str(&segment.to_string());
    }
    rendered
}

#[derive(Debug, Clone, PartialEq)]
pub struct FragmentOp {
    pub op: String,
    /// The raw target string the mod passed.
    pub selector: String,
    pub target: NodeRef,
    pub prop: Option<String>,
    /// Deprecated alias of `prop`, populated only for `setAttr`.
    pub attr: Option<String>,
    pub value: Option<Value>,
}

/// Resolves an op target against a tree, returning the child-index path of the
/// node it names.
///
/// `by: "id"` walks for a matching `id` prop; `by: "path"` is checked for
/// existence. A `by: "selector"` target resolves to nothing outside a DOM
/// renderer, which is what §5.1 requires: an unresolvable target is a no-op, not
/// an error.
pub fn resolve_target(tree: &[FragmentNode], target: &NodeRef) -> Option<Vec<usize>> {
    match target {
        NodeRef::Id(id) => find_by_id(tree, id, &mut Vec::new()),
        NodeRef::Path(path) => node_at(tree, path).map(|_| path.clone()),
        NodeRef::Selector(_) => None,
    }
}

fn find_by_id(nodes: &[FragmentNode], id: &str, path: &mut Vec<usize>) -> Option<Vec<usize>> {
    for (index, node) in nodes.iter().enumerate() {
        let Some(element) = node.as_element() else { continue };
        path.push(index);
        if element.props.get_str("id") == Some(id) {
            return Some(path.clone());
        }
        if let Some(found) = find_by_id(&element.children, id, path) {
            return Some(found);
        }
        path.pop();
    }
    None
}

/// The node a child-index path addresses, or `None` when the path runs off the
/// tree.
pub fn node_at<'a>(tree: &'a [FragmentNode], path: &[usize]) -> Option<&'a FragmentNode> {
    let (first, rest) = path.split_first()?;
    let mut node = tree.get(*first)?;
    for index in rest {
        node = node.as_element()?.children.get(*index)?;
    }
    Some(node)
}

fn node_at_mut<'a>(tree: &'a mut [FragmentNode], path: &[usize]) -> Option<&'a mut FragmentElement> {
    let (first, rest) = path.split_first()?;
    let mut node = tree.get_mut(*first)?;
    for index in rest {
        node = match node {
            FragmentNode::Element(element) => element.children.get_mut(*index)?,
            FragmentNode::Text { .. } => return None,
        };
    }
    match node {
        FragmentNode::Element(element) => Some(element),
        FragmentNode::Text { .. } => None,
    }
}

/// Applies a finalized op batch to a tree in list order.
///
/// The contract ops (`toggle`, `setText`, `setProp`, `removeAttr`,
/// `replaceChildren`, plus `setAttr` as the alias of `setProp`) are handled;
/// anything else is ignored, as §1 requires of
/// an unknown op name. `toggle` writes `data-if-visible`, which a renderer reads
/// alongside `conditions` — it is a rendering decision, not a prune, for the same
/// reason `data-if` is not one.
pub fn apply_ops(tree: &mut Vec<FragmentNode>, ops: &[FragmentOp]) {
    for op in ops {
        let Some(path) = resolve_target(tree, &op.target) else { continue };
        match op.op.as_str() {
            "toggle" => {
                let visible = op.value.as_ref().and_then(Value::as_bool).unwrap_or(false);
                if let Some(element) = node_at_mut(tree, &path) {
                    element.props.set("data-if-visible", Value::Bool(visible));
                }
            }
            "setText" => {
                let text = op
                    .value
                    .as_ref()
                    .map(crate::node::js_string)
                    .unwrap_or_default();
                if let Some(element) = node_at_mut(tree, &path) {
                    element.children = vec![FragmentNode::text(text)];
                }
            }
            "setProp" | "setAttr" => {
                let (Some(prop), Some(value)) = (op.prop.as_ref().or(op.attr.as_ref()), op.value.as_ref())
                else {
                    continue;
                };
                if let Some(element) = node_at_mut(tree, &path) {
                    element.props.set(prop.clone(), value.clone());
                }
            }
            "removeAttr" => {
                let Some(prop) = op.prop.as_ref().or(op.attr.as_ref()) else { continue };
                if let Some(element) = node_at_mut(tree, &path) {
                    element.props.remove(prop);
                }
            }
            "replaceChildren" => {
                let children = match op.value.as_ref() {
                    Some(Value::String(text)) => vec![FragmentNode::text(text.clone())],
                    Some(Value::Array(items)) => {
                        items.iter().filter_map(jsml_value_to_node).collect()
                    }
                    _ => Vec::new(),
                };
                if let Some(element) = node_at_mut(tree, &path) {
                    element.children = children;
                }
            }
            _ => {}
        }
    }
}

/// Reads one J5ML node out of the sanitized value a `replaceChildren` carries.
///
/// The runtime has already sanitized these against the fragment's own vocabulary,
/// so this is a shape read and nothing else.
fn jsml_value_to_node(value: &Value) -> Option<FragmentNode> {
    if let Value::String(text) = value {
        return Some(FragmentNode::text(text.clone()));
    }
    let items = value.as_array()?;
    let name = items.first()?.as_str()?;

    let mut props = Props::new();
    let mut child_start = 1usize;
    if let Some(Value::Object(members)) = items.get(1) {
        for (key, member) in members {
            props.set(key.clone(), member.clone());
        }
        child_start = 2;
    }

    Some(FragmentNode::Element(FragmentElement {
        name: name.to_string(),
        props,
        children: items[child_start..].iter().filter_map(jsml_value_to_node).collect(),
        self_closing: false,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tree() -> Vec<FragmentNode> {
        vec![FragmentNode::Element(FragmentElement {
            name: "Block".into(),
            props: Props::new(),
            children: vec![
                FragmentNode::text("first"),
                FragmentNode::Element(FragmentElement {
                    name: "Paragraph".into(),
                    props: [("id".to_string(), json!("warn"))].into_iter().collect(),
                    children: vec![FragmentNode::text("hi")],
                    self_closing: false,
                }),
            ],
            self_closing: false,
        })]
    }

    #[test]
    fn an_id_target_parses_as_an_id() {
        assert_eq!(parse_node_ref("#warn"), NodeRef::Id("warn".into()));
    }

    #[test]
    fn a_path_target_parses_as_a_path() {
        assert_eq!(parse_node_ref("@0.1"), NodeRef::Path(vec![0, 1]));
        assert_eq!(parse_node_ref("@0"), NodeRef::Path(vec![0]));
    }

    /// The sigil was chosen so adding the grammar could not reinterpret a target
    /// that already parsed as a selector.
    #[test]
    fn a_selector_target_is_untouched_by_the_path_grammar() {
        assert_eq!(parse_node_ref(".warn > p"), NodeRef::Selector(".warn > p".into()));
        assert_eq!(parse_node_ref("@"), NodeRef::Selector("@".into()));
        assert_eq!(parse_node_ref("@media"), NodeRef::Selector("@media".into()));
    }

    #[test]
    fn a_path_round_trips_through_its_target_string() {
        assert_eq!(parse_node_ref(&path_reference(&[0, 2, 1])), NodeRef::Path(vec![0, 2, 1]));
    }

    #[test]
    fn an_id_target_resolves_to_its_path() {
        assert_eq!(resolve_target(&tree(), &NodeRef::Id("warn".into())), Some(vec![0, 1]));
    }

    #[test]
    fn a_path_target_resolves_only_when_the_node_exists() {
        assert_eq!(resolve_target(&tree(), &NodeRef::Path(vec![0, 1])), Some(vec![0, 1]));
        assert_eq!(resolve_target(&tree(), &NodeRef::Path(vec![0, 9])), None);
    }

    /// A path reaches a node that carries no `id`, which is the gap the variant
    /// exists to close.
    #[test]
    fn set_prop_applies_through_a_path_target() {
        let mut tree = tree();
        apply_ops(
            &mut tree,
            &[FragmentOp {
                op: "setProp".into(),
                selector: "@0".into(),
                target: NodeRef::Path(vec![0]),
                prop: Some("title".into()),
                attr: None,
                value: Some(json!("Live")),
            }],
        );
        let block = tree[0].as_element().unwrap();
        assert_eq!(block.props.get("title"), Some(&json!("Live")));
    }

    #[test]
    fn set_text_replaces_children_as_text() {
        let mut tree = tree();
        apply_ops(
            &mut tree,
            &[FragmentOp {
                op: "setText".into(),
                selector: "#warn".into(),
                target: NodeRef::Id("warn".into()),
                prop: None,
                attr: None,
                value: Some(json!("<b>bye</b>")),
            }],
        );
        let target = node_at(&tree, &[0, 1]).unwrap().as_element().unwrap();
        assert_eq!(target.children, vec![FragmentNode::text("<b>bye</b>")]);
    }

    #[test]
    fn remove_attr_removes_the_prop() {
        let mut tree = tree();
        apply_ops(
            &mut tree,
            &[FragmentOp {
                op: "removeAttr".into(),
                selector: "#warn".into(),
                target: NodeRef::Id("warn".into()),
                prop: Some("id".into()),
                attr: Some("id".into()),
                value: None,
            }],
        );
        let target = node_at(&tree, &[0, 1]).unwrap().as_element().unwrap();
        assert_eq!(target.props.get("id"), None);
    }

    #[test]
    fn replace_children_with_an_empty_list_clears() {
        let mut tree = tree();
        apply_ops(
            &mut tree,
            &[FragmentOp {
                op: "replaceChildren".into(),
                selector: "@0".into(),
                target: NodeRef::Path(vec![0]),
                prop: None,
                attr: None,
                value: Some(json!([])),
            }],
        );
        assert!(tree[0].as_element().unwrap().children.is_empty());
    }

    #[test]
    fn an_unresolvable_target_is_a_no_op_rather_than_an_error() {
        let mut tree = tree();
        let before = tree.clone();
        apply_ops(
            &mut tree,
            &[FragmentOp {
                op: "setProp".into(),
                selector: "#nope".into(),
                target: NodeRef::Id("nope".into()),
                prop: Some("title".into()),
                attr: None,
                value: Some(json!("x")),
            }],
        );
        assert_eq!(tree, before);
    }

    #[test]
    fn an_unknown_op_name_is_ignored_rather_than_abandoning_the_batch() {
        let mut tree = tree();
        apply_ops(
            &mut tree,
            &[
                FragmentOp {
                    op: "somethingNew".into(),
                    selector: "@0".into(),
                    target: NodeRef::Path(vec![0]),
                    prop: None,
                    attr: None,
                    value: None,
                },
                FragmentOp {
                    op: "setProp".into(),
                    selector: "@0".into(),
                    target: NodeRef::Path(vec![0]),
                    prop: Some("title".into()),
                    attr: None,
                    value: Some(json!("Live")),
                },
            ],
        );
        assert_eq!(tree[0].as_element().unwrap().props.get("title"), Some(&json!("Live")));
    }
}
