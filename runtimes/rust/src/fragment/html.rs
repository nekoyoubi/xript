//! The HTML source reader: tokens in, unsanitized fragment tree out.
//!
//! Vocabulary rules are applied afterwards by `sanitize_tree`, so this stage
//! decides only structure — where a tag started, where it ended, and what the
//! parser considers raw text.

use serde_json::Value;

use super::vocabulary::MAX_TREE_DEPTH;
use super::rules::{
    sanitize_style_block, RAWTEXT_ELEMENTS, STRIPPED_ELEMENTS, SVG_TEXT_ELEMENTS, VOID_ELEMENTS,
};
use super::profiles::{any_vocabulary_declares, speaks_html, FormatProfile};
use super::tokenizer::{decode_text_entities, tokenize, Attribute, Token};
use super::tree::{FragmentElement, FragmentNode, FragmentTree, Props};

#[derive(Debug, Clone, Default, PartialEq)]
pub struct StrippedAttribute {
    pub element: String,
    pub attribute: String,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct SanitizeResult {
    pub html: String,
    pub stripped_elements: Vec<String>,
    pub stripped_attributes: Vec<StrippedAttribute>,
}



fn collect_style_content(tokens: &[Token], style_open_index: usize) -> String {
    let mut content = String::new();
    for token in &tokens[style_open_index + 1..] {
        match token {
            Token::Close { tag, .. } if tag == "style" => break,
            Token::Text { value } => content.push_str(value),
            _ => {}
        }
    }
    content
}

/// Parses an HTML source into an unsanitized fragment tree, preserving node and
/// prop name casing. Vocabulary rules are applied afterwards by `sanitize_tree`.
///
/// HTML's raw-text elements (`<style>`, and every element the vocabulary strips
/// outright, such as `<script>`) do not have their content parsed as markup. A
/// `</div>` inside one is text, not a close tag; parsing it as markup would let
/// content escape the region that was supposed to swallow it.
pub fn html_to_tree(input: &str, profile: Option<&FormatProfile>) -> FragmentTree {
    let tokens = tokenize(input);
    let mut root = FragmentElement {
        name: "#root".to_string(),
        props: Props::new(),
        children: Vec::new(),
        self_closing: false,
    };
    // The stack holds a path of indices into the tree under construction, since
    // Rust cannot hold several mutable borrows into the same tree at once.
    let mut stack: Vec<usize> = Vec::new();
    let mut skip_until = String::new();
    let mut skip_is_raw_text = false;

    let html_rules_apply = |raw_name: &str| -> bool {
        match profile {
            None => true,
            Some(profile) => {
                speaks_html(profile) && !any_vocabulary_declares(profile, raw_name)
            }
        }
    };

    for idx in 0..tokens.len() {
        let token = &tokens[idx];

        if !skip_until.is_empty() {
            if let Token::Close { tag, .. } = token
                && tag == &skip_until
            {
                skip_until.clear();
                continue;
            }
            // A stripped element that never closes must not eat the rest of the
            // document: an ancestor's close tag implicitly closes it. The stripped
            // element was never pushed, so anything on the stack path is an
            // ancestor. Raw-text elements keep skipping, matching the parser.
            let ancestor_closes = match token {
                Token::Close { tag, .. } if !skip_is_raw_text => (0..=stack.len())
                    .any(|depth| name_at(&root, &stack[..depth]).eq_ignore_ascii_case(tag)),
                _ => false,
            };
            if !ancestor_closes {
                continue;
            }
            skip_until.clear();
        }

        match token {
            Token::Text { value } => {
                current_mut(&mut root, &stack).children.push(FragmentNode::text(value.clone()));
            }
            Token::Comment { .. } => {}
            Token::Open { tag, raw_tag, attributes, self_closing } => {
                // A tree deeper than the walker will descend into is never worth
                // building. Beyond the cost of parsing it, `FragmentNode`'s derived
                // `Drop` is recursive, so merely releasing a deeply nested tree
                // overflows the stack and aborts the process.
                if stack.len() >= MAX_TREE_DEPTH {
                    continue;
                }

                let element = FragmentElement {
                    name: raw_tag.clone(),
                    props: attributes_to_props(attributes),
                    children: Vec::new(),
                    self_closing: *self_closing && !VOID_ELEMENTS.contains(tag.as_str()),
                };

                let parent = current_mut(&mut root, &stack);
                let child_index = parent.children.len();
                parent.children.push(FragmentNode::Element(element));

                let raw_text = html_rules_apply(raw_tag)
                    && (tag == "style" || STRIPPED_ELEMENTS.contains(tag.as_str()))
                    && !(SVG_TEXT_ELEMENTS.contains(&tag.as_str()) && inside_svg(&root, &stack));

                if raw_text {
                    if tag == "style" {
                        let cleaned = sanitize_style_block(&collect_style_content(&tokens, idx));
                        if !cleaned.is_empty() {
                            let mut path = stack.clone();
                            path.push(child_index);
                            current_mut(&mut root, &path)
                                .children
                                .push(FragmentNode::text(cleaned));
                        }
                    }
                    if !*self_closing && !VOID_ELEMENTS.contains(tag.as_str()) {
                        skip_until = tag.clone();
                        skip_is_raw_text = RAWTEXT_ELEMENTS.contains(tag.as_str());
                    }
                    continue;
                }

                if *self_closing || VOID_ELEMENTS.contains(tag.as_str()) {
                    continue;
                }
                stack.push(child_index);
            }
            Token::Close { tag, .. } => {
                if VOID_ELEMENTS.contains(tag.as_str()) {
                    continue;
                }
                let mut depth = stack.len();
                while depth > 0 && name_at(&root, &stack[..depth]).to_lowercase() != *tag {
                    depth -= 1;
                }
                if depth > 0 {
                    stack.truncate(depth - 1);
                }
            }
        }
    }

    root.children
}

fn current_mut<'a>(root: &'a mut FragmentElement, path: &[usize]) -> &'a mut FragmentElement {
    let mut node = root;
    for &index in path {
        node = match &mut node.children[index] {
            FragmentNode::Element(element) => element,
            FragmentNode::Text { .. } => unreachable!("only elements are pushed onto the stack"),
        };
    }
    node
}

/// Whether an open `<svg>` encloses the insertion point. Inside SVG the HTML
/// parser reads `<title>` as a foreign element with ordinary content, not as the
/// document title's raw-text region.
fn inside_svg(root: &FragmentElement, stack: &[usize]) -> bool {
    (1..=stack.len()).any(|depth| name_at(root, &stack[..depth]).eq_ignore_ascii_case("svg"))
}

fn name_at<'a>(root: &'a FragmentElement, path: &[usize]) -> &'a str {
    let mut node = root;
    for &index in path {
        node = match &node.children[index] {
            FragmentNode::Element(element) => element,
            FragmentNode::Text { .. } => unreachable!("only elements are pushed onto the stack"),
        };
    }
    &node.name
}

/// A repeated attribute name resolves to its first occurrence: the parser discards
/// a duplicate rather than overwriting the one already collected. Taking the last
/// would disagree with what a browser reads out of the same source, so a value the
/// browser never honours could be the one that gets validated.
fn attributes_to_props(attributes: &[Attribute]) -> Props {
    let mut props = Props::new();
    for attr in attributes {
        if props.get(&attr.name).is_some() {
            continue;
        }
        let value = if attr.value.is_empty() {
            Value::Bool(true)
        } else {
            Value::String(decode_text_entities(&attr.value))
        };
        props.set(attr.name.clone(), value);
    }
    props
}
