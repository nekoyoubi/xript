# Rust Runtime Fixes + Init CLI Tier 4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add tier 4 to the init CLI, implement entry script execution (#87), async host bindings (#86), and a Send+Sync handle wrapper (#88) for the Rust runtime.

**Architecture:** Init CLI gets tier 4 templates generating manifests with slots. Rust runtime gains entry script execution in `load_mod()`, async host binding support via `pollster::block_on()` (sync from JS, async from Rust), and an `XriptHandle` actor wrapper for multi-threaded apps.

**Tech Stack:** TypeScript (init CLI), Rust (rquickjs, pollster, serde_json, thiserror)

---

### Task 1: Init CLI — Tier 4 support

**Files:**
- Modify: `tools/init/src/templates.ts`
- Modify: `tools/init/src/cli.ts`
- Modify: `tools/cli/src/commands/init.ts`
- Test: `tools/init/test/init.test.js`

- [ ] **Step 1: Update `TemplateOptions` type and `parseTier()` in `tools/init/src/cli.ts`**

In `templates.ts`, change the tier type:

```typescript
export interface TemplateOptions {
	name: string;
	tier: 2 | 3 | 4;
	language: "typescript" | "javascript";
	type?: "app" | "mod";
}
```

In `tools/init/src/cli.ts`, update `parseTier`:

```typescript
function parseTier(input?: string): 2 | 3 | 4 | undefined {
	if (!input) return undefined;
	const n = parseInt(input, 10);
	if (n === 4) return 4;
	if (n === 3) return 3;
	if (n === 2) return 2;
	return undefined;
}
```

Update the prompt text (line ~85):

```typescript
const tierInput = await rl.question("Tier — 2 (bindings), 3 (advanced scripting), or 4 (full feature)? (2): ");
```

Update the `--tier` flag description in the help text to: `--tier <2|3|4>       Adoption tier (default: 2)`.

- [ ] **Step 2: Mirror the same changes in `tools/cli/src/commands/init.ts`**

Same `parseTier` update, same prompt text update, same help text update.

- [ ] **Step 3: Add tier 4 branch to `generateProjectFiles` in `templates.ts`**

Update the branching logic:

```typescript
if (options.tier === 2) {
	files[`src/host.${ext}`] = generateTier2Host(options);
	files[`src/demo.${ext}`] = generateTier2Demo(options);
} else if (options.tier === 3) {
	files[`src/host.${ext}`] = generateTier3Host(options);
	files[`src/demo.${ext}`] = generateTier3Demo(options);
} else {
	files[`src/host.${ext}`] = generateTier4Host(options);
	files[`src/demo.${ext}`] = generateTier4Demo(options);
	files["mod-manifest.json"] = generateTier4ModManifest(options);
	files["fragments/panel.html"] = generateModFragmentHtml();
}
```

- [ ] **Step 4: Add tier 4 manifest generation in `generateManifest`**

After the tier 3 block, add:

```typescript
if (options.tier >= 3) {
	// tier 3 and 4 both get hooks, capabilities, counter
	// (move existing tier 3 block to >= 3)
}

if (options.tier === 4) {
	manifest.slots = [
		{
			id: "sidebar.left",
			accepts: ["text/html"],
			capability: "ui-mount",
			multiple: true,
			style: "isolated",
		},
	];

	(manifest.capabilities as Record<string, unknown>)["ui-mount"] = {
		description: "Mount UI fragments into application slots.",
		risk: "medium",
	};
}
```

- [ ] **Step 5: Add `generateTier4Host` function**

```typescript
function generateTier4Host(options: TemplateOptions): string {
	const ts = options.language === "typescript";
	const lines: string[] = [];

	lines.push(`import { initXript } from "@xriptjs/runtime";`);
	lines.push(`import { readFile } from "node:fs/promises";`);
	lines.push(``);
	lines.push(`const manifestRaw = await readFile(new URL("../manifest.json", import.meta.url), "utf-8");`);
	lines.push(`const manifest = JSON.parse(manifestRaw);`);
	lines.push(``);
	lines.push(`let count = 0;`);
	lines.push(``);
	lines.push(`const hostBindings = {`);
	lines.push(`\tlog: (message${ts ? ": string" : ""}) => console.log(\`[script] \${message}\`),`);
	lines.push(`\tgreet: (name${ts ? ": string" : ""}) => \`Hello, \${name}!\`,`);
	lines.push(`\tcounter: {`);
	lines.push(`\t\tget: () => count,`);
	lines.push(`\t\tincrement: (amount${ts ? ": number" : ""} = 1) => { count += amount; return count; },`);
	lines.push(`\t\treset: () => { count = 0; return count; },`);
	lines.push(`\t},`);
	lines.push(`};`);
	lines.push(``);
	lines.push(`const xript = await initXript();`);
	lines.push(``);
	lines.push(`export function createRuntime(capabilities${ts ? ": string[] = []" : " = []"}) {`);
	lines.push(`\tconst runtime = xript.createRuntime(manifest, {`);
	lines.push(`\t\thostBindings,`);
	lines.push(`\t\tcapabilities,`);
	lines.push(`\t\tconsole: { log: console.log, warn: console.warn, error: console.error },`);
	lines.push(`\t});`);
	lines.push(``);
	lines.push(`\truntime.fireHook("onStart");`);
	lines.push(``);
	lines.push(`\treturn runtime;`);
	lines.push(`}`);
	lines.push(``);

	return lines.join("\n");
}
```

- [ ] **Step 6: Add `generateTier4Demo` function**

```typescript
function generateTier4Demo(options: TemplateOptions): string {
	const ext = options.language === "typescript" ? "ts" : "js";
	const lines: string[] = [];

	lines.push(`import { createRuntime } from "./host.${ext}";`);
	lines.push(`import { readFile } from "node:fs/promises";`);
	lines.push(``);
	lines.push(`console.log("=== ${titleCase(options.name)} Demo ===\\n");`);
	lines.push(``);
	lines.push(`const runtime = createRuntime(["modify-state", "ui-mount"]);`);
	lines.push(``);
	lines.push(`const modManifestRaw = await readFile(new URL("../mod-manifest.json", import.meta.url), "utf-8");`);
	lines.push(`const modManifest = JSON.parse(modManifestRaw);`);
	lines.push(``);
	lines.push(`const fragmentHtml = await readFile(new URL("../fragments/panel.html", import.meta.url), "utf-8");`);
	lines.push(`const sources = { [modManifest.fragments[0].source]: fragmentHtml };`);
	lines.push(``);
	lines.push(`const mod = runtime.loadMod(modManifest, sources);`);
	lines.push(`console.log(\`Loaded mod: \${mod.name} v\${mod.version}\`);`);
	lines.push(`console.log(\`Fragments: \${mod.fragments.length}\`);`);
	lines.push(``);
	lines.push(`for (const fragment of mod.fragments) {`);
	lines.push(`\tconsole.log(\`  [\${fragment.slot}] \${fragment.id}\`);`);
	lines.push(`\tconst result = runtime.processFragment(fragment.id, fragment.sanitizedSource, { status: "online" });`);
	lines.push(`\tconsole.log(\`    rendered: \${result.html}\`);`);
	lines.push(`}`);
	lines.push(``);
	lines.push(`console.log("\\n=== Demo complete ===");`);
	lines.push(``);
	lines.push(`runtime.dispose();`);
	lines.push(``);

	return lines.join("\n");
}
```

- [ ] **Step 7: Add `generateTier4ModManifest` function**

```typescript
function generateTier4ModManifest(options: TemplateOptions): string {
	const manifest: Record<string, unknown> = {
		$schema: "https://xript.dev/schema/mod-manifest/v0.3.json",
		xript: "0.3",
		name: `${options.name}-mod`,
		version: "0.1.0",
		title: `${titleCase(options.name)} Mod`,
		description: "A sample mod demonstrating fragment mounting.",
		capabilities: ["modify-state", "ui-mount"],
		fragments: [
			{
				id: "info-panel",
				slot: "sidebar.left",
				format: "text/html",
				source: "fragments/panel.html",
				bindings: [
					{ name: "status", path: "app.status" },
				],
			},
		],
	};

	return JSON.stringify(manifest, null, "\t") + "\n";
}
```

- [ ] **Step 8: Add tier 4 tests**

Add to `tools/init/test/init.test.js`:

```javascript
it("generates tier 4 TypeScript project with mod files", () => {
	const files = generateProjectFiles({ name: "my-app", tier: 4, language: "typescript" });
	const paths = Object.keys(files).sort();
	assert.deepEqual(paths, [
		"fragments/panel.html",
		"manifest.json",
		"mod-manifest.json",
		"package.json",
		"src/demo.ts",
		"src/host.ts",
		"tsconfig.json",
	]);
});

it("generates tier 4 JavaScript project with mod files", () => {
	const files = generateProjectFiles({ name: "my-app", tier: 4, language: "javascript" });
	const paths = Object.keys(files).sort();
	assert.deepEqual(paths, [
		"fragments/panel.html",
		"manifest.json",
		"mod-manifest.json",
		"package.json",
		"src/demo.js",
		"src/host.js",
	]);
});

it("tier 4 manifest has slots, bindings, hooks, and capabilities", () => {
	const files = generateProjectFiles({ name: "test", tier: 4, language: "javascript" });
	const manifest = JSON.parse(files["manifest.json"]);
	assert.ok(manifest.bindings);
	assert.ok(manifest.bindings.counter);
	assert.ok(manifest.hooks);
	assert.ok(manifest.capabilities);
	assert.ok(manifest.capabilities["modify-state"]);
	assert.ok(manifest.capabilities["ui-mount"]);
	assert.ok(Array.isArray(manifest.slots));
	assert.ok(manifest.slots.length > 0);
	assert.equal(manifest.slots[0].id, "sidebar.left");
});

it("tier 4 mod manifest targets sidebar slot", () => {
	const files = generateProjectFiles({ name: "test", tier: 4, language: "javascript" });
	const modManifest = JSON.parse(files["mod-manifest.json"]);
	assert.equal(modManifest.xript, "0.3");
	assert.ok(modManifest.fragments);
	assert.equal(modManifest.fragments[0].slot, "sidebar.left");
});

it("tier 4 host uses fireHook", () => {
	const files = generateProjectFiles({ name: "test", tier: 4, language: "javascript" });
	assert.ok(files["src/host.js"].includes("fireHook"));
});

it("tier 4 demo loads a mod", () => {
	const files = generateProjectFiles({ name: "test", tier: 4, language: "javascript" });
	assert.ok(files["src/demo.js"].includes("loadMod"));
});

it("tier 4 fragment HTML includes data-bind", () => {
	const files = generateProjectFiles({ name: "test", tier: 4, language: "javascript" });
	assert.ok(files["fragments/panel.html"].includes("data-bind"));
});
```

- [ ] **Step 9: Build and run tests**

```bash
npm run build --workspace=tools/init
npm test --workspace=tools/init
```

Expected: All tests pass (existing 27 + 7 new = 34).

- [ ] **Step 10: Commit**

```bash
git add tools/init/src/ tools/cli/src/commands/init.ts tools/init/test/
git commit -m "$(cat <<'EOF'
added tier 4 (full feature) to init scaffolding

- updated `parseTier()` to accept tier 4
- renamed tier 3 prompt from "full scripting" to "advanced scripting"
- tier 4 app scaffold generates manifest with `slots` + companion mod manifest + fragment HTML
- tier 4 demo loads the mod and processes fragments
- added 7 tests for tier 4 file structure, manifest content, and demo behavior
EOF
)"
```

---

### Task 2: #87 — Entry script execution in load_mod

**Files:**
- Modify: `runtimes/rust/src/error.rs`
- Modify: `runtimes/rust/src/sandbox.rs`
- Test: `runtimes/rust/src/lib.rs` (tests module)

- [ ] **Step 1: Add `ModEntry` error variant**

In `runtimes/rust/src/error.rs`, add after the `Script` variant:

```rust
#[error("mod entry script error in `{mod_name}`: {message}")]
ModEntry { mod_name: String, message: String },
```

- [ ] **Step 2: Update `load_mod` signature and implementation**

In `runtimes/rust/src/sandbox.rs`, update `load_mod`:

```rust
pub fn load_mod(
    &self,
    mod_manifest_json: &str,
    fragment_sources: HashMap<String, String>,
    granted_capabilities: &HashSet<String>,
    entry_source: Option<&str>,
) -> Result<crate::fragment::ModInstance> {
    let mod_instance = crate::fragment::load_mod(
        mod_manifest_json,
        &self.manifest,
        granted_capabilities,
        &fragment_sources,
    )?;

    if let Some(source) = entry_source {
        let mod_name = mod_instance.name.clone();
        self.ctx.with(|ctx| {
            let res: std::result::Result<Value, _> = ctx.eval(source);
            if let Err(_) = res {
                let msg: std::result::Result<String, _> =
                    ctx.eval("(() => { try { throw undefined; } catch(e) { return String(e); } })()");
                let error_msg = msg.unwrap_or_else(|_| "unknown entry script error".into());
                return Err(XriptError::ModEntry {
                    mod_name,
                    message: error_msg,
                });
            }
            Ok(())
        })?;
    }

    Ok(mod_instance)
}
```

- [ ] **Step 3: Update all existing `load_mod` call sites in tests**

Every existing test that calls `rt.load_mod(...)` needs the new `entry_source` parameter. Add `None` as the fourth argument to all existing calls. There are 5 call sites in `lib.rs` tests: `cross_validates_slot_exists`, `cross_validates_format_accepted`, `cross_validates_capability_gating` (2 calls), and `load_mod_integration`.

Example:

```rust
let result = rt.load_mod(
    mod_json,
    std::collections::HashMap::new(),
    &std::collections::HashSet::new(),
    None,
);
```

- [ ] **Step 4: Add entry script tests**

Add to `lib.rs` tests:

```rust
#[test]
fn load_mod_executes_entry_script() {
    use std::sync::{Arc, Mutex};

    let logs: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let logs_clone = logs.clone();

    let app_manifest = r#"{
        "xript": "0.3",
        "name": "test-app",
        "bindings": {
            "log": { "description": "logs a message" }
        },
        "slots": [
            { "id": "sidebar.left", "accepts": ["text/html"] }
        ]
    }"#;

    let mut bindings = HostBindings::new();
    bindings.add_function("log", move |args: &[serde_json::Value]| {
        let msg = args.get(0).and_then(|v| v.as_str()).unwrap_or("");
        logs_clone.lock().unwrap().push(msg.to_string());
        Ok(serde_json::Value::Null)
    });

    let rt = create_runtime(
        app_manifest,
        RuntimeOptions {
            host_bindings: bindings,
            capabilities: vec![],
            console: ConsoleHandler::default(),
        },
    )
    .unwrap();

    let mod_json = r#"{
        "xript": "0.3",
        "name": "entry-mod",
        "version": "1.0.0",
        "fragments": [
            { "id": "panel", "slot": "sidebar.left", "format": "text/html", "source": "<p>hi</p>", "inline": true }
        ]
    }"#;

    let mod_instance = rt.load_mod(
        mod_json,
        std::collections::HashMap::new(),
        &std::collections::HashSet::new(),
        Some("log('entry executed')"),
    ).unwrap();

    assert_eq!(mod_instance.name, "entry-mod");
    let captured = logs.lock().unwrap();
    assert_eq!(captured.len(), 1);
    assert_eq!(captured[0], "entry executed");
}

#[test]
fn load_mod_entry_failure_returns_mod_entry_error() {
    let app_manifest = r#"{
        "xript": "0.3",
        "name": "test-app",
        "slots": [
            { "id": "sidebar.left", "accepts": ["text/html"] }
        ]
    }"#;

    let rt = create_runtime(
        app_manifest,
        RuntimeOptions {
            host_bindings: HostBindings::new(),
            capabilities: vec![],
            console: ConsoleHandler::default(),
        },
    )
    .unwrap();

    let mod_json = r#"{
        "xript": "0.3",
        "name": "bad-entry-mod",
        "version": "1.0.0",
        "fragments": [
            { "id": "panel", "slot": "sidebar.left", "format": "text/html", "source": "<p>hi</p>", "inline": true }
        ]
    }"#;

    let result = rt.load_mod(
        mod_json,
        std::collections::HashMap::new(),
        &std::collections::HashSet::new(),
        Some("throw new Error('entry failed')"),
    );

    assert!(result.is_err());
    assert!(matches!(result.unwrap_err(), XriptError::ModEntry { .. }));
}

#[test]
fn load_mod_without_entry_still_works() {
    let app_manifest = r#"{
        "xript": "0.3",
        "name": "test-app",
        "slots": [
            { "id": "sidebar.left", "accepts": ["text/html"] }
        ]
    }"#;

    let rt = create_runtime(
        app_manifest,
        RuntimeOptions {
            host_bindings: HostBindings::new(),
            capabilities: vec![],
            console: ConsoleHandler::default(),
        },
    )
    .unwrap();

    let mod_json = r#"{
        "xript": "0.3",
        "name": "no-entry-mod",
        "version": "1.0.0",
        "fragments": [
            { "id": "panel", "slot": "sidebar.left", "format": "text/html", "source": "<p>hi</p>", "inline": true }
        ]
    }"#;

    let result = rt.load_mod(
        mod_json,
        std::collections::HashMap::new(),
        &std::collections::HashSet::new(),
        None,
    );

    assert!(result.is_ok());
}
```

- [ ] **Step 5: Run tests**

```bash
cd runtimes/rust && cargo test
```

Expected: All tests pass (existing 31 + 3 new = 34).

- [ ] **Step 6: Commit**

```bash
cd runtimes/rust && git add src/ && git commit -m "$(cat <<'EOF'
#87: load_mod executes entry scripts

- added `entry_source: Option<&str>` parameter to `load_mod()`
- entry script runs after fragment validation, before load_mod returns
- new `XriptError::ModEntry` variant distinguishes entry failures from validation errors
- added 3 tests: entry execution, entry failure error type, backward compatibility without entry
EOF
)"
```

---

### Task 3: #86 — Async host binding support

**Files:**
- Modify: `runtimes/rust/Cargo.toml`
- Modify: `runtimes/rust/src/sandbox.rs`
- Modify: `runtimes/rust/src/lib.rs`
- Test: `runtimes/rust/src/lib.rs` (tests module)

- [ ] **Step 1: Add `pollster` dependency**

In `runtimes/rust/Cargo.toml`, add:

```toml
pollster = "0.4"
```

- [ ] **Step 2: Add `AsyncHostFn` type and methods**

In `runtimes/rust/src/sandbox.rs`, add after the `HostFn` type alias:

```rust
use std::future::Future;
use std::pin::Pin;

pub type AsyncHostFn = Arc<
    dyn Fn(
            &[serde_json::Value],
        ) -> Pin<
            Box<dyn Future<Output = std::result::Result<serde_json::Value, String>> + Send>,
        > + Send
        + Sync,
>;
```

Add a new variant to `HostBinding`:

```rust
enum HostBinding {
    Function(HostFn),
    AsyncFunction(AsyncHostFn),
    Namespace(HashMap<String, HostFn>),
    AsyncNamespace(HashMap<String, AsyncHostFn>),
}
```

Add methods to `HostBindings`:

```rust
pub fn add_async_function<F, Fut>(&mut self, name: impl Into<String>, f: F)
where
    F: Fn(&[serde_json::Value]) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = std::result::Result<serde_json::Value, String>> + Send + 'static,
{
    self.bindings.insert(
        name.into(),
        HostBinding::AsyncFunction(Arc::new(move |args| Box::pin(f(args)))),
    );
}

pub fn add_async_namespace(
    &mut self,
    name: impl Into<String>,
    members: HashMap<String, AsyncHostFn>,
) {
    self.bindings
        .insert(name.into(), HostBinding::AsyncNamespace(members));
}
```

- [ ] **Step 3: Create `create_async_host_function` bridge**

Add to `sandbox.rs`:

```rust
fn create_async_host_function<'js>(
    ctx: &Ctx<'js>,
    name: &str,
    f: AsyncHostFn,
) -> Result<Function<'js>> {
    let bridge_fn = Function::new(ctx.clone(), move |args_json: String| -> String {
        let args: Vec<serde_json::Value> = match serde_json::from_str(&args_json) {
            Ok(a) => a,
            Err(e) => {
                let err = serde_json::json!({"__xript_err": format!("invalid args: {}", e)});
                return serde_json::to_string(&err).unwrap();
            }
        };
        let future = f(&args);
        match pollster::block_on(future) {
            Ok(result) => {
                let wrapped = serde_json::json!({"__xript_ok": result});
                serde_json::to_string(&wrapped).unwrap_or("{\"__xript_ok\":null}".into())
            }
            Err(msg) => {
                let err = serde_json::json!({"__xript_err": msg});
                serde_json::to_string(&err).unwrap()
            }
        }
    })
    .map_err(|e| {
        XriptError::Engine(format!("failed to create async host function '{}': {}", name, e))
    })?;

    ctx.globals()
        .set("__xript_tmp_bridge", bridge_fn)
        .map_err(|e| XriptError::Engine(e.to_string()))?;

    let wrapper: Function = ctx.eval(
        "(function(bridge) { return function() { var args = Array.prototype.slice.call(arguments); var raw = bridge(JSON.stringify(args)); var envelope = JSON.parse(raw); if (envelope.__xript_err !== undefined) { throw new Error(envelope.__xript_err); } return envelope.__xript_ok; }; })(__xript_tmp_bridge)",
    )
    .map_err(|e| XriptError::Engine(e.to_string()))?;

    ctx.eval::<(), _>("delete globalThis.__xript_tmp_bridge")
        .map_err(|e| XriptError::Engine(e.to_string()))?;

    Ok(wrapper)
}
```

- [ ] **Step 4: Update `register_bindings` to handle async variants**

In `register_bindings`, update the match arms for `HostBinding`:

```rust
match host_bindings.bindings.get(name) {
    Some(HostBinding::Function(f)) => {
        let js_fn = create_host_function(ctx, name, f.clone())?;
        ctx.globals()
            .set(name.as_str(), js_fn)
            .map_err(|e| XriptError::Engine(e.to_string()))?;
    }
    Some(HostBinding::AsyncFunction(f)) => {
        let js_fn = create_async_host_function(ctx, name, f.clone())?;
        ctx.globals()
            .set(name.as_str(), js_fn)
            .map_err(|e| XriptError::Engine(e.to_string()))?;
    }
    _ => {
        // existing missing binding handler
    }
}
```

Do the same for `register_namespace_binding` — handle `AsyncNamespace` the same way as `Namespace` but use `create_async_host_function`.

- [ ] **Step 5: Export new types from `lib.rs`**

```rust
pub use sandbox::{
    AsyncHostFn, ConsoleHandler, ExecutionResult, HostBindings, HostFn, RuntimeOptions,
    XriptRuntime,
};
```

- [ ] **Step 6: Add async binding tests**

```rust
#[test]
fn calls_async_host_function() {
    let manifest = r#"{
        "xript": "0.1",
        "name": "test",
        "bindings": {
            "fetchData": {
                "description": "fetches data asynchronously",
                "async": true
            }
        }
    }"#;

    let mut bindings = HostBindings::new();
    bindings.add_async_function("fetchData", |args: &[serde_json::Value]| {
        let key = args.get(0).and_then(|v| v.as_str()).unwrap_or("default").to_string();
        async move { Ok(serde_json::json!(format!("data for {}", key))) }
    });

    let rt = create_runtime(
        manifest,
        RuntimeOptions {
            host_bindings: bindings,
            capabilities: vec![],
            console: ConsoleHandler::default(),
        },
    )
    .unwrap();

    let result = rt.execute("fetchData('users')").unwrap();
    assert_eq!(result.value, serde_json::json!("data for users"));
}

#[test]
fn async_host_function_errors_become_exceptions() {
    let manifest = r#"{
        "xript": "0.1",
        "name": "test",
        "bindings": {
            "failAsync": {
                "description": "always fails asynchronously",
                "async": true
            }
        }
    }"#;

    let mut bindings = HostBindings::new();
    bindings.add_async_function("failAsync", |_: &[serde_json::Value]| {
        async { Err("async error occurred".into()) }
    });

    let rt = create_runtime(
        manifest,
        RuntimeOptions {
            host_bindings: bindings,
            capabilities: vec![],
            console: ConsoleHandler::default(),
        },
    )
    .unwrap();

    let result = rt.execute("try { failAsync(); 'no error' } catch(e) { e.message }");
    assert!(result.is_ok());
    assert_eq!(result.unwrap().value, serde_json::json!("async error occurred"));
}

#[test]
fn sync_and_async_bindings_coexist() {
    let manifest = r#"{
        "xript": "0.1",
        "name": "test",
        "bindings": {
            "syncAdd": { "description": "sync add" },
            "asyncFetch": { "description": "async fetch", "async": true }
        }
    }"#;

    let mut bindings = HostBindings::new();
    bindings.add_function("syncAdd", |args: &[serde_json::Value]| {
        let a = args.get(0).and_then(|v| v.as_f64()).unwrap_or(0.0);
        let b = args.get(1).and_then(|v| v.as_f64()).unwrap_or(0.0);
        Ok(serde_json::json!(a + b))
    });
    bindings.add_async_function("asyncFetch", |_: &[serde_json::Value]| {
        async { Ok(serde_json::json!("fetched")) }
    });

    let rt = create_runtime(
        manifest,
        RuntimeOptions {
            host_bindings: bindings,
            capabilities: vec![],
            console: ConsoleHandler::default(),
        },
    )
    .unwrap();

    let result = rt.execute("syncAdd(1, 2)").unwrap();
    assert_eq!(result.value, serde_json::json!(3.0));

    let result = rt.execute("asyncFetch()").unwrap();
    assert_eq!(result.value, serde_json::json!("fetched"));
}
```

- [ ] **Step 7: Run tests**

```bash
cd runtimes/rust && cargo test
```

Expected: All tests pass (34 from task 2 + 3 new = 37).

- [ ] **Step 8: Commit**

```bash
cd runtimes/rust && git add src/ Cargo.toml Cargo.lock && git commit -m "$(cat <<'EOF'
#86: async host binding support

- added `AsyncHostFn` type and `add_async_function()` / `add_async_namespace()` methods to `HostBindings`
- async host functions bridge through `pollster::block_on()` — host code is async, JS calls are synchronous
- added `pollster` dependency for lightweight future execution
- added 3 tests: async binding calls, async error handling, sync+async coexistence
EOF
)"
```

---

### Task 4: #88 — XriptHandle (Send + Sync wrapper)

**Files:**
- Create: `runtimes/rust/src/handle.rs`
- Modify: `runtimes/rust/src/lib.rs`
- Test: `runtimes/rust/src/lib.rs` (tests module)

- [ ] **Step 1: Create `handle.rs`**

Create `runtimes/rust/src/handle.rs`:

```rust
use std::collections::{HashMap, HashSet};
use std::sync::mpsc;
use std::thread;

use crate::error::{Result, XriptError};
use crate::fragment::ModInstance;
use crate::sandbox::{ExecutionResult, RuntimeOptions, XriptRuntime};

enum Command {
    Execute {
        code: String,
        tx: mpsc::Sender<Result<ExecutionResult>>,
    },
    LoadMod {
        mod_manifest_json: String,
        fragment_sources: HashMap<String, String>,
        granted_capabilities: HashSet<String>,
        entry_source: Option<String>,
        tx: mpsc::Sender<Result<ModInstance>>,
    },
    ManifestName {
        tx: mpsc::Sender<String>,
    },
    Shutdown,
}

pub struct XriptHandle {
    cmd_tx: mpsc::Sender<Command>,
    thread: Option<thread::JoinHandle<()>>,
}

impl XriptHandle {
    pub fn new(manifest_json: String, options: RuntimeOptions) -> Result<Self> {
        let (cmd_tx, cmd_rx) = mpsc::channel::<Command>();
        let (init_tx, init_rx) = mpsc::channel::<Result<()>>();

        let thread = thread::spawn(move || {
            let rt = match crate::create_runtime(&manifest_json, options) {
                Ok(rt) => {
                    let _ = init_tx.send(Ok(()));
                    rt
                }
                Err(e) => {
                    let _ = init_tx.send(Err(e));
                    return;
                }
            };

            while let Ok(cmd) = cmd_rx.recv() {
                match cmd {
                    Command::Execute { code, tx } => {
                        let _ = tx.send(rt.execute(&code));
                    }
                    Command::LoadMod {
                        mod_manifest_json,
                        fragment_sources,
                        granted_capabilities,
                        entry_source,
                        tx,
                    } => {
                        let _ = tx.send(rt.load_mod(
                            &mod_manifest_json,
                            fragment_sources,
                            &granted_capabilities,
                            entry_source.as_deref(),
                        ));
                    }
                    Command::ManifestName { tx } => {
                        let _ = tx.send(rt.manifest().name.clone());
                    }
                    Command::Shutdown => break,
                }
            }
        });

        init_rx
            .recv()
            .map_err(|_| XriptError::Engine("runtime thread panicked during init".into()))??;

        Ok(Self {
            cmd_tx,
            thread: Some(thread),
        })
    }

    pub fn execute(&self, code: &str) -> Result<ExecutionResult> {
        let (tx, rx) = mpsc::channel();
        self.cmd_tx
            .send(Command::Execute {
                code: code.to_string(),
                tx,
            })
            .map_err(|_| XriptError::Engine("runtime thread is gone".into()))?;
        rx.recv()
            .map_err(|_| XriptError::Engine("runtime thread dropped response".into()))?
    }

    pub fn load_mod(
        &self,
        mod_manifest_json: &str,
        fragment_sources: HashMap<String, String>,
        granted_capabilities: &HashSet<String>,
        entry_source: Option<&str>,
    ) -> Result<ModInstance> {
        let (tx, rx) = mpsc::channel();
        self.cmd_tx
            .send(Command::LoadMod {
                mod_manifest_json: mod_manifest_json.to_string(),
                fragment_sources,
                granted_capabilities: granted_capabilities.clone(),
                entry_source: entry_source.map(|s| s.to_string()),
                tx,
            })
            .map_err(|_| XriptError::Engine("runtime thread is gone".into()))?;
        rx.recv()
            .map_err(|_| XriptError::Engine("runtime thread dropped response".into()))?
    }

    pub fn manifest_name(&self) -> Result<String> {
        let (tx, rx) = mpsc::channel();
        self.cmd_tx
            .send(Command::ManifestName { tx })
            .map_err(|_| XriptError::Engine("runtime thread is gone".into()))?;
        rx.recv()
            .map_err(|_| XriptError::Engine("runtime thread dropped response".into()))
    }
}

impl Drop for XriptHandle {
    fn drop(&mut self) {
        let _ = self.cmd_tx.send(Command::Shutdown);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
```

- [ ] **Step 2: Register module and export in `lib.rs`**

Add `mod handle;` and export:

```rust
mod handle;

pub use handle::XriptHandle;
```

- [ ] **Step 3: Add XriptHandle tests**

```rust
#[test]
fn handle_is_send_and_sync() {
    fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<handle::XriptHandle>();
}

#[test]
fn handle_executes_code() {
    let handle = handle::XriptHandle::new(
        minimal_manifest().to_string(),
        RuntimeOptions {
            host_bindings: HostBindings::new(),
            capabilities: vec![],
            console: ConsoleHandler::default(),
        },
    )
    .unwrap();

    let result = handle.execute("2 + 2").unwrap();
    assert_eq!(result.value, serde_json::json!(4));
}

#[test]
fn handle_returns_manifest_name() {
    let handle = handle::XriptHandle::new(
        minimal_manifest().to_string(),
        RuntimeOptions {
            host_bindings: HostBindings::new(),
            capabilities: vec![],
            console: ConsoleHandler::default(),
        },
    )
    .unwrap();

    assert_eq!(handle.manifest_name().unwrap(), "test-app");
}

#[test]
fn handle_works_across_threads() {
    let handle = handle::XriptHandle::new(
        minimal_manifest().to_string(),
        RuntimeOptions {
            host_bindings: HostBindings::new(),
            capabilities: vec![],
            console: ConsoleHandler::default(),
        },
    )
    .unwrap();

    let result = std::thread::spawn(move || handle.execute("1 + 1"))
        .join()
        .unwrap()
        .unwrap();

    assert_eq!(result.value, serde_json::json!(2));
}

#[test]
fn handle_propagates_errors() {
    let handle = handle::XriptHandle::new(
        minimal_manifest().to_string(),
        RuntimeOptions {
            host_bindings: HostBindings::new(),
            capabilities: vec![],
            console: ConsoleHandler::default(),
        },
    )
    .unwrap();

    let result = handle.execute("throw new Error('boom')");
    assert!(result.is_err());
    assert!(matches!(result.unwrap_err(), XriptError::Script(_)));
}

#[test]
fn handle_load_mod_works() {
    let app_manifest = r#"{
        "xript": "0.3",
        "name": "test-app",
        "slots": [
            { "id": "sidebar.left", "accepts": ["text/html"] }
        ]
    }"#;

    let handle = handle::XriptHandle::new(
        app_manifest.to_string(),
        RuntimeOptions {
            host_bindings: HostBindings::new(),
            capabilities: vec![],
            console: ConsoleHandler::default(),
        },
    )
    .unwrap();

    let mod_json = r#"{
        "xript": "0.3",
        "name": "test-mod",
        "version": "1.0.0",
        "fragments": [
            { "id": "panel", "slot": "sidebar.left", "format": "text/html", "source": "<p>hi</p>", "inline": true }
        ]
    }"#;

    let mod_instance = handle.load_mod(
        mod_json,
        std::collections::HashMap::new(),
        &std::collections::HashSet::new(),
        None,
    ).unwrap();

    assert_eq!(mod_instance.name, "test-mod");
}
```

- [ ] **Step 4: Run tests**

```bash
cd runtimes/rust && cargo test
```

Expected: All tests pass (37 from task 3 + 6 new = 43).

- [ ] **Step 5: Commit**

```bash
cd runtimes/rust && git add src/ && git commit -m "$(cat <<'EOF'
#88: XriptHandle — Send + Sync runtime wrapper

- added `XriptHandle` type that owns an `XriptRuntime` on a dedicated thread
- communicates via `mpsc` channels; methods mirror `XriptRuntime` API
- `Drop` sends shutdown and joins the thread
- added 6 tests: Send+Sync compile assertion, execute, manifest access, cross-thread usage, error propagation, load_mod
EOF
)"
```

---

### Task 5: Update test counts and verify

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update test counts in CLAUDE.md**

Update the test count for the Rust runtime from 31 to 43 (3 entry + 3 async + 6 handle), init from 27 to 34.

Update total from 645 to 664.

- [ ] **Step 2: Run all tests to confirm final counts**

```bash
npm run build --workspace=tools/init && npm test --workspace=tools/init
cd runtimes/rust && cargo test
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "$(cat <<'EOF'
updated test counts for Rust runtime and init CLI

- Rust runtime: 31 → 43 tests (entry scripts, async bindings, XriptHandle)
- init CLI: 27 → 34 tests (tier 4 scaffolding)
- total: 645 → 664 tests
EOF
)"
```
