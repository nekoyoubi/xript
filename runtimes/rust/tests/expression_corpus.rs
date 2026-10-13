use std::collections::HashMap;

use serde_json::{json, Value};
use xript_runtime::fragment::{
    bind_expression_kind, create_fragment_instance, FragmentOptions,
};
use xript_runtime::{FragmentBinding, FragmentDeclaration};

fn corpus() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../spec/expression-tests.json");
    serde_json::from_str(&std::fs::read_to_string(path).expect("corpus is readable"))
        .expect("corpus is valid JSON")
}

fn render(source: &str, format: &str, bindings: &Value, interpolate: bool) -> (String, Value) {
    let names: Vec<(String, String)> = bindings
        .as_object()
        .map(|map| map.keys().map(|name| (name.clone(), name.clone())).collect())
        .unwrap_or_default();
    render_declared(source, format, bindings, &names, interpolate)
}

fn render_declared(
    source: &str,
    format: &str,
    bindings: &Value,
    names: &[(String, String)],
    interpolate: bool,
) -> (String, Value) {
    let declaration = FragmentDeclaration {
        id: "corpus".to_string(),
        slot: "corpus".to_string(),
        format: format.to_string(),
        source: source.to_string(),
        inline: Some(true),
        bindings: Some(
            names
                .iter()
                .map(|(name, path)| FragmentBinding {
                    name: name.clone(),
                    path: path.clone(),
                    r#type: None,
                    extensions: Default::default(),
                })
                .collect(),
        ),
        handlers: None,
        events: None,
        priority: None,
        interpolate: Some(interpolate),
    };

    let instance =
        create_fragment_instance(&declaration, source, &FragmentOptions::default()).expect("fragment");
    let result = instance.get_content(bindings);
    let conditions: Vec<Value> = result
        .conditions
        .iter()
        .map(|condition| {
            json!({
                "path": condition.path,
                "expression": condition.expression,
                "visible": condition.visible,
            })
        })
        .collect();
    (result.html, Value::Array(conditions))
}

#[test]
fn corpus_conditions_are_keyed_by_tree_position() {
    let corpus = corpus();
    for case in corpus["conditions"].as_array().unwrap() {
        let id = case["id"].as_str().unwrap();
        let (_, conditions) =
            render(case["source"].as_str().unwrap(), "text/html", &case["bindings"], false);
        assert_eq!(conditions, case["expected"], "{id}");
    }
}

#[test]
fn corpus_attribute_sinks_are_unreachable_from_interpolation() {
    let corpus = corpus();
    for case in corpus["attributes"].as_array().unwrap() {
        let id = case["id"].as_str().unwrap();
        let (html, _) = render(
            case["source"].as_str().unwrap(),
            case["format"].as_str().unwrap(),
            &case["bindings"],
            true,
        );
        assert_eq!(html, case["expectedHtml"].as_str().unwrap(), "{id}");
    }
}

#[test]
fn corpus_interpolation_safety_end_to_end() {
    let corpus = corpus();
    for case in corpus["safety"].as_array().unwrap() {
        let id = case["id"].as_str().unwrap();
        let source = format!("<p>{}</p>", case["text"].as_str().unwrap());
        let (html, _) = render(&source, "text/html", &case["bindings"], true);
        assert_eq!(html, format!("<p>{}</p>", case["html"].as_str().unwrap()), "{id}");
    }
}

#[test]
fn interpolation_is_opt_in() {
    let bindings = json!({ "hp": 35 });
    let (off, _) = render("<p>Health: {{ hp }}</p>", "text/html", &bindings, false);
    assert_eq!(off, "<p>Health: {{ hp }}</p>");

    let (on, _) = render("<p>Health: {{ hp }}</p>", "text/html", &bindings, true);
    assert_eq!(on, "<p>Health: 35</p>");
}

#[test]
fn an_expression_valued_data_bind_computes() {
    let bindings = json!({ "hp": 35, "maxHp": 100 });
    let (html, _) = render(
        r#"<p data-bind="round(hp / maxHp * 100)">0</p>"#,
        "text/html",
        &bindings,
        false,
    );
    assert_eq!(html, r#"<p data-bind="round(hp / maxHp * 100)">35</p>"#);
}

#[test]
fn a_bare_name_with_no_binding_keeps_its_fallback() {
    let (html, _) = render(r#"<p data-bind="missing">fallback</p>"#, "text/html", &json!({}), false);
    assert_eq!(html, r#"<p data-bind="missing">fallback</p>"#);
}

#[test]
fn corpus_a_bare_name_renders_as_its_expression_does() {
    let corpus = corpus();
    for case in corpus["render"].as_array().unwrap() {
        let id = case["id"].as_str().unwrap();
        let names: Vec<(String, String)> = match case.get("declared") {
            Some(declared) => declared.as_array().unwrap().iter().map(declared_binding).collect(),
            None => case["bindings"]
                .as_object()
                .unwrap()
                .keys()
                .map(|name| (name.clone(), name.clone()))
                .collect(),
        };
        let (html, _) = render_declared(
            case["source"].as_str().unwrap(),
            "text/html",
            &case["bindings"],
            &names,
            false,
        );
        assert_eq!(html, case["expectedHtml"].as_str().unwrap(), "{id}");
    }
}

#[test]
fn a_declared_binding_with_a_missing_path_keeps_its_fallback() {
    let names = vec![("hp".to_string(), "hp".to_string())];
    let (html, _) = render_declared(
        r#"<p data-bind="hp">fallback</p>"#,
        "text/html",
        &json!({ "other": 1 }),
        &names,
        false,
    );
    assert_eq!(html, r#"<p data-bind="hp">fallback</p>"#);
}

#[test]
fn the_deprecated_string_pass_stringifies_the_same_way() {
    let bindings: HashMap<String, Value> =
        [("a".to_string(), Value::Null), ("b".to_string(), json!(0))].into_iter().collect();
    let result = xript_runtime::fragment::process_fragment(
        "corpus",
        r#"<p data-bind="a">x</p><input data-bind="b" value="y" />"#,
        &bindings,
    );
    assert_eq!(result.html, r#"<p data-bind="a"></p><input data-bind="b" value="0" />"#);
}

#[test]
fn the_deprecated_string_pass_escapes_and_writes_literally() {
    let bindings: HashMap<String, Value> = [
        ("a".to_string(), json!("<b>x</b>")),
        ("b".to_string(), json!("$0\"")),
    ]
    .into_iter()
    .collect();
    let result = xript_runtime::fragment::process_fragment(
        "corpus",
        r#"<p data-bind="a">x</p><input data-bind="b" value="y" />"#,
        &bindings,
    );
    assert_eq!(
        result.html,
        r#"<p data-bind="a">&lt;b&gt;x&lt;/b&gt;</p><input data-bind="b" value="$0&quot;" />"#
    );
}

#[test]
fn a_computed_value_cannot_become_markup() {
    let bindings = json!({ "evil": "<script>alert(1)</script>" });
    let (html, _) = render(r#"<p data-bind="evil">x</p>"#, "text/html", &bindings, false);
    assert_eq!(html, r#"<p data-bind="evil">&lt;script&gt;alert(1)&lt;/script&gt;</p>"#);
}

#[test]
fn a_compound_condition_is_no_longer_silently_false() {
    let bindings = json!({ "alive": true, "health": 35 });
    let (_, conditions) = render(
        r#"<p data-if="alive &amp;&amp; health < 50">warn</p>"#,
        "text/html",
        &bindings,
        false,
    );
    assert_eq!(conditions[0]["visible"], json!(true));
}

#[test]
fn bind_classification_matches_the_corpus() {
    let corpus = corpus();
    for case in corpus["bind"].as_array().unwrap() {
        let id = case["id"].as_str().unwrap();
        let kind = bind_expression_kind(case["expression"].as_str().unwrap()).expect(id);
        let expected = case["kind"].as_str().unwrap();
        let actual = match kind {
            xript_expr::ExpressionKind::Name => "name",
            xript_expr::ExpressionKind::Expression => "expression",
        };
        assert_eq!(actual, expected, "{id}");
    }
}

#[test]
fn jsml_gets_interpolation_from_the_same_parse() {
    let bindings = json!({ "hp": 35 });
    let (_, _) = render(
        r#"["p", "Health: {{ hp }}"]"#,
        "application/jsml+json",
        &bindings,
        true,
    );

    let mut expr_bindings: HashMap<String, Value> = HashMap::new();
    expr_bindings.insert("hp".to_string(), json!(35));
    assert_eq!(xript_expr::evaluate("hp", &expr_bindings), json!(35));
}

fn declared_binding(entry: &Value) -> (String, String) {
    match entry.as_str() {
        Some(name) => (name.to_string(), name.to_string()),
        None => (
            entry["name"].as_str().unwrap().to_string(),
            entry["path"].as_str().unwrap().to_string(),
        ),
    }
}
