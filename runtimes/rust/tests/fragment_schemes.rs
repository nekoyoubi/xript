//! The URI scheme allow-list: what a fragment format admits in a `uri` or
//! `image-uri` value, and what no host may talk itself into admitting.

use xript_runtime::{
    default_uri_scheme_set, resolve_extends, resolve_format_profile, sanitize_fragment,
    sanitize_uri, FormatProfileErrorCode, SchemeSet, VocabularyOptions, DEFAULT_URI_SCHEMES,
};

fn schemes(names: &[&str]) -> SchemeSet {
    names.iter().map(|name| (*name).to_string()).collect()
}

fn format_with(schemes: Option<serde_json::Value>) -> serde_json::Value {
    let mut declaration = serde_json::json!({
        "syntax": "html",
        "vocabularies": ["html"],
    });
    if let Some(schemes) = schemes {
        declaration["schemes"] = schemes;
    }
    serde_json::json!({ "application/x-host+html": declaration })
}

fn profile_schemes(declared: Option<serde_json::Value>) -> SchemeSet {
    let formats = format_with(declared);
    resolve_format_profile("application/x-host+html", Some(&formats), None)
        .expect("format resolves")
        .expect("format is declared")
        .schemes
}

fn refuse(declared: serde_json::Value) -> FormatProfileErrorCode {
    let formats = format_with(Some(declared));
    resolve_format_profile("application/x-host+html", Some(&formats), None)
        .expect_err("declaration is refused")
        .code
}

fn sanitize_with(source: &str, declared: Option<serde_json::Value>) -> String {
    let formats = format_with(declared);
    let profile = resolve_format_profile("application/x-host+html", Some(&formats), None)
        .expect("format resolves")
        .expect("format is declared");
    sanitize_fragment(source, &profile, VocabularyOptions::default())
        .expect("fragment parses")
        .html
}

#[test]
fn the_default_set_is_the_four_safe_schemes() {
    assert_eq!(DEFAULT_URI_SCHEMES, ["http", "https", "mailto", "data"]);
    assert_eq!(*default_uri_scheme_set(), schemes(&["http", "https", "mailto", "data"]));
}

#[test]
fn an_absent_declaration_inherits_the_default_set() {
    assert_eq!(profile_schemes(None), *default_uri_scheme_set());
}

#[test]
fn a_declaration_replaces_the_default_rather_than_extending_it() {
    assert_eq!(
        profile_schemes(Some(serde_json::json!(["tauri"]))),
        schemes(&["tauri"]),
        "a host that names one scheme gets that scheme and nothing else"
    );
}

#[test]
fn an_empty_declaration_is_deliberate_closure() {
    assert_eq!(profile_schemes(Some(serde_json::json!([]))), SchemeSet::new());
}

#[test]
fn a_declaration_is_lowercased_before_it_lands_in_the_set() {
    assert_eq!(profile_schemes(Some(serde_json::json!(["HTTPS", "Tauri"]))), schemes(&["https", "tauri"]));
}

// --- relative values are never subject to the list -------------------------

/// The five shapes a value can take without carrying a scheme. Every one of them
/// has to survive whatever the allow-list says, including an empty one: an
/// implementation that requires a scheme match would break every relative link in
/// every fragment already in the wild.
const RELATIVE_SHAPES: [&str; 6] = [
    "about.html",
    "/absolute/path",
    "//cdn.example.com/a.css",
    "#anchor",
    "?q=1",
    "nested/dir/icon.png",
];

#[test]
fn relative_values_pass_under_every_scheme_set() {
    let sets = [
        default_uri_scheme_set().clone(),
        SchemeSet::new(),
        schemes(&["https"]),
        schemes(&["tauri"]),
    ];
    for set in &sets {
        for shape in RELATIVE_SHAPES {
            assert_eq!(
                sanitize_uri(shape, "href", set).as_deref(),
                Some(shape),
                "{shape:?} carries no scheme and must survive the set {set:?}"
            );
            assert_eq!(
                sanitize_uri(shape, "src", set).as_deref(),
                Some(shape),
                "{shape:?} must survive on an image source too"
            );
        }
    }
}

#[test]
fn a_relative_path_with_a_colon_in_a_later_segment_is_not_read_as_a_scheme() {
    assert_eq!(
        sanitize_uri("path/to:thing", "href", &SchemeSet::new()).as_deref(),
        Some("path/to:thing"),
        "`/` is not a scheme character, so the colon is past the scheme position"
    );
}

// --- the hard floor --------------------------------------------------------

#[test]
fn javascript_and_vbscript_are_refused_even_when_declared() {
    for scheme in ["javascript", "vbscript"] {
        assert_eq!(
            refuse(serde_json::json!([scheme])),
            FormatProfileErrorCode::ProhibitedScheme,
            "declaring {scheme} is an error, not a silent no-op"
        );
    }
}

#[test]
fn the_floor_holds_against_a_mixed_case_declaration() {
    assert_eq!(
        refuse(serde_json::json!(["JavaScript"])),
        FormatProfileErrorCode::ProhibitedScheme
    );
    assert_eq!(refuse(serde_json::json!(["VBScript"])), FormatProfileErrorCode::ProhibitedScheme);
}

#[test]
fn the_floor_holds_at_the_sink_even_if_a_set_carries_it() {
    let smuggled = schemes(&["javascript", "vbscript", "https"]);
    assert_eq!(sanitize_uri("javascript:alert(1)", "href", &smuggled), None);
    assert_eq!(sanitize_uri("vbscript:msgbox(1)", "href", &smuggled), None);
    assert_eq!(sanitize_uri("javascript :alert(1)", "href", &smuggled), None);
}

#[test]
fn a_malformed_declaration_is_refused() {
    assert_eq!(refuse(serde_json::json!("https")), FormatProfileErrorCode::InvalidSchemes);
    assert_eq!(refuse(serde_json::json!([42])), FormatProfileErrorCode::InvalidSchemes);
    assert_eq!(refuse(serde_json::json!(["https:"])), FormatProfileErrorCode::InvalidSchemes);
    assert_eq!(refuse(serde_json::json!(["1https"])), FormatProfileErrorCode::InvalidSchemes);
    assert_eq!(refuse(serde_json::json!([""])), FormatProfileErrorCode::InvalidSchemes);
}

// --- normalization feeds the allow-list ------------------------------------

/// The scheme the list is tested against must come from the same normalized value
/// the old two-item deny-list tested. Reading it from anything less normalized
/// would put the allow-list behind the exact reassembly trick the normalization
/// exists to defeat.
#[test]
fn a_disallowed_scheme_cannot_be_smuggled_across_whitespace() {
    let set = default_uri_scheme_set();
    for smuggled in [
        "fi\tle:///etc/passwd",
        "fi\nle:///etc/passwd",
        "fi\rle:///etc/passwd",
        "f\ti\nl\re:///etc/passwd",
        "\u{0000}file:///etc/passwd",
        "  file:///etc/passwd",
    ] {
        assert_eq!(
            sanitize_uri(smuggled, "href", set),
            None,
            "{smuggled:?} normalizes to a file: URI the default set does not admit"
        );
    }
}

#[test]
fn an_entity_encoded_scheme_is_refused_after_the_tokenizer_decodes_it() {
    assert_eq!(
        sanitize_with("<a href=\"fil&#101;:///etc/passwd\">x</a>", None),
        "<a>x</a>"
    );
    assert_eq!(
        sanitize_with("<a href=\"java&#9;script:alert(1)\">x</a>", None),
        "<a>x</a>"
    );
}

#[test]
fn whitespace_before_the_colon_does_not_dodge_the_list() {
    assert_eq!(sanitize_uri("file :///etc/passwd", "href", default_uri_scheme_set()), None);
}

// --- matching is case-insensitive on both sinks ----------------------------

#[test]
fn scheme_matching_is_case_insensitive_but_the_value_keeps_its_case() {
    assert_eq!(
        sanitize_uri("HTTPS://example.com/a", "href", default_uri_scheme_set()).as_deref(),
        Some("HTTPS://example.com/a")
    );
    assert_eq!(sanitize_uri("FILE:///etc/passwd", "href", default_uri_scheme_set()), None);
}

#[test]
fn the_list_applies_to_the_image_uri_sink_too() {
    let set = schemes(&["https"]);
    assert_eq!(sanitize_uri("https://example.com/a.png", "src", &set).as_deref(), Some("https://example.com/a.png"));
    assert_eq!(sanitize_uri("http://example.com/a.png", "src", &set), None);
    assert_eq!(sanitize_uri("TAURI://localhost/a.png", "src", &schemes(&["tauri"])).as_deref(), Some("TAURI://localhost/a.png"));
}

// --- data URIs keep their existing gate ------------------------------------

const SAFE_DATA_IMAGE: &str = "data:image/png;base64,iVBORw0KGgo=";

#[test]
fn allow_listing_data_grants_no_more_than_it_does_today() {
    let set = schemes(&["data"]);
    assert_eq!(sanitize_uri(SAFE_DATA_IMAGE, "src", &set).as_deref(), Some(SAFE_DATA_IMAGE));
    assert_eq!(
        sanitize_uri(SAFE_DATA_IMAGE, "href", &set),
        None,
        "the subtype gate is src-only and the allow-list does not widen it"
    );
    assert_eq!(
        sanitize_uri("data:text/html,<script>alert(1)</script>", "src", &set),
        None,
        "only the four safe image subtypes pass, allow-listed or not"
    );
    assert_eq!(sanitize_uri("data:image/svg+xml;base64,PHN2Zz4=", "src", &set).as_deref(), Some("data:image/svg+xml;base64,PHN2Zz4="));
}

#[test]
fn omitting_data_refuses_data_uris_outright() {
    let set = schemes(&["https"]);
    assert_eq!(sanitize_uri(SAFE_DATA_IMAGE, "src", &set), None);
    assert_eq!(sanitize_uri(SAFE_DATA_IMAGE, "href", &set), None);
}

#[test]
fn the_default_set_still_admits_a_safe_data_image() {
    assert_eq!(
        sanitize_uri(SAFE_DATA_IMAGE, "src", default_uri_scheme_set()).as_deref(),
        Some(SAFE_DATA_IMAGE)
    );
}

// --- widening and narrowing through a real fragment ------------------------

#[test]
fn a_host_widens_its_surface_by_declaring_a_shell_scheme() {
    assert_eq!(
        sanitize_with("<a href=\"tauri://localhost/api\">x</a>", None),
        "<a>x</a>",
        "no format declares tauri, so the default set refuses it"
    );
    assert_eq!(
        sanitize_with(
            "<a href=\"tauri://localhost/api\">x</a>",
            Some(serde_json::json!(["tauri", "https"]))
        ),
        "<a href=\"tauri://localhost/api\">x</a>"
    );
}

#[test]
fn a_host_narrows_its_surface_the_same_way() {
    let https_only = Some(serde_json::json!(["https"]));
    assert_eq!(
        sanitize_with("<a href=\"http://example.com\">x</a>", https_only.clone()),
        "<a>x</a>"
    );
    assert_eq!(
        sanitize_with("<a href=\"mailto:someone@example.com\">x</a>", https_only.clone()),
        "<a>x</a>"
    );
    assert_eq!(
        sanitize_with("<a href=\"https://example.com\">x</a>", https_only),
        "<a href=\"https://example.com\">x</a>"
    );
}

#[test]
fn closure_drops_every_absolute_uri_and_keeps_every_relative_one() {
    let closed = Some(serde_json::json!([]));
    assert_eq!(sanitize_with("<a href=\"https://example.com\">x</a>", closed.clone()), "<a>x</a>");
    assert_eq!(
        sanitize_with("<a href=\"/local/page\">x</a>", closed),
        "<a href=\"/local/page\">x</a>"
    );
}

// --- inheritance -----------------------------------------------------------

/// `resolve_extends` reads bases off disk, so the chain is exercised through a
/// scratch directory rather than a stubbed resolver.
fn resolved_format_schemes(base: serde_json::Value, child: serde_json::Value) -> serde_json::Value {
    let dir = std::env::temp_dir().join(format!(
        "xript-schemes-{}-{:?}",
        std::process::id(),
        std::thread::current().id()
    ));
    std::fs::create_dir_all(&dir).expect("scratch dir");
    std::fs::write(dir.join("base.json"), serde_json::to_vec(&base).unwrap())
        .expect("base written");
    let resolved = resolve_extends(&child, &dir).expect("extends resolves");
    std::fs::remove_dir_all(&dir).ok();
    resolved["formats"]["application/x-host+html"]["schemes"].clone()
}

fn base_manifest(schemes: serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "xript": "0.8",
        "host": { "id": "base", "name": "Base", "version": "1.0.0" },
        "formats": {
            "application/x-host+html": {
                "syntax": "html",
                "vocabularies": ["html"],
                "schemes": schemes,
            }
        }
    })
}

fn child_manifest(schemes: Option<serde_json::Value>) -> serde_json::Value {
    let mut format = serde_json::json!({ "refines": true });
    if let Some(schemes) = schemes {
        format["schemes"] = schemes;
    }
    serde_json::json!({
        "xript": "0.8",
        "extends": ["base.json"],
        "host": { "id": "child", "name": "Child", "version": "1.0.0" },
        "formats": { "application/x-host+html": format }
    })
}

#[test]
fn an_absent_child_declaration_inherits_the_base_set() {
    assert_eq!(
        resolved_format_schemes(base_manifest(serde_json::json!(["tauri"])), child_manifest(None)),
        serde_json::json!(["tauri"])
    );
}

#[test]
fn a_present_child_declaration_replaces_the_base_set_wholesale() {
    assert_eq!(
        resolved_format_schemes(
            base_manifest(serde_json::json!(["tauri", "https"])),
            child_manifest(Some(serde_json::json!(["https"])))
        ),
        serde_json::json!(["https"]),
        "a union would make narrowing impossible"
    );
}

#[test]
fn a_child_closes_the_set_with_an_empty_array() {
    assert_eq!(
        resolved_format_schemes(
            base_manifest(serde_json::json!(["tauri"])),
            child_manifest(Some(serde_json::json!([])))
        ),
        serde_json::json!([]),
        "`[]` is deliberate closure, not a shorthand for the base"
    );
}
