//! Which declared bindings a host actually provides, what an omitted one
//! becomes, and accessor bindings.
//!
//! A manifest can be shared by hosts that do not all provide the same surface.
//! A binding declared `optional` may be omitted: it reads as `undefined` in the
//! sandbox, and `xript.has(path)` answers whether it is there. Omitting a
//! binding that is not optional is drift, reported through `missing_bindings`
//! and installed as a stub that throws.

use std::collections::HashSet;
use std::sync::Arc;

use rquickjs::{Ctx, Function, Object, Value};

use super::{
    audited_sync, create_host_function, make_denied_function, make_missing_function, AuditSink, HostBinding, HostBindings, HostFn,
    HostNamespaceMember, HostNsView, RuntimeProbe,
};
use crate::error::{Result, XriptError};
use crate::manifest::{AccessorBinding, AccessorMode, Binding, Manifest};

/// Reads an accessor's current value. Runs on every read.
pub type AccessorGetFn = Arc<dyn Fn() -> std::result::Result<serde_json::Value, String> + Send + Sync>;

/// Stores an assigned value. Runs on every assignment.
pub type AccessorSetFn = Arc<dyn Fn(serde_json::Value) -> std::result::Result<(), String> + Send + Sync>;

/// A live value a host supplies for a binding the manifest declares with
/// `accessor`: the getter runs on every read and the setter, when present, on
/// every assignment. A `get-set` declaration needs a setter; a host that can
/// only read declares `get`.
#[derive(Clone)]
pub struct HostAccessor {
    get: AccessorGetFn,
    set: Option<AccessorSetFn>,
}

impl HostAccessor {
    /// A read-only accessor.
    pub fn new<G>(get: G) -> Self
    where
        G: Fn() -> std::result::Result<serde_json::Value, String> + Send + Sync + 'static,
    {
        Self {
            get: Arc::new(get),
            set: None,
        }
    }

    /// Adds a setter, called with each assigned value.
    pub fn with_setter<S>(mut self, set: S) -> Self
    where
        S: Fn(serde_json::Value) -> std::result::Result<(), String> + Send + Sync + 'static,
    {
        self.set = Some(Arc::new(set));
        self
    }

    fn getter_fn(&self) -> HostFn {
        let get = self.get.clone();
        Arc::new(move |_| get())
    }

    fn setter_fn(&self) -> Option<HostFn> {
        let set = self.set.clone()?;
        Some(Arc::new(move |args: &[serde_json::Value]| {
            set(args.first().cloned().unwrap_or(serde_json::Value::Null))?;
            Ok(serde_json::Value::Null)
        }))
    }
}

/// What a host supplies at one binding path.
#[derive(Clone, Copy)]
pub(super) enum Supplied<'a> {
    Callable,
    Value,
    Accessor(&'a HostAccessor),
    Namespace(HostNsView<'a>),
    Absent,
}

/// An accessor registered at `path`, or a namespace implied by accessors
/// registered beneath it, when the view itself supplies nothing there.
fn registered<'a>(host: &'a HostBindings, path: &str, from_view: Supplied<'a>) -> Supplied<'a> {
    if let Some(accessor) = host.accessors.get(path) {
        return Supplied::Accessor(accessor);
    }
    if matches!(from_view, Supplied::Absent) {
        let prefix = format!("{path}.");
        if host.accessors.keys().any(|key| key.starts_with(&prefix)) {
            return Supplied::Namespace(HostNsView::None);
        }
    }
    from_view
}

pub(super) fn top_level<'a>(host: &'a HostBindings, name: &str) -> Supplied<'a> {
    registered(host, name, top_level_view(host, name))
}

pub(super) fn member<'a>(host: &'a HostBindings, view: &HostNsView<'a>, name: &str, path: &str) -> Supplied<'a> {
    registered(host, path, member_view(view, name))
}

fn top_level_view<'a>(host: &'a HostBindings, name: &str) -> Supplied<'a> {
    match host.bindings.get(name) {
        Some(HostBinding::Function(_))
        | Some(HostBinding::FunctionWithCaller(_))
        | Some(HostBinding::AsyncFunction(_)) => Supplied::Callable,
        Some(HostBinding::Namespace(m)) => Supplied::Namespace(HostNsView::Sync(m)),
        Some(HostBinding::AsyncNamespace(m)) => Supplied::Namespace(HostNsView::Async(m)),
        Some(HostBinding::MixedNamespace {
            properties,
            functions,
        }) => Supplied::Namespace(HostNsView::Mixed {
            properties,
            functions,
        }),
        Some(HostBinding::NestedNamespace(m)) => Supplied::Namespace(HostNsView::Nested(m)),
        None => Supplied::Absent,
    }
}

fn member_view<'a>(view: &HostNsView<'a>, name: &str) -> Supplied<'a> {
    match *view {
        HostNsView::Sync(map) if map.contains_key(name) => Supplied::Callable,
        HostNsView::Async(map) if map.contains_key(name) => Supplied::Callable,
        HostNsView::Mixed {
            properties,
            functions,
        } => {
            if properties.contains_key(name) {
                Supplied::Value
            } else if functions.contains_key(name) {
                Supplied::Callable
            } else {
                Supplied::Absent
            }
        }
        HostNsView::Nested(map) => match map.get(name) {
            Some(HostNamespaceMember::Function(_))
            | Some(HostNamespaceMember::CallerFunction(_))
            | Some(HostNamespaceMember::AsyncFunction(_)) => Supplied::Callable,
            Some(HostNamespaceMember::Property(_)) => Supplied::Value,
            Some(HostNamespaceMember::Namespace(sub)) => Supplied::Namespace(HostNsView::Nested(sub)),
            None => Supplied::Absent,
        },
        _ => Supplied::Absent,
    }
}

/// Whether the host supplies what `binding` declares. An eager property counts
/// for a function-declared member, as it always has installed.
pub(super) fn supplies(binding: &Binding, supplied: &Supplied<'_>) -> bool {
    match (binding, supplied) {
        (Binding::Namespace(_), Supplied::Namespace(_)) => true,
        (Binding::Accessor(def), Supplied::Accessor(a)) => def.accessor == AccessorMode::Get || a.set.is_some(),
        (Binding::Function(_), Supplied::Callable | Supplied::Value) => true,
        _ => false,
    }
}

/// The supply rule drift reporting has always used: a function-declared
/// member counts only when the host registered something callable for it.
fn supplies_for_drift(binding: &Binding, supplied: &Supplied<'_>) -> bool {
    match (binding, supplied) {
        (Binding::Function(_), Supplied::Value) => false,
        _ => supplies(binding, supplied),
    }
}

/// Whether a declared binding the host left out is bound to `undefined`
/// instead of installed.
pub(super) fn omits(binding: &Binding, supplied: &Supplied<'_>) -> bool {
    binding.is_optional() && !supplies(binding, supplied)
}

fn namespace_view<'a>(supplied: &Supplied<'a>) -> HostNsView<'a> {
    match *supplied {
        Supplied::Namespace(view) => view,
        _ => HostNsView::None,
    }
}

/// Every binding the manifest declares that `host_bindings` does not supply, fully
/// qualified and sorted.
///
/// A declared-but-unsupplied binding still installs — as a stub that throws when a mod
/// calls it — so the manifest and the host's actual wiring could disagree indefinitely
/// with nothing to catch it. A mod author reads the manifest, ships against a binding
/// that is documented and absent, and the failure lands on a user. An optional binding
/// the host omits is not drift, and neither is anything beneath an optional namespace
/// the host omits.
pub fn missing_binding_names(manifest: &Manifest, host_bindings: &HostBindings) -> Vec<String> {
    let mut missing = Vec::new();
    if let Some(bindings) = manifest.bindings.as_ref() {
        for (name, binding) in bindings {
            collect_missing(host_bindings, binding, top_level(host_bindings, name), name, &mut missing);
        }
    }
    missing.sort();
    missing
}

fn collect_missing(host: &HostBindings, binding: &Binding, supplied: Supplied<'_>, path: &str, out: &mut Vec<String>) {
    if omits(binding, &supplied) {
        return;
    }
    match binding {
        Binding::Namespace(ns) => {
            let view = namespace_view(&supplied);
            for (name, child) in &ns.members {
                let child_path = format!("{path}.{name}");
                collect_missing(host, child, member(host, &view, name, &child_path), &child_path, out);
            }
        }
        _ => {
            if !supplies_for_drift(binding, &supplied) {
                out.push(path.to_string());
            }
        }
    }
}

/// Every declared binding path this host provides, for `xript.has`. A namespace
/// counts when the host supplies it; its members count on their own. It uses
/// the drift rule, so `has` never claims a binding `missing_binding_names`
/// reports: a function-declared member supplied as an eager value is neither.
fn provided_binding_paths(manifest: &Manifest, host_bindings: &HostBindings) -> Vec<String> {
    let mut provided = Vec::new();
    if let Some(bindings) = manifest.bindings.as_ref() {
        for (name, binding) in bindings {
            collect_provided(host_bindings, binding, top_level(host_bindings, name), name, &mut provided);
        }
    }
    provided.sort();
    provided
}

fn collect_provided(host: &HostBindings, binding: &Binding, supplied: Supplied<'_>, path: &str, out: &mut Vec<String>) {
    if !supplies_for_drift(binding, &supplied) {
        return;
    }
    out.push(path.to_string());
    if let Binding::Namespace(ns) = binding {
        let view = namespace_view(&supplied);
        for (name, child) in &ns.members {
            let child_path = format!("{path}.{name}");
            collect_provided(host, child, member(host, &view, name, &child_path), &child_path, out);
        }
    }
}

/// Installs `xript.has(path)` over the paths this host provides. The set lives
/// in a closure the script cannot reach, and `has` is a non-writable property,
/// so a mod can neither forge presence nor replace the probe.
pub(super) fn install_probe(ctx: &Ctx<'_>, manifest: &Manifest, host_bindings: &HostBindings) -> Result<()> {
    let paths = serde_json::to_string(&provided_binding_paths(manifest, host_bindings))
        .map_err(|e| XriptError::Engine(e.to_string()))?;
    let script = format!(
        r#"(function (paths) {{
            var known = Object.create(null);
            for (var i = 0; i < paths.length; i++) known[paths[i]] = true;
            var has = function has(path) {{ return typeof path === "string" && known[path] === true; }};
            var ns = globalThis.xript;
            if (ns === null || typeof ns !== "object") {{ ns = {{}}; globalThis.xript = ns; }}
            Object.defineProperty(ns, "has", {{ value: has, enumerable: true, writable: false, configurable: false }});
        }})({paths});"#
    );
    ctx.eval::<(), _>(script.as_str())
        .map_err(|e| XriptError::Engine(e.to_string()))
}

const DEFINE_ACCESSOR: &str = r#"(function (target, key, get, set, name) {
    Object.defineProperty(target, key, {
        get: function () { return get(); },
        set: set ? function (value) { set(value); } : function () { throw new TypeError(name + " is read-only: the host declares no setter"); },
        enumerable: true,
        configurable: false
    });
})"#;

/// Defines an accessor binding on `target`. The getter and setter are the
/// runtime's ordinary binding wrappers, so each access is capability-gated,
/// audited, budgeted, and error-marshalled exactly as a function call. Without
/// a setter, assignment throws a `TypeError` in strict and sloppy code alike.
#[allow(clippy::too_many_arguments)]
pub(super) fn install_accessor<'js>(
    ctx: &Ctx<'js>,
    target: &Object<'js>,
    key: &str,
    full_name: &str,
    def: &AccessorBinding,
    supplied: &Supplied<'_>,
    granted: &HashSet<String>,
    audit: &Option<AuditSink>,
    probe: &Arc<RuntimeProbe>,
) -> Result<()> {
    let host = match supplied {
        Supplied::Accessor(a) if def.accessor == AccessorMode::Get || a.set.is_some() => Some(*a),
        _ => None,
    };
    let getter = accessor_half(ctx, full_name, def, host.map(HostAccessor::getter_fn), granted, audit, probe)?;
    let setter = match def.accessor {
        AccessorMode::Get => Value::new_undefined(ctx.clone()),
        AccessorMode::GetSet => {
            accessor_half(ctx, full_name, def, host.and_then(HostAccessor::setter_fn), granted, audit, probe)?
                .into_value()
        }
    };
    let define: Function = ctx
        .eval(DEFINE_ACCESSOR)
        .map_err(|e| XriptError::Engine(e.to_string()))?;
    define
        .call::<_, ()>((target.clone(), key, getter, setter, full_name))
        .map_err(|e| XriptError::Engine(e.to_string()))
}

fn accessor_half<'js>(
    ctx: &Ctx<'js>,
    full_name: &str,
    def: &AccessorBinding,
    host_fn: Option<HostFn>,
    granted: &HashSet<String>,
    audit: &Option<AuditSink>,
    probe: &Arc<RuntimeProbe>,
) -> Result<Function<'js>> {
    if let Some(cap) = def.capability.as_ref()
        && !crate::cap_match::granted_satisfies(granted, cap)
    {
        return make_denied_function(ctx, full_name, cap);
    }
    match host_fn {
        Some(f) => {
            let wrapped = audited_sync(f, audit, full_name, def.capability.clone(), probe);
            create_host_function(ctx, full_name, wrapped, &[])
        }
        None => make_missing_function(ctx, full_name),
    }
}
