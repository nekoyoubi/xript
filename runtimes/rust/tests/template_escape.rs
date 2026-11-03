use std::collections::{HashMap, HashSet};

use serde_json::json;
use xript_runtime::{create_runtime_from_value, RuntimeOptions};

#[test]
fn template_interpolation_in_data_is_not_evaluated() {
    let rt = create_runtime_from_value(
        json!({ "xript": "0.10", "name": "probe", "events": [{ "id": "said", "description": "Fired when something is said." }] }),
        RuntimeOptions::default(),
    )
    .unwrap();
    rt.execute("globalThis.hits = 0; events.on('said', function (text) { return text; });")
        .unwrap();
    let mod_json = json!({ "xript": "0.10", "name": "m", "version": "1.0.0", "entry": "main.js" }).to_string();
    let sources = HashMap::from([(
        "main.js".to_string(),
        "xript.exports.register('echo', function (text) { return text; });".to_string(),
    )]);
    rt.load_mod(&mod_json, sources, &HashSet::new(), None).unwrap();
    let probe = "${globalThis.hits = 1}";
    assert_eq!(rt.invoke_mod_export("m", "echo", &[json!(probe)]).unwrap(), json!(probe));
    assert_eq!(rt.emit("said", &[json!(probe)]).unwrap(), vec![json!(probe)]);
    assert_eq!(rt.execute("globalThis.hits").unwrap().value, json!(0));
}
