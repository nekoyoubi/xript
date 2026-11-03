//! Moving values across the host boundary.
//!
//! Inbound (a binding's return, a hook or event payload, an export's
//! arguments) a `serde_json::Value` is built into the sandbox natively, one
//! rquickjs call per node, with every key defined as an own data property, so
//! a key spelled `__proto__` stays data.
//!
//! Outbound, a primitive converts directly and anything else goes through the
//! sandbox's own `JSON.stringify` (so `toJSON`, getters and cycle detection
//! behave exactly as script expects).
//!
//! With [`RuntimeOptions::value_fidelity`](crate::RuntimeOptions::value_fidelity)
//! on, `undefined`, `NaN`, the infinities and `-0` cross as marker objects in both
//! directions instead of becoming `null` (see [`crate::value`]), and an
//! integral number held as a double reaches the host as an integer.
//!
//! The helper functions the bridge relies on are compiled once per runtime and
//! kept in the runtime's userdata, rather than evaluated per binding.

use rquickjs::object::Property;
use rquickjs::{Array, Ctx, Function, JsLifetime, Object, Value};

use crate::value::{Special, SPECIAL_MARKER};

const KIT_SOURCE: &str = r#"(function (specialKey, callbackKey, specials) {
    var stringify = JSON.stringify;
    var slice = Array.prototype.slice;
    var freezeObject = Object.freeze;
    var ownNames = Object.getOwnPropertyNames;
    var ownDescriptor = Object.getOwnPropertyDescriptor;
    function tag(v) {
        if (!specials) return null;
        if (v === undefined) return 'undefined';
        if (typeof v === 'number') {
            if (v !== v) return 'NaN';
            if (v === Infinity) return 'Infinity';
            if (v === -Infinity) return '-Infinity';
            if (v === 0 && 1 / v < 0) return '-0';
        }
        return null;
    }
    function encode(value, fns) {
        return stringify(value, function (key, v) {
            if (typeof v === 'function') {
                if (!fns) return undefined;
                var m = {};
                m[callbackKey] = fns.length;
                fns[fns.length] = v;
                return m;
            }
            var t = tag(v);
            if (t !== null) {
                var s = {};
                s[specialKey] = t;
                return s;
            }
            return v;
        });
    }
    function bridge(call, checks, name) {
        return function () {
            var args = slice.call(arguments);
            for (var i = 0; i < checks.length; i++) {
                var check = checks[i];
                var value = args[check.index];
                if (typeof value === 'function') continue;
                if (check.optional && (value === undefined || value === null)) continue;
                throw new TypeError(name + '(): parameter "' + check.name + '" expects a function, got ' + (value === null ? 'null' : typeof value));
            }
            var fns = [];
            return call(encode(args, fns), fns);
        };
    }
    function thrower(message) {
        return function () { throw new Error(message); };
    }
    function deepFreeze(root) {
        var seen = [];
        function freeze(o) {
            if (o === null || typeof o !== 'object') return;
            if (seen.indexOf(o) !== -1) return;
            seen.push(o);
            var keys = ownNames(o);
            for (var i = 0; i < keys.length; i++) {
                var d = ownDescriptor(o, keys[i]);
                if (d && 'value' in d) freeze(d.value);
            }
            freezeObject(o);
        }
        freeze(root);
    }
    return [encode, bridge, thrower, deepFreeze];
})"#;

/// The bridge helpers, compiled once per runtime.
#[derive(Clone)]
pub(crate) struct Kit<'js> {
    encode: Function<'js>,
    bridge: Function<'js>,
    thrower: Function<'js>,
    deep_freeze: Function<'js>,
    fidelity: bool,
}

unsafe impl<'js> JsLifetime<'js> for Kit<'js> {
    type Changed<'to> = Kit<'to>;
}

impl<'js> Kit<'js> {
    /// Compiles the runtime's kit. Runs once, at construction, before any mod
    /// code can replace the built-ins it captures.
    pub(crate) fn install(ctx: &Ctx<'js>, fidelity: bool) -> rquickjs::Result<Kit<'js>> {
        let factory: Function = ctx.eval(KIT_SOURCE)?;
        let parts: Array = factory.call((SPECIAL_MARKER, crate::callback::CALLBACK_MARKER, fidelity))?;
        let kit = Kit {
            encode: parts.get(0)?,
            bridge: parts.get(1)?,
            thrower: parts.get(2)?,
            deep_freeze: parts.get(3)?,
            fidelity,
        };
        let _ = ctx.store_userdata(kit.clone());
        Ok(kit)
    }

    /// The runtime's kit.
    pub(crate) fn of(ctx: &Ctx<'js>) -> rquickjs::Result<Kit<'js>> {
        if let Some(kit) = ctx.userdata::<Kit<'js>>() {
            return Ok(kit.clone());
        }
        Kit::install(ctx, false)
    }

    /// Whether special values cross as markers on this runtime.
    pub(crate) fn fidelity(ctx: &Ctx<'js>) -> bool {
        ctx.userdata::<Kit<'js>>().is_some_and(|kit| kit.fidelity)
    }

    /// Wraps a native `call(argsJson, fns)` as the function script calls: it
    /// refuses a non-function where `checks` declares one, then encodes the
    /// arguments with callback and special-value markers.
    pub(crate) fn bridge(&self, call: Function<'js>, checks: Value<'js>, name: &str) -> rquickjs::Result<Function<'js>> {
        self.bridge.call((call, checks, name))
    }

    /// A function that throws `new Error(message)` whenever it is called.
    pub(crate) fn thrower(&self, message: &str) -> rquickjs::Result<Function<'js>> {
        self.thrower.call((message,))
    }

    /// Freezes `root` and everything reachable from it.
    pub(crate) fn deep_freeze(&self, root: Value<'js>) -> rquickjs::Result<()> {
        self.deep_freeze.call((root,))
    }

    fn encode(&self, value: &Value<'js>) -> rquickjs::Result<Value<'js>> {
        self.encode.call((value.clone(), Value::new_undefined(value.ctx().clone())))
    }
}

/// The global a stashed value is taken through.
pub(crate) const TAKE_GLOBAL: &str = "__xript_take";

/// Host values waiting to be read by runtime-generated code. The code names a
/// value by its id and `__xript_take(id)` builds it natively and forgets it, so
/// a payload never travels as JSON text spliced into source.
#[derive(Default)]
pub(crate) struct Stash {
    next: std::sync::atomic::AtomicU64,
    pending: std::sync::Mutex<std::collections::HashMap<u64, serde_json::Value>>,
}

impl Stash {
    /// Installs `__xript_take` on the context, bound to this stash.
    pub(crate) fn install<'js>(self: &std::sync::Arc<Self>, ctx: &Ctx<'js>) -> rquickjs::Result<()> {
        let stash = self.clone();
        let take = Function::new(ctx.clone(), move |ctx: Ctx<'js>, id: f64| -> rquickjs::Result<Value<'js>> {
            match stash.remove(id as u64) {
                Some(value) => host_to_js(&ctx, &value).map_err(|message| rquickjs::Exception::throw_message(&ctx, &message)),
                None => Ok(Value::new_undefined(ctx)),
            }
        })?;
        ctx.globals().prop(TAKE_GLOBAL, Property::from(take))
    }

    /// Holds `value` until the code naming the returned ticket takes it. The
    /// ticket forgets the value when dropped, taken or not.
    pub(crate) fn put(self: &std::sync::Arc<Self>, value: serde_json::Value) -> Ticket {
        let id = self.next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        self.pending.lock().unwrap_or_else(|p| p.into_inner()).insert(id, value);
        Ticket { stash: self.clone(), id }
    }

    fn remove(&self, id: u64) -> Option<serde_json::Value> {
        self.pending.lock().unwrap_or_else(|p| p.into_inner()).remove(&id)
    }
}

/// A stashed value's claim. `expr()` is the JS expression that takes it.
pub(crate) struct Ticket {
    stash: std::sync::Arc<Stash>,
    id: u64,
}

impl Ticket {
    pub(crate) fn expr(&self) -> String {
        format!("{TAKE_GLOBAL}({})", self.id)
    }
}

impl Drop for Ticket {
    fn drop(&mut self) {
        self.stash.remove(self.id);
    }
}

/// A host value as the sandbox receives it: built natively, then with every
/// retained-callback marker revived into the script function it names. A
/// released or foreign marker fails with its reason; a marker that names no
/// retained callback stays plain data. Every host-to-sandbox path (a binding's
/// return, export args, hook payloads, fragment-hook bindings, callback args)
/// goes through here.
pub(crate) fn host_to_js<'js>(ctx: &Ctx<'js>, value: &serde_json::Value) -> Result<Value<'js>, String> {
    crate::retained::host_value_to_js(ctx, value).map_err(|error| match error {
        crate::retained::HostValueError::Marshal(message) => message,
        crate::retained::HostValueError::Callback(error) => error.to_string(),
    })
}

/// Builds `value` in the sandbox, decoding special-value markers when the
/// runtime has them on.
pub(crate) fn to_js<'js>(ctx: &Ctx<'js>, value: &serde_json::Value) -> rquickjs::Result<Value<'js>> {
    build(ctx, value, Kit::fidelity(ctx))
}

fn build<'js>(ctx: &Ctx<'js>, value: &serde_json::Value, specials: bool) -> rquickjs::Result<Value<'js>> {
    Ok(match value {
        serde_json::Value::Null => Value::new_null(ctx.clone()),
        serde_json::Value::Bool(b) => Value::new_bool(ctx.clone(), *b),
        serde_json::Value::Number(n) => float_tagged(ctx, n.as_f64().unwrap_or(f64::NAN)),
        serde_json::Value::String(s) => rquickjs::String::from_str(ctx.clone(), s)?.into_value(),
        serde_json::Value::Array(items) => {
            let array = Array::new(ctx.clone())?;
            for (index, item) in items.iter().enumerate() {
                array.set(index, build(ctx, item, specials)?)?;
            }
            array.into_value()
        }
        serde_json::Value::Object(map) => {
            if specials && let Some(special) = Special::from_value(value) {
                return Ok(special_to_js(ctx, special));
            }
            let object = Object::new(ctx.clone())?;
            for (key, item) in map {
                object.prop(
                    key.as_str(),
                    Property::from(build(ctx, item, specials)?).writable().enumerable().configurable(),
                )?;
            }
            object.into_value()
        }
    })
}

/// A host number as the sandbox receives it: always a double, never narrowed
/// to an int even when integral, which is what `JSON.parse` produces and so
/// what a host number has always arrived as.
fn float_tagged<'js>(ctx: &Ctx<'js>, number: f64) -> Value<'js> {
    // SAFETY: a float64 JSValue carries no reference count or pointer.
    unsafe { Value::from_raw(ctx.clone(), rquickjs::qjs::__JS_NewFloat64(number)) }
}

fn special_to_js<'js>(ctx: &Ctx<'js>, special: Special) -> Value<'js> {
    match special.as_f64() {
        Some(number) => Value::new_float(ctx.clone(), number),
        None => Value::new_undefined(ctx.clone()),
    }
}

/// Reads a sandbox value out for the host. A function or symbol at the top
/// level is `null`, as it is inside an array; inside an object it is omitted,
/// which is what JSON does. `undefined`, `NaN` and the infinities are `null`,
/// or markers when the runtime has them on; `-0` is a float, or its marker.
pub(crate) fn to_json<'js>(ctx: &Ctx<'js>, value: &Value<'js>) -> serde_json::Value {
    if value.is_undefined() {
        return special_or_null(ctx, Special::Undefined);
    }
    if value.is_null() || value.is_function() || value.is_symbol() {
        return serde_json::Value::Null;
    }
    if let Some(b) = value.as_bool() {
        return serde_json::Value::Bool(b);
    }
    if let Some(i) = value.as_int() {
        return serde_json::Value::from(i);
    }
    if let Some(f) = value.as_float() {
        return match Special::from_f64(f) {
            Some(Special::NegZero) if !Kit::fidelity(ctx) => float_value(ctx, f),
            Some(special) => special_or_null(ctx, special),
            None => float_value(ctx, f),
        };
    }
    if let Some(s) = value.as_string() {
        return s.to_string().map(serde_json::Value::String).unwrap_or(serde_json::Value::Null);
    }

    let encoded = Kit::of(ctx).and_then(|kit| kit.encode(value));
    match encoded {
        Ok(text) => text
            .as_string()
            .and_then(|s| s.to_string().ok())
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or(serde_json::Value::Null),
        Err(rquickjs::Error::Exception) => {
            let _ = ctx.catch();
            serde_json::Value::Null
        }
        Err(_) => serde_json::Value::Null,
    }
}

fn special_or_null<'js>(ctx: &Ctx<'js>, special: Special) -> serde_json::Value {
    if Kit::fidelity(ctx) {
        special.to_value()
    } else {
        serde_json::Value::Null
    }
}

/// A finite script number held as a double, as the host receives it. With
/// value fidelity on, an integral value is an integer, exactly as the same
/// number nested in an object or array arrives, so `10` reads the same
/// whichever path made it; otherwise it stays a float.
fn float_value<'js>(ctx: &Ctx<'js>, number: f64) -> serde_json::Value {
    if Kit::fidelity(ctx) {
        return crate::value::special::number(number);
    }
    serde_json::Number::from_f64(number)
        .map(serde_json::Value::Number)
        .unwrap_or(serde_json::Value::Null)
}
