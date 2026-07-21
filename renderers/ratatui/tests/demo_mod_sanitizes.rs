//! The demo host declares a Ratatui vocabulary and the demo mod fills it. This
//! keeps the two honest with each other: a widget the renderer supports but the
//! host never declared would be refused at load, and this test is where that
//! surfaces rather than at the first frame.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

fn demo_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("examples/demo-mod")
}

fn read(relative: &str) -> String {
    std::fs::read_to_string(demo_dir().join(relative)).expect("demo file exists")
}

fn demo_fragment() -> xript_runtime::FragmentInstance {
    let runtime = xript_runtime::create_runtime(
        &read("manifest.json"),
        xript_runtime::RuntimeOptions {
            capabilities: vec!["ui-mount".to_string()],
            ..Default::default()
        },
    )
    .expect("the demo host manifest builds a runtime");

    let mut sources = HashMap::new();
    sources.insert("fragments/panel.json".to_string(), read("fragments/panel.json"));

    runtime
        .load_mod(
            &read("mod-manifest.json"),
            sources,
            &["ui-mount".to_string()].into_iter().collect(),
            None,
        )
        .expect("the demo mod loads")
        .fragments
        .into_iter()
        .next()
        .expect("the demo mod contributes a fragment")
}

#[test]
fn the_demo_mod_loads_against_the_declared_vocabulary() {
    let fragment = demo_fragment();
    assert_eq!(fragment.format, "application/x-ratatui+json");
    assert_eq!(fragment.content_type, xript_runtime::FragmentContentType::Tree);
    assert!(
        fragment.diagnostics.is_empty(),
        "the demo fragment should sanitize cleanly, got: {:?}",
        fragment.diagnostics
    );
    assert!(!fragment.sanitized_tree.is_empty());
}

/// The seam, end to end. The host calls `get_content`, projects it into
/// `xript-tree/1`, and hands the renderer that -- no re-serialization to JSML, no
/// re-parse, and no bindings map crossing the boundary.
#[test]
fn the_bound_tree_reaches_the_renderer_and_draws() {
    let fragment = demo_fragment();
    let rendered = fragment
        .get_content(&serde_json::json!({
            "player": { "name": "Hero", "health": 80.0, "maxHealth": 100.0 }
        }))
        .to_rendered();

    assert_eq!(rendered.contract, xript_ratatui::CONTRACT_VERSION);

    let backend = ratatui::backend::TestBackend::new(60, 10);
    let mut terminal = ratatui::Terminal::new(backend).unwrap();
    terminal
        .draw(|frame| xript_ratatui::render_fragment(frame, frame.area(), &rendered))
        .unwrap();

    let drawn = terminal.backend().to_string();
    assert!(drawn.contains("Health Thingy"), "expected the block title, got:\n{drawn}");
    assert!(drawn.contains("Hero"), "expected the bound player name, got:\n{drawn}");
    assert!(drawn.contains("80%"), "expected the bound gauge ratio, got:\n{drawn}");
    assert!(
        !drawn.contains("LOW HEALTH"),
        "expected the data-if paragraph pruned at 80 health, got:\n{drawn}"
    );
}
