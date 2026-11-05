//! Names the host supplies (hook ids, phases, capabilities, fragment ids,
//! lifecycles, mod names, export names) reach the sandbox as data. None of
//! them is spliced into evaluated source, so quotes, backslashes and line
//! breaks in a name neither break the runtime nor run as script.

use std::collections::{HashMap, HashSet};

use serde_json::json;
use xript_runtime::{create_runtime_from_value, RuntimeMode, RuntimeOptions, XriptError, XriptRuntime};

const HOOK: &str = "it's \"quoted\" \\ and\nbroken";
const PHASE: &str = "ph'ase\"\n";

fn runtime(mode: RuntimeMode) -> XriptRuntime {
    create_runtime_from_value(
        json!({
            "xript": "0.10",
            "name": "names-as-data",
            "capabilities": { "cap'\"\n": { "description": "An awkward capability name." } },
            "hooks": {
                HOOK: { "description": "An awkward hook name." },
                "phased": { "description": "An awkward phase.", "phases": [PHASE] },
                "gated'\"": { "description": "Gated.", "capability": "cap'\"\n" }
            }
        }),
        RuntimeOptions { mode, ..Default::default() },
    )
    .expect("a runtime builds whatever its hook names hold")
}

fn plain(mode: RuntimeMode) -> XriptRuntime {
    create_runtime_from_value(
        json!({ "xript": "0.10", "name": "names-as-data", "hooks": { "phased": { "description": "A hook." } } }),
        RuntimeOptions { mode, ..Default::default() },
    )
    .expect("runtime builds")
}

#[test]
fn awkward_hook_names_and_phases_register_and_fire() {
    for mode in [RuntimeMode::Sync, RuntimeMode::Async] {
        let rt = runtime(mode);
        rt.execute(&format!(
            "hooks[{hook}](function (x) {{ return x + 1; }}); hooks.phased[{phase}](function (x) {{ return x * 2; }});",
            hook = serde_json::to_string(HOOK).unwrap(),
            phase = serde_json::to_string(PHASE).unwrap(),
        ))
        .expect("handlers register");
        assert_eq!(rt.fire_hook(HOOK, &[json!(1)]).unwrap(), vec![json!(2)], "{mode:?}");
        assert_eq!(rt.fire_hook_phase("phased", PHASE, Some(&json!(4))).unwrap(), vec![json!(8)], "{mode:?}");
        let refused = rt.execute("hooks[\"gated'\\\"\"](function () {})").unwrap_err();
        assert_eq!(
            refused.to_string(),
            "script error: CapabilityDeniedError: hooks.gated'\"() requires the \"cap'\"\n\" capability, which hasn't been granted to this script. Ask the app developer to enable it.",
            "{mode:?}"
        );
    }
}

#[test]
fn a_fragment_id_cannot_run_as_script() {
    for mode in [RuntimeMode::Sync, RuntimeMode::Async] {
        let rt = plain(mode);
        let id = "x\"; globalThis.ran = true; \"";
        rt.execute(&format!(
            "globalThis.ran = false; hooks.fragment.update({id}, function (bindings, fragment) {{ fragment.setText('.t', 'hit'); }});",
            id = serde_json::to_string(id).unwrap(),
        ))
        .expect("handler registers");
        let ops = rt.fire_fragment_hook(id, "update", None).expect("hook fires");
        assert_eq!(rt.execute("globalThis.ran").unwrap().value, json!(false), "{mode:?}: the id ran as script");
        assert_eq!(ops.len(), 1, "{mode:?}: the handler registered under that id runs");
    }
}

#[test]
fn awkward_mod_and_export_names_resolve() {
    for mode in [RuntimeMode::Sync, RuntimeMode::Async] {
        let rt = plain(mode);
        let mod_name = "mod'\"\\\nname";
        let manifest = json!({
            "xript": "0.10", "name": mod_name, "version": "1.0.0",
            "entry": { "script": "m.js", "format": "script", "exports": { "ex'\"\n": { "description": "An awkward export." } } }
        });
        rt.load_mod(
            &manifest.to_string(),
            HashMap::new(),
            &HashSet::new(),
            Some("xript.exports.register(\"ex'\\\"\\n\", function () { return 'ok'; }); hooks[\"phased\"]; ''"),
        )
        .expect("mod loads");
        assert_eq!(rt.invoke_mod_export(mod_name, "ex'\"\n", &[]).unwrap(), json!("ok"), "{mode:?}");
        assert_eq!(rt.invoke_export("ex'\"\n", &[]).unwrap(), json!("ok"), "{mode:?}");
        assert!(matches!(rt.invoke_export("ex'\"\n \"", &[]), Err(XriptError::Invoke { .. })), "{mode:?}");
        let _ = rt.handler_index_for(mod_name);
    }
}
