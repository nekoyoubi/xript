//! A host with thousands of bindings pays the bridge install once per binding at
//! construction. This keeps that path honest: every binding still works, and the
//! construction time is printed (`cargo test --test construction_scale -- --nocapture`).

use std::collections::HashMap;
use std::time::Instant;

use xript_runtime::{create_runtime_from_value, HostBindings, HostFn, RuntimeOptions};

const NAMESPACES: usize = 25;
const MEMBERS: usize = 100;
const FLAT: usize = 500;

fn manifest() -> serde_json::Value {
    let mut bindings = serde_json::Map::new();
    for ns in 0..NAMESPACES {
        let mut members = serde_json::Map::new();
        for member in 0..MEMBERS {
            members.insert(
                format!("m{member}"),
                serde_json::json!({ "description": "returns its first argument plus its index" }),
            );
        }
        bindings.insert(format!("ns{ns}"), serde_json::json!({ "description": "a namespace", "members": members }));
    }
    for flat in 0..FLAT {
        bindings.insert(format!("f{flat}"), serde_json::json!({ "description": "returns its index" }));
    }
    serde_json::json!({ "xript": "0.10", "name": "scale-probe", "bindings": bindings })
}

fn host_bindings() -> HostBindings {
    let mut bindings = HostBindings::new();
    for ns in 0..NAMESPACES {
        let mut members: HashMap<String, HostFn> = HashMap::new();
        for member in 0..MEMBERS {
            let f: HostFn = std::sync::Arc::new(move |args: &[serde_json::Value]| {
                let base = args.first().and_then(|v| v.as_i64()).unwrap_or(0);
                Ok(serde_json::json!(base + member as i64))
            });
            members.insert(format!("m{member}"), f);
        }
        bindings.add_namespace(format!("ns{ns}"), members);
    }
    for flat in 0..FLAT {
        bindings.add_function(format!("f{flat}"), move |_: &[serde_json::Value]| Ok(serde_json::json!(flat)));
    }
    bindings
}

#[test]
fn constructs_with_three_thousand_bindings() {
    let manifest = manifest();
    let bindings = host_bindings();
    let started = Instant::now();
    let runtime = create_runtime_from_value(manifest, RuntimeOptions { host_bindings: bindings, ..Default::default() })
        .expect("runtime builds");
    let elapsed = started.elapsed();
    eprintln!(
        "constructed a runtime with {} bindings in {:?}",
        NAMESPACES * MEMBERS + FLAT,
        elapsed
    );

    let value = runtime
        .execute("ns24.m99(1) + ns0.m0(10) + f499()")
        .expect("bindings answer")
        .value;
    assert_eq!(value.as_f64(), Some((100 + 10 + 499) as f64));
}
