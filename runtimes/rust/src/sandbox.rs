use rquickjs::function::Rest;
use rquickjs::{Context, Ctx, Function, Object, Runtime, Value};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::error::{Result, XriptError};
use crate::manifest::{Binding, Manifest, NamespaceBinding};

pub type HostFn =
    Arc<dyn Fn(&[serde_json::Value]) -> std::result::Result<serde_json::Value, String> + Send + Sync>;

pub struct HostBindings {
    bindings: HashMap<String, HostBinding>,
}

enum HostBinding {
    Function(HostFn),
    Namespace(HashMap<String, HostFn>),
}

impl HostBindings {
    pub fn new() -> Self {
        Self {
            bindings: HashMap::new(),
        }
    }

    pub fn add_function<F>(&mut self, name: impl Into<String>, f: F)
    where
        F: Fn(&[serde_json::Value]) -> std::result::Result<serde_json::Value, String>
            + Send
            + Sync
            + 'static,
    {
        self.bindings
            .insert(name.into(), HostBinding::Function(Arc::new(f)));
    }

    pub fn add_namespace(&mut self, name: impl Into<String>, members: HashMap<String, HostFn>) {
        self.bindings
            .insert(name.into(), HostBinding::Namespace(members));
    }
}

impl Default for HostBindings {
    fn default() -> Self {
        Self::new()
    }
}

pub struct ConsoleHandler {
    pub log: Box<dyn Fn(&str) + Send + Sync>,
    pub warn: Box<dyn Fn(&str) + Send + Sync>,
    pub error: Box<dyn Fn(&str) + Send + Sync>,
}

impl Default for ConsoleHandler {
    fn default() -> Self {
        Self {
            log: Box::new(|_| {}),
            warn: Box::new(|_| {}),
            error: Box::new(|_| {}),
        }
    }
}

pub struct RuntimeOptions {
    pub host_bindings: HostBindings,
    pub capabilities: Vec<String>,
    pub console: ConsoleHandler,
}

#[derive(Debug)]
pub struct ExecutionResult {
    pub value: serde_json::Value,
    pub duration_ms: f64,
}

pub struct XriptRuntime {
    rt: Runtime,
    ctx: Context,
    manifest: Manifest,
}

impl std::fmt::Debug for XriptRuntime {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("XriptRuntime")
            .field("manifest_name", &self.manifest.name)
            .finish_non_exhaustive()
    }
}

impl XriptRuntime {
    pub fn new(manifest: Manifest, options: RuntimeOptions) -> Result<Self> {
        crate::manifest::validate_structure(&manifest)?;

        let rt = Runtime::new().map_err(|e| XriptError::Engine(e.to_string()))?;

        if let Some(ref limits) = manifest.limits {
            if let Some(memory_mb) = limits.memory_mb {
                rt.set_memory_limit(memory_mb as usize * 1024 * 1024);
            }
            if let Some(stack) = limits.max_stack_depth {
                rt.set_max_stack_size(stack * 1024);
            }
        }

        let ctx = Context::full(&rt).map_err(|e| XriptError::Engine(e.to_string()))?;

        let granted: HashSet<String> = options.capabilities.into_iter().collect();

        ctx.with(|ctx| -> Result<()> {
            remove_dangerous_globals(&ctx)?;
            register_console(&ctx, options.console)?;
            register_bindings(&ctx, &manifest, options.host_bindings, &granted)?;
            register_hooks(&ctx, &manifest, &granted)?;
            register_fragment_hooks(&ctx)?;
            Ok(())
        })?;

        Ok(Self { rt, ctx, manifest })
    }

    pub fn execute(&self, code: &str) -> Result<ExecutionResult> {
        let timeout_ms = self
            .manifest
            .limits
            .as_ref()
            .and_then(|l| l.timeout_ms)
            .unwrap_or(5000);

        let interrupted = Arc::new(AtomicBool::new(false));
        let interrupted_clone = interrupted.clone();
        let start = Instant::now();
        let deadline = start + Duration::from_millis(timeout_ms);

        self.rt
            .set_interrupt_handler(Some(Box::new(move || {
                if Instant::now() >= deadline {
                    interrupted_clone.store(true, Ordering::Relaxed);
                    true
                } else {
                    false
                }
            }) as Box<dyn FnMut() -> bool + Send>));

        let result = self.ctx.with(|ctx| {
            let res: std::result::Result<Value, _> = ctx.eval(code);
            match res {
                Ok(val) => {
                    let json = js_value_to_json(&ctx, &val);
                    Ok(json)
                }
                Err(_) => {
                    if interrupted.load(Ordering::Relaxed) {
                        Err(XriptError::ExecutionLimit {
                            limit: "timeout_ms".into(),
                        })
                    } else {
                        let msg: std::result::Result<String, _> =
                            ctx.eval("(() => { try { throw undefined; } catch(e) { return String(e); } })()");
                        let error_msg = msg.unwrap_or_else(|_| "unknown script error".into());
                        Err(XriptError::Script(error_msg))
                    }
                }
            }
        });

        self.rt
            .set_interrupt_handler(None::<Box<dyn FnMut() -> bool + Send>>);

        let duration_ms = start.elapsed().as_secs_f64() * 1000.0;

        result.map(|value| ExecutionResult { value, duration_ms })
    }

    pub fn manifest(&self) -> &Manifest {
        &self.manifest
    }

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

    pub fn fire_fragment_hook(
        &self,
        fragment_id: &str,
        lifecycle: &str,
        bindings: Option<&serde_json::Value>,
    ) -> Result<Vec<serde_json::Value>> {
        let bindings_json = match bindings {
            Some(b) => serde_json::to_string(b).unwrap_or("{}".into()),
            None => "{}".into(),
        };

        let code = format!(
            r#"(function() {{
                var handlers = globalThis.__xript_fragment_handlers || {{}};
                var key = "fragment:{lifecycle}:{fid}";
                var list = handlers[key] || [];
                var results = [];
                var bindingsObj = JSON.parse('{bindings_json}');
                for (var i = 0; i < list.length; i++) {{
                    var ops = [];
                    var proxy = {{
                        toggle: function(sel, cond) {{ ops.push({{ op: "toggle", selector: sel, value: !!cond }}); }},
                        addClass: function(sel, cls) {{ ops.push({{ op: "addClass", selector: sel, value: cls }}); }},
                        removeClass: function(sel, cls) {{ ops.push({{ op: "removeClass", selector: sel, value: cls }}); }},
                        setText: function(sel, txt) {{ ops.push({{ op: "setText", selector: sel, value: txt }}); }},
                        setAttr: function(sel, attr, val) {{ ops.push({{ op: "setAttr", selector: sel, attr: attr, value: val }}); }},
                        replaceChildren: function(sel, html) {{ ops.push({{ op: "replaceChildren", selector: sel, value: html }}); }}
                    }};
                    list[i](bindingsObj, proxy);
                    results.push(ops);
                }}
                return JSON.stringify(results);
            }})()"#,
            lifecycle = lifecycle,
            fid = fragment_id,
            bindings_json = bindings_json.replace('\'', "\\'"),
        );

        let result = self.execute(&code)?;
        match serde_json::from_str::<Vec<serde_json::Value>>(
            result.value.as_str().unwrap_or("[]"),
        ) {
            Ok(ops) => Ok(ops),
            Err(_) => Ok(vec![]),
        }
    }
}

fn remove_dangerous_globals(ctx: &Ctx<'_>) -> Result<()> {
    let script = r#"
        delete globalThis.eval;
        if (typeof globalThis.Function !== 'undefined') {
            Object.defineProperty(globalThis, 'Function', {
                get: function() { throw new Error("Function constructor is not permitted. Dynamic code generation is disabled in xript."); },
                configurable: false
            });
        }
    "#;
    ctx.eval::<(), _>(script)
        .map_err(|e| XriptError::Engine(e.to_string()))?;
    Ok(())
}

fn register_console(ctx: &Ctx<'_>, console: ConsoleHandler) -> Result<()> {
    let console_obj = Object::new(ctx.clone()).map_err(|e| XriptError::Engine(e.to_string()))?;

    let log = Arc::new(console.log);
    let log_clone = log.clone();
    let log_fn = Function::new(ctx.clone(), move |args: Rest<String>| {
        let msg = args.0.join(" ");
        log_clone(&msg);
    })
    .map_err(|e| XriptError::Engine(e.to_string()))?;

    let warn = Arc::new(console.warn);
    let warn_clone = warn.clone();
    let warn_fn = Function::new(ctx.clone(), move |args: Rest<String>| {
        let msg = args.0.join(" ");
        warn_clone(&msg);
    })
    .map_err(|e| XriptError::Engine(e.to_string()))?;

    let error = Arc::new(console.error);
    let error_clone = error.clone();
    let error_fn = Function::new(ctx.clone(), move |args: Rest<String>| {
        let msg = args.0.join(" ");
        error_clone(&msg);
    })
    .map_err(|e| XriptError::Engine(e.to_string()))?;

    console_obj
        .set("log", log_fn)
        .map_err(|e| XriptError::Engine(e.to_string()))?;
    console_obj
        .set("warn", warn_fn)
        .map_err(|e| XriptError::Engine(e.to_string()))?;
    console_obj
        .set("error", error_fn)
        .map_err(|e| XriptError::Engine(e.to_string()))?;

    ctx.globals()
        .set("console", console_obj)
        .map_err(|e| XriptError::Engine(e.to_string()))?;

    Ok(())
}

fn make_throwing_function<'js>(ctx: &Ctx<'js>, message: &str) -> Result<Function<'js>> {
    let escaped = message.replace('\\', "\\\\").replace('"', "\\\"");
    let script = format!("(function() {{ throw new Error(\"{}\"); }})", escaped);
    ctx.eval::<Function, _>(script.as_str())
        .map_err(|e| XriptError::Engine(e.to_string()))
}

fn register_bindings(
    ctx: &Ctx<'_>,
    manifest: &Manifest,
    host_bindings: HostBindings,
    granted: &HashSet<String>,
) -> Result<()> {
    let Some(ref bindings) = manifest.bindings else {
        return Ok(());
    };

    for (name, binding) in bindings {
        match binding {
            Binding::Function(func_def) => {
                if let Some(ref cap) = func_def.capability {
                    if !granted.contains(cap) {
                        let msg = format!(
                            "{}() requires the \"{}\" capability, which hasn't been granted to this script",
                            name, cap
                        );
                        let deny_fn = make_throwing_function(ctx, &msg)?;
                        ctx.globals()
                            .set(name.as_str(), deny_fn)
                            .map_err(|e| XriptError::Engine(e.to_string()))?;
                        continue;
                    }
                }

                match host_bindings.bindings.get(name) {
                    Some(HostBinding::Function(f)) => {
                        let js_fn = create_host_function(ctx, name, f.clone())?;
                        ctx.globals()
                            .set(name.as_str(), js_fn)
                            .map_err(|e| XriptError::Engine(e.to_string()))?;
                    }
                    _ => {
                        let msg = format!("host binding '{}' is not provided", name);
                        let missing_fn = make_throwing_function(ctx, &msg)?;
                        ctx.globals()
                            .set(name.as_str(), missing_fn)
                            .map_err(|e| XriptError::Engine(e.to_string()))?;
                    }
                }
            }
            Binding::Namespace(ns_def) => {
                register_namespace_binding(ctx, name, ns_def, &host_bindings, granted)?;
            }
        }
    }

    Ok(())
}

fn register_namespace_binding(
    ctx: &Ctx<'_>,
    name: &str,
    ns_def: &NamespaceBinding,
    host_bindings: &HostBindings,
    granted: &HashSet<String>,
) -> Result<()> {
    let ns_obj = Object::new(ctx.clone()).map_err(|e| XriptError::Engine(e.to_string()))?;

    let host_ns = match host_bindings.bindings.get(name) {
        Some(HostBinding::Namespace(members)) => Some(members),
        _ => None,
    };

    for (member_name, member_binding) in &ns_def.members {
        if let Binding::Function(func_def) = member_binding {
            let full_name = format!("{}.{}", name, member_name);

            if let Some(ref cap) = func_def.capability {
                if !granted.contains(cap) {
                    let msg = format!(
                        "{}() requires the \"{}\" capability, which hasn't been granted to this script",
                        full_name, cap
                    );
                    let deny_fn = make_throwing_function(ctx, &msg)?;
                    ns_obj
                        .set(member_name.as_str(), deny_fn)
                        .map_err(|e| XriptError::Engine(e.to_string()))?;
                    continue;
                }
            }

            if let Some(host_members) = host_ns {
                if let Some(f) = host_members.get(member_name) {
                    let js_fn = create_host_function(ctx, &full_name, f.clone())?;
                    ns_obj
                        .set(member_name.as_str(), js_fn)
                        .map_err(|e| XriptError::Engine(e.to_string()))?;
                    continue;
                }
            }

            let msg = format!("host binding '{}' is not provided", full_name);
            let missing_fn = make_throwing_function(ctx, &msg)?;
            ns_obj
                .set(member_name.as_str(), missing_fn)
                .map_err(|e| XriptError::Engine(e.to_string()))?;
        }
    }

    ctx.globals()
        .set(name, ns_obj)
        .map_err(|e| XriptError::Engine(e.to_string()))?;

    let freeze_script = format!(
        "Object.freeze(globalThis['{}'])",
        name.replace('\'', "\\'")
    );
    ctx.eval::<(), _>(freeze_script.as_str())
        .map_err(|e| XriptError::Engine(e.to_string()))?;

    Ok(())
}

fn register_hooks(ctx: &Ctx<'_>, manifest: &Manifest, granted: &HashSet<String>) -> Result<()> {
    let Some(ref hooks) = manifest.hooks else {
        return Ok(());
    };

    if hooks.is_empty() {
        return Ok(());
    }

    let mut hook_setup = String::from("globalThis.__xript_hooks = {};\n");
    hook_setup.push_str("globalThis.hooks = {};\n");

    for (hook_name, hook_def) in hooks {
        hook_setup.push_str(&format!(
            "globalThis.__xript_hooks['{}'] = [];\n",
            hook_name
        ));

        if let Some(ref phases) = hook_def.phases {
            if !phases.is_empty() {
                hook_setup.push_str(&format!("globalThis.hooks['{}'] = {{}};\n", hook_name));
                for phase in phases {
                    let registration = if let Some(ref cap) = hook_def.capability {
                        if !granted.contains(cap) {
                            format!(
                                "globalThis.hooks['{hook}']['{phase}'] = function() {{ throw new Error(\"{hook}.{phase}() requires the \\\"{cap}\\\" capability\"); }};",
                                hook = hook_name, phase = phase, cap = cap
                            )
                        } else {
                            format!(
                                "globalThis.hooks['{hook}']['{phase}'] = function(handler) {{ globalThis.__xript_hooks['{hook}'].push({{ phase: '{phase}', handler: handler }}); }};",
                                hook = hook_name, phase = phase
                            )
                        }
                    } else {
                        format!(
                            "globalThis.hooks['{hook}']['{phase}'] = function(handler) {{ globalThis.__xript_hooks['{hook}'].push({{ phase: '{phase}', handler: handler }}); }};",
                            hook = hook_name, phase = phase
                        )
                    };
                    hook_setup.push_str(&registration);
                    hook_setup.push('\n');
                }
            }
        } else {
            let registration = if let Some(ref cap) = hook_def.capability {
                if !granted.contains(cap) {
                    format!(
                        "globalThis.hooks['{hook}'] = function() {{ throw new Error(\"{hook}() requires the \\\"{cap}\\\" capability\"); }};",
                        hook = hook_name, cap = cap
                    )
                } else {
                    format!(
                        "globalThis.hooks['{hook}'] = function(handler) {{ globalThis.__xript_hooks['{hook}'].push({{ handler: handler }}); }};",
                        hook = hook_name
                    )
                }
            } else {
                format!(
                    "globalThis.hooks['{hook}'] = function(handler) {{ globalThis.__xript_hooks['{hook}'].push({{ handler: handler }}); }};",
                    hook = hook_name
                )
            };
            hook_setup.push_str(&registration);
            hook_setup.push('\n');
        }
    }

    hook_setup.push_str("Object.freeze(globalThis.hooks);\n");

    ctx.eval::<(), _>(hook_setup.as_str())
        .map_err(|e| XriptError::Engine(e.to_string()))?;

    Ok(())
}

fn register_fragment_hooks(ctx: &Ctx<'_>) -> Result<()> {
    let script = r#"
        globalThis.__xript_fragment_handlers = {};

        var existingHooks = {};
        if (typeof globalThis.hooks === 'object' && globalThis.hooks !== null) {
            var hookKeys = Object.getOwnPropertyNames(globalThis.hooks);
            for (var i = 0; i < hookKeys.length; i++) {
                existingHooks[hookKeys[i]] = globalThis.hooks[hookKeys[i]];
            }
        }

        var fragmentNs = {};
        var lifecycles = ['mount', 'unmount', 'update', 'suspend', 'resume'];
        for (var j = 0; j < lifecycles.length; j++) {
            (function(lifecycle) {
                fragmentNs[lifecycle] = function(fragmentId, handler) {
                    var key = "fragment:" + lifecycle + ":" + fragmentId;
                    if (!globalThis.__xript_fragment_handlers[key]) {
                        globalThis.__xript_fragment_handlers[key] = [];
                    }
                    globalThis.__xript_fragment_handlers[key].push(handler);
                };
            })(lifecycles[j]);
        }
        Object.freeze(fragmentNs);
        existingHooks.fragment = fragmentNs;

        globalThis.hooks = existingHooks;
        Object.freeze(globalThis.hooks);
    "#;

    ctx.eval::<(), _>(script)
        .map_err(|e| XriptError::Engine(e.to_string()))?;

    Ok(())
}

fn create_host_function<'js>(
    ctx: &Ctx<'js>,
    name: &str,
    f: HostFn,
) -> Result<Function<'js>> {
    let bridge_fn = Function::new(ctx.clone(), move |args_json: String| -> String {
        let args: Vec<serde_json::Value> = match serde_json::from_str(&args_json) {
            Ok(a) => a,
            Err(e) => {
                let err = serde_json::json!({"__xript_err": format!("invalid args: {}", e)});
                return serde_json::to_string(&err).unwrap();
            }
        };
        match f(&args) {
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
        XriptError::Engine(format!("failed to create host function '{}': {}", name, e))
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

fn js_value_to_json(ctx: &Ctx<'_>, val: &Value<'_>) -> serde_json::Value {
    if val.is_undefined() || val.is_null() {
        return serde_json::Value::Null;
    }

    if let Some(b) = val.as_bool() {
        return serde_json::Value::Bool(b);
    }

    if let Some(n) = val.as_int() {
        return serde_json::json!(n);
    }

    if let Some(n) = val.as_float() {
        if n.is_finite() {
            return serde_json::json!(n);
        }
        return serde_json::Value::Null;
    }

    if let Some(s) = val.as_string() {
        if let Ok(s) = s.to_string() {
            return serde_json::Value::String(s);
        }
    }

    let stringify_result: std::result::Result<String, _> = ctx.eval(
        "((v) => JSON.stringify(v))",
    );
    if let Ok(stringify_fn_str) = stringify_result {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&stringify_fn_str) {
            return v;
        }
    }

    serde_json::Value::Null
}
