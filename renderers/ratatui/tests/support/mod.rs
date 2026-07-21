#![allow(dead_code)]

//! Test support: the real runtime, producing real `xript-tree/1` fragments.
//!
//! These tests deliberately do not hand-build a tree. The fold this crate went
//! through only means anything if what the runtime actually emits is what the
//! renderer actually draws, so every test drives a JSML source and a data object
//! through `xript-runtime` and asserts on the cells that came out the far end.

use serde_json::{json, Value};
use xript_tree::RenderedFragment;

const FORMATS: &str = r#"{
  "application/x-ratatui+json": {
    "syntax": "jsml",
    "nodes": {
      "Block": {
        "props": {
          "title": { "type": "string" },
          "borders": { "type": "string", "enum": ["NONE","ALL","TOP","BOTTOM","LEFT","RIGHT"] },
          "border_type": { "type": "string", "enum": ["Plain","Rounded","Double","Thick"] },
          "border_style": { "type": "object" }
        }
      },
      "Layout": {
        "props": {
          "direction": { "type": "string", "enum": ["Horizontal","Vertical"] },
          "constraints": { "type": "array" }
        }
      },
      "Paragraph": {
        "props": { "alignment": { "type": "string", "enum": ["Left","Center","Right"] }, "style": { "type": "object" } }
      },
      "Line": { "props": { "style": { "type": "object" } } },
      "Span": { "children": "text", "props": { "style": { "type": "object" } } },
      "Gauge": {
        "children": "none",
        "bindTo": "ratio",
        "props": {
          "ratio": { "type": "number" },
          "gauge_style": { "type": "object" },
          "label": { "type": "string" },
          "style": { "type": "object" }
        }
      },
      "List": { "props": { "style": { "type": "object" } } },
      "Table": { "props": { "header": { "type": "array" }, "widths": { "type": "array" }, "style": { "type": "object" } } },
      "Row": { "props": {} },
      "Sparkline": {
        "children": "none",
        "bindTo": "data",
        "props": { "data": { "type": "array" }, "style": { "type": "object" } }
      }
    }
  }
}"#;

/// Loads a JSML source through the runtime and binds it against `data`.
pub fn rendered(source: &str, data: &Value) -> RenderedFragment {
    let bindings: Vec<Value> = data
        .as_object()
        .map(|map| map.keys().map(|key| json!({ "name": key, "path": key })).collect())
        .unwrap_or_default();

    rendered_with_declaration(
        source,
        json!({
            "id": "test-fragment",
            "slot": "main",
            "format": "application/x-ratatui+json",
            "source": source,
            "inline": true,
            "bindings": bindings,
        }),
        data,
    )
}

pub fn rendered_with_declaration(
    source: &str,
    declaration: Value,
    data: &Value,
) -> RenderedFragment {
    let declaration: xript_runtime::FragmentDeclaration = serde_json::from_value(declaration)
        .expect("the declaration is well formed");

    let options = xript_runtime::FragmentOptions {
        formats: Some(serde_json::from_str(FORMATS).expect("the test vocabulary parses")),
        vocabularies: None,
        strict_html_vocabulary: false,
    };

    xript_runtime::fragment::create_fragment_instance(&declaration, source, &options)
        .expect("the source sanitizes against the test vocabulary")
        .get_content(data)
        .to_rendered()
}

pub fn rendered_bare(source: &str) -> RenderedFragment {
    rendered(source, &json!({}))
}

/// The same load, surfacing the refusal instead of panicking on it.
pub fn try_rendered(source: &str) -> Result<RenderedFragment, xript_runtime::XriptError> {
    let declaration: xript_runtime::FragmentDeclaration = serde_json::from_value(json!({
        "id": "test-fragment",
        "slot": "main",
        "format": "application/x-ratatui+json",
        "source": source,
        "inline": true,
    }))
    .expect("the declaration is well formed");

    let options = xript_runtime::FragmentOptions {
        formats: Some(serde_json::from_str(FORMATS).expect("the test vocabulary parses")),
        vocabularies: None,
        strict_html_vocabulary: false,
    };

    Ok(xript_runtime::fragment::create_fragment_instance(&declaration, source, &options)?
        .get_content(&json!({}))
        .to_rendered())
}

/// Draws a fragment onto a test backend and returns the cells.
pub fn draw(fragment: &RenderedFragment, width: u16, height: u16) -> String {
    let backend = ratatui::backend::TestBackend::new(width, height);
    let mut terminal = ratatui::Terminal::new(backend).unwrap();
    terminal
        .draw(|frame| xript_ratatui::render_fragment(frame, frame.area(), fragment))
        .unwrap();
    terminal.backend().to_string()
}
