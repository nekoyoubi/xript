//! The fragment tree's runtime-side projections.
//!
//! The node shape itself lives in `xript-tree`, engine-free, so a renderer can
//! name it without building QuickJS. What stays here is what needs a runtime: the
//! J5ML and HTML serializations, and the order-preserving JSON reader that parses
//! a JSML source into the shape.

use j5ml::{Element, Node};
use serde_json::Value;
use serde::de::{self, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer};

pub use xript_tree::node::{
    is_forbidden_prop_name, js_number_to_string, js_string, matches_json_type, FragmentElement,
    FragmentNode, FragmentTree, Props, FORBIDDEN_PROP_NAMES,
};

use super::rules::{escape_attr_value, escape_html, is_valid_attribute_name, VOID_ELEMENTS};

/// Projects a node into the published J5ML tree type. Prop order is not
/// representable in [`j5ml::Element`], whose attribute bag is a map; use
/// [`tree_to_jsml`] when order must survive.
///
/// Typed props round-trip intact: J5ML widens JsonML's attribute-value grammar to
/// any JSON value, so an array or object prop survives the projection rather than
/// being stringified.
pub fn node_to_j5ml(node: &FragmentNode) -> Node {
    match node {
        FragmentNode::Text { value, .. } => Node::Text(value.clone()),
        FragmentNode::Element(element) => Node::Element(Element {
            name: element.name.clone(),
            attrs: element
                .props
                .iter()
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect(),
            children: element.children.iter().map(node_to_j5ml).collect(),
        }),
    }
}

pub fn tree_to_j5ml(tree: &[FragmentNode]) -> Vec<Node> {
    tree.iter().map(node_to_j5ml).collect()
}

pub fn tree_to_html(tree: &[FragmentNode]) -> String {
    tree.iter().map(node_to_html).collect()
}

fn node_to_html(node: &FragmentNode) -> String {
    let element = match node {
        FragmentNode::Text { value, .. } => return escape_html(value),
        FragmentNode::Element(element) => element,
    };

    let mut attrs = String::new();
    for (key, value) in element.props.iter() {
        if !is_valid_attribute_name(key) {
            continue;
        }
        match value {
            Value::Bool(true) => attrs.push_str(&format!(" {key}")),
            Value::Bool(false) | Value::Null => {}
            other => attrs.push_str(&format!(" {key}=\"{}\"", escape_attr_value(&js_string(other)))),
        }
    }

    if VOID_ELEMENTS.contains(element.name.as_str())
        || (element.self_closing && element.children.is_empty())
    {
        return format!("<{}{} />", element.name, attrs);
    }

    let children: String = element.children.iter().map(node_to_html).collect();
    format!("<{0}{1}>{2}</{0}>", element.name, attrs, children)
}

/// Serializes a tree into J5ML array form as raw JSON.
///
/// This is the untyped counterpart to [`tree_to_j5ml`]: both emit the same
/// document, and they differ only in what they hand back. Reach for
/// [`tree_to_j5ml`] when the consumer wants the published [`j5ml::Node`] type,
/// and for this when it wants [`serde_json::Value`].
///
/// Serialization runs through `j5ml` rather than writing the arrays directly,
/// because J5ML normatively orders attribute names by Unicode code point on
/// serialization. Emitting props in tree order produced documents that did not
/// conform to the format this runtime declares it speaks.
pub fn tree_to_jsml(tree: &[FragmentNode]) -> Vec<serde_json::Value> {
    tree.iter().map(node_to_jsml).collect()
}

fn node_to_jsml(node: &FragmentNode) -> serde_json::Value {
    let serialized = j5ml::to_string(&node_to_j5ml(node))
        .expect("a fragment tree is always representable as J5ML");
    serde_json::from_str(&serialized).expect("j5ml emits canonical JSON")
}

pub fn attribute_value_to_json(value: &Value) -> serde_json::Value {
    value.clone()
}

/// A JSON value that remembers object key order, so a JSML source's prop order
/// survives into the tree. `serde_json::Value` normalizes object keys, which
/// would reorder the attributes of the HTML projection.
#[derive(Debug, Clone, PartialEq)]
pub enum OrderedJson {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<OrderedJson>),
    Object(Vec<(String, OrderedJson)>),
}

impl<'de> Deserialize<'de> for OrderedJson {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct OrderedJsonVisitor;

        impl<'de> Visitor<'de> for OrderedJsonVisitor {
            type Value = OrderedJson;

            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                formatter.write_str("any JSON value")
            }

            fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
                Ok(OrderedJson::Null)
            }

            fn visit_none<E: de::Error>(self) -> Result<Self::Value, E> {
                Ok(OrderedJson::Null)
            }

            fn visit_bool<E: de::Error>(self, v: bool) -> Result<Self::Value, E> {
                Ok(OrderedJson::Bool(v))
            }

            fn visit_i64<E: de::Error>(self, v: i64) -> Result<Self::Value, E> {
                Ok(OrderedJson::Number(v as f64))
            }

            fn visit_u64<E: de::Error>(self, v: u64) -> Result<Self::Value, E> {
                Ok(OrderedJson::Number(v as f64))
            }

            fn visit_f64<E: de::Error>(self, v: f64) -> Result<Self::Value, E> {
                Ok(OrderedJson::Number(v))
            }

            fn visit_str<E: de::Error>(self, v: &str) -> Result<Self::Value, E> {
                Ok(OrderedJson::String(v.to_string()))
            }

            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
                let mut items = Vec::new();
                while let Some(item) = seq.next_element()? {
                    items.push(item);
                }
                Ok(OrderedJson::Array(items))
            }

            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                let mut members = Vec::new();
                while let Some((key, value)) = map.next_entry::<String, OrderedJson>()? {
                    members.push((key, value));
                }
                Ok(OrderedJson::Object(members))
            }
        }

        deserializer.deserialize_any(OrderedJsonVisitor)
    }
}

impl OrderedJson {
    pub fn from_json(value: &serde_json::Value) -> Self {
        match value {
            serde_json::Value::Null => OrderedJson::Null,
            serde_json::Value::Bool(b) => OrderedJson::Bool(*b),
            serde_json::Value::Number(n) => OrderedJson::Number(n.as_f64().unwrap_or(0.0)),
            serde_json::Value::String(s) => OrderedJson::String(s.clone()),
            serde_json::Value::Array(items) => {
                OrderedJson::Array(items.iter().map(OrderedJson::from_json).collect())
            }
            serde_json::Value::Object(members) => OrderedJson::Object(
                members.iter().map(|(k, v)| (k.clone(), OrderedJson::from_json(v))).collect(),
            ),
        }
    }

    fn is_plain_object(&self) -> bool {
        matches!(self, OrderedJson::Object(_))
    }
}

/// Builds a JSON number, preferring an integer representation so an integral
/// value serializes without a fractional part. Runtimes disagree about `100.0`;
/// the shared corpus holds every one of them to `100`.
fn json_number(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() < 9.007_199_254_740_992e15 {
        return Value::Number((value as i64).into());
    }
    serde_json::Number::from_f64(value)
        .map(Value::Number)
        .unwrap_or(Value::Null)
}

/// Deep-copies a value into the prop-value domain, dropping anything JSON
/// cannot express.
pub fn to_prop_value(value: &OrderedJson) -> Option<Value> {
    match value {
        OrderedJson::Null => Some(Value::Null),
        OrderedJson::Bool(b) => Some(Value::Bool(*b)),
        OrderedJson::Number(n) => Some(json_number(*n)),
        OrderedJson::String(s) => Some(Value::String(s.clone())),
        OrderedJson::Array(items) => {
            Some(Value::Array(items.iter().filter_map(to_prop_value).collect()))
        }
        OrderedJson::Object(members) => {
            let mut map = serde_json::Map::new();
            for (key, member) in members {
                if FORBIDDEN_PROP_NAMES.contains(&key.as_str()) {
                    continue;
                }
                if let Some(converted) = to_prop_value(member) {
                    map.insert(key.clone(), converted);
                }
            }
            Some(Value::Object(map))
        }
    }
}

pub fn jsml_to_tree(nodes: &[OrderedJson]) -> FragmentTree {
    nodes.iter().filter_map(jsml_node_to_tree).collect()
}

fn jsml_node_to_tree(node: &OrderedJson) -> Option<FragmentNode> {
    if let OrderedJson::String(value) = node {
        return Some(FragmentNode::text(value.clone()));
    }

    let OrderedJson::Array(items) = node else {
        return None;
    };
    let OrderedJson::String(name) = items.first()? else {
        return None;
    };

    let mut props = Props::new();
    let mut child_start = 1usize;

    if items.len() > 1 && items[1].is_plain_object() {
        let OrderedJson::Object(members) = &items[1] else { unreachable!() };
        for (key, raw) in members {
            if let Some(value) = to_prop_value(raw) {
                props.set(key.clone(), value);
            }
        }
        child_start = 2;
    }

    let children = items[child_start..].iter().filter_map(jsml_node_to_tree).collect();

    Some(FragmentNode::Element(FragmentElement {
        name: name.clone(),
        props,
        children,
        self_closing: false,
    }))
}
