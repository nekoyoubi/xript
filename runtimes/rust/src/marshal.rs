//! Moving values across the host boundary.
//!
//! Inbound (a binding's return, a hook or event payload, an export's
//! arguments) a `serde_json::Value` is built into the sandbox natively, one
//! rquickjs call per node, with every key defined as an own data property, so
//! a key spelled `__proto__` stays data.
//!
//! Outbound, a primitive converts directly and anything else is walked the way
//! `JSON.stringify` walks it: `toJSON` applied (one that throws is skipped and
//! the object crosses by its own properties), `Number`/`String`/`Boolean`/
//! `BigInt` wrappers unwrapped, own enumerable string keys read once each, so a
//! getter runs exactly once and a getter that throws fails the crossing with
//! its own error.
//!
//! Both directions walk with an explicit stack rather than by recursion, so a
//! value nested [`crate::value::MAX_DEPTH`] levels deep costs no native stack;
//! past that the crossing is refused.
//!
//! With [`RuntimeOptions::value_fidelity`](crate::RuntimeOptions::value_fidelity)
//! on, the values JSON cannot spell cross as marker objects in both directions
//! (see [`crate::value`]), and an integral number held as a double reaches the
//! host as an integer. With it off, `undefined`, `NaN` and the infinities are
//! `null`, a lone surrogate becomes U+FFFD, and a BigInt or a cycle refuses to
//! cross.
//!
//! The helper functions the bridge relies on are compiled once per runtime and
//! kept in the runtime's userdata, rather than evaluated per binding.

use rquickjs::function::This;
use rquickjs::object::Property;
use rquickjs::{qjs, Array, Ctx, Function, JsLifetime, Object, Type, Value};

use crate::value::{Marker, Special, MAX_DEPTH};

const KIT_SOURCE: &str = r#"(function () {
    var reflectApply = Reflect.apply;
    var freezeObject = Object.freeze;
    var ownNames = Object.getOwnPropertyNames;
    var ownDescriptor = Object.getOwnPropertyDescriptor;
    var defineProperty = Object.defineProperty;
    var charCodeAt = String.prototype.charCodeAt;
    var ErrorCtor = Error;
    var TypeErrorCtor = TypeError;
    function bridge(call, checks, name) {
        return function () {
            for (var i = 0; i < checks.length; i++) {
                var check = checks[i];
                var value = arguments[check.index];
                if (typeof value === 'function') continue;
                if (check.optional && (value === undefined || value === null)) continue;
                throw new TypeErrorCtor(name + '(): parameter "' + check.name + '" expects a function, got ' + (value === null ? 'null' : typeof value));
            }
            return reflectApply(call, undefined, arguments);
        };
    }
    function own(target, key, value) {
        defineProperty(target, key, { value: value, writable: true, enumerable: true, configurable: true });
    }
    class BindingError extends ErrorCtor {
        constructor(binding, message) {
            super(binding + '(): ' + message);
            own(this, 'name', 'BindingError');
            own(this, 'binding', binding);
        }
    }
    class CapabilityDeniedError extends ErrorCtor {
        constructor(binding, capability) {
            super(binding + '() requires the "' + capability + '" capability, which hasn\'t been granted to this script. Ask the app developer to enable it.');
            own(this, 'name', 'CapabilityDeniedError');
            own(this, 'capability', capability);
            own(this, 'binding', binding);
        }
    }
    function makeError(kind, first, second) {
        return kind === 'capability' ? new CapabilityDeniedError(first, second) : new BindingError(first, second);
    }
    function thrower(kind, first, second) {
        return function () { throw makeError(kind, first, second); };
    }
    function deepFreeze(root) {
        var seen = [];
        function freeze(o) {
            if (o === null || typeof o !== 'object') return;
            for (var s = 0; s < seen.length; s++) {
                if (seen[s] === o) return;
            }
            defineProperty(seen, seen.length, { value: o, writable: true, enumerable: true, configurable: true });
            var keys = ownNames(o);
            for (var i = 0; i < keys.length; i++) {
                var d = ownDescriptor(o, keys[i]);
                if (d && 'value' in d) freeze(d.value);
            }
            freezeObject(o);
        }
        freeze(root);
    }
    function units(s) {
        var out = [];
        for (var i = 0; i < s.length; i++) {
            defineProperty(out, i, { value: reflectApply(charCodeAt, s, [i]), writable: true, enumerable: true, configurable: true });
        }
        return out;
    }
    function toJSONOf(v) {
        return v.toJSON;
    }
    return [
        bridge, thrower, deepFreeze, units, toJSONOf,
        Number.prototype.valueOf, String.prototype.valueOf, Boolean.prototype.valueOf, BigInt.prototype.valueOf,
        BigInt.prototype.toString, BigInt, Symbol,
        new Number(0), new String(''), new Boolean(false), Object(BigInt(0)),
        Array.isArray, makeError, BindingError, CapabilityDeniedError
    ];
})"#;

/// `message` without a leading `<binding>(): `, so the error names it once.
pub(crate) fn unprefixed<'m>(binding: &str, message: &'m str) -> &'m str {
    message.strip_prefix(format!("{binding}(): ").as_str()).unwrap_or(message)
}

/// Throws a `BindingError` for `binding` carrying `message`, prefixed once.
pub(crate) fn throw_binding_error(ctx: &Ctx<'_>, binding: &str, message: &str) -> rquickjs::Error {
    match Kit::of(ctx).and_then(|kit| kit.binding_error(binding, message)) {
        Ok(error) => ctx.throw(error),
        Err(_) => rquickjs::Exception::throw_message(ctx, &format!("{binding}(): {}", unprefixed(binding, message))),
    }
}

/// The runtime's kit, borrowed from the context rather than cloned, since it
/// is read on every crossing.
pub(crate) enum KitRef<'a, 'js> {
    Stored(rquickjs::runtime::UserDataGuard<'a, Kit<'js>>),
    Owned(Box<Kit<'js>>),
}

impl<'js> std::ops::Deref for KitRef<'_, 'js> {
    type Target = Kit<'js>;

    fn deref(&self) -> &Kit<'js> {
        match self {
            KitRef::Stored(kit) => kit,
            KitRef::Owned(kit) => kit,
        }
    }
}

/// The bridge helpers, compiled once per runtime.
#[derive(Clone)]
pub(crate) struct Kit<'js> {
    bridge: Function<'js>,
    thrower: Function<'js>,
    deep_freeze: Function<'js>,
    units: Function<'js>,
    to_json_of: Function<'js>,
    wrappers: [(qjs::JSClassID, Function<'js>); 4],
    bigint_digits: Function<'js>,
    make_bigint: Function<'js>,
    make_symbol: Function<'js>,
    is_array: Function<'js>,
    make_error: Function<'js>,
    binding_error_class: Function<'js>,
    capability_error_class: Function<'js>,
    to_json_key: rquickjs::Atom<'js>,
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
        let parts: Array = factory.call(())?;
        let class_of = |index: usize| -> rquickjs::Result<qjs::JSClassID> {
            let sample: Value = parts.get(index)?;
            // SAFETY: `sample` is a live object value owned by this context.
            Ok(unsafe { qjs::JS_GetClassID(sample.as_raw()) })
        };
        let kit = Kit {
            bridge: parts.get(0)?,
            thrower: parts.get(1)?,
            deep_freeze: parts.get(2)?,
            units: parts.get(3)?,
            to_json_of: parts.get(4)?,
            wrappers: [
                (class_of(12)?, parts.get(5)?),
                (class_of(13)?, parts.get(6)?),
                (class_of(14)?, parts.get(7)?),
                (class_of(15)?, parts.get(8)?),
            ],
            bigint_digits: parts.get(9)?,
            make_bigint: parts.get(10)?,
            make_symbol: parts.get(11)?,
            is_array: parts.get(16)?,
            make_error: parts.get(17)?,
            binding_error_class: parts.get(18)?,
            capability_error_class: parts.get(19)?,
            to_json_key: rquickjs::Atom::from_str(ctx.clone(), "toJSON")?,
            fidelity,
        };
        let _ = ctx.store_userdata(kit.clone());
        Ok(kit)
    }

    /// The runtime's kit.
    pub(crate) fn of<'a>(ctx: &'a Ctx<'js>) -> rquickjs::Result<KitRef<'a, 'js>> {
        if let Some(kit) = ctx.userdata::<Kit<'js>>() {
            return Ok(KitRef::Stored(kit));
        }
        Kit::install(ctx, false).map(|kit| KitRef::Owned(Box::new(kit)))
    }

    /// Wraps a native `call(...args)` as the function script calls: it refuses
    /// a non-function where `checks` declares one, then hands the native side
    /// the arguments unchanged.
    pub(crate) fn bridge(&self, call: Function<'js>, checks: Value<'js>, name: &str) -> rquickjs::Result<Function<'js>> {
        self.bridge.call((call, checks, name))
    }

    /// A function that throws `BindingError(binding, message)` whenever it is
    /// called.
    pub(crate) fn binding_thrower(&self, binding: &str, message: &str) -> rquickjs::Result<Function<'js>> {
        self.thrower.call(("binding", binding, message))
    }

    /// A function that throws `CapabilityDeniedError(binding, capability)`
    /// whenever it is called.
    pub(crate) fn denied_thrower(&self, binding: &str, capability: &str) -> rquickjs::Result<Function<'js>> {
        self.thrower.call(("capability", binding, capability))
    }

    /// The kit's `BindingError` and `CapabilityDeniedError` classes, the ones
    /// every error it builds is an instance of.
    pub(crate) fn error_classes(&self) -> (Function<'js>, Function<'js>) {
        (self.binding_error_class.clone(), self.capability_error_class.clone())
    }

    /// The function that builds the errors a binding throws, called as
    /// `makeError("binding", binding, reason)` or
    /// `makeError("capability", binding, capability)`.
    pub(crate) fn error_factory(&self) -> Function<'js> {
        self.make_error.clone()
    }

    /// A `BindingError` for `binding`, its message `<binding>(): <message>`
    /// with the prefix written once even when `message` already carries it.
    pub(crate) fn binding_error(&self, binding: &str, message: &str) -> rquickjs::Result<Value<'js>> {
        self.make_error.call(("binding", binding, unprefixed(binding, message)))
    }

    /// Freezes `root` and everything reachable from it.
    pub(crate) fn deep_freeze(&self, root: Value<'js>) -> rquickjs::Result<()> {
        self.deep_freeze.call((root,))
    }

    fn units_of(&self, text: &rquickjs::String<'js>) -> rquickjs::Result<Vec<u16>> {
        let units: Vec<f64> = self.units.call((text.clone(),))?;
        Ok(units.into_iter().map(|unit| unit as u16).collect())
    }

    /// A script string as Rust reads it: as UTF-8 when it is well-formed,
    /// else its code units.
    fn read_string(&self, text: &rquickjs::String<'js>) -> rquickjs::Result<Result<String, Vec<u16>>> {
        match text.to_string() {
            Ok(text) => Ok(Ok(text)),
            Err(_) => self.units_of(text).map(Err),
        }
    }

    fn unwrap_primitive(&self, value: Value<'js>) -> rquickjs::Result<Value<'js>> {
        // SAFETY: `value` is a live value owned by this context.
        let class = unsafe { qjs::JS_GetClassID(value.as_raw()) };
        match self.wrappers.iter().find(|(id, _)| *id == class) {
            Some((_, value_of)) => value_of.call((This(value),)),
            None => Ok(value),
        }
    }
}

/// The internal helper dispatch passes each handler's result through before
/// collecting it, so a result that is a symbol crosses as its marker the way a
/// script's own result does, though it sits in an envelope.
pub(crate) const RESULT_HELPER: &str = "result";

/// Installs [`RESULT_HELPER`] on the internals object: a symbol becomes its
/// marker object when value fidelity is on, and anything else passes through
/// untouched.
pub(crate) fn install_result_helper<'js>(ctx: &Ctx<'js>) -> rquickjs::Result<()> {
    let helper = Function::new(ctx.clone(), |ctx: Ctx<'js>, value: Value<'js>| -> rquickjs::Result<Value<'js>> {
        let kit = Kit::of(&ctx)?;
        if !kit.fidelity || !value.is_symbol() {
            return Ok(value);
        }
        let marker = Encoder::new(&ctx, &kit)
            .encode(value, Key::Root, true)
            .map_err(|error| match error {
                CrossError::Thrown(thrown) => ctx.throw(thrown),
                CrossError::Refused(message) => rquickjs::Exception::throw_message(&ctx, &message),
            })?
            .unwrap_or_default();
        let object = Object::new(ctx.clone())?;
        if let serde_json::Value::Object(fields) = marker {
            for (key, field) in fields {
                object.set(key, field.as_str().unwrap_or_default())?;
            }
        }
        Ok(object.into_value())
    })?;
    crate::internals::of(ctx)?.set(RESULT_HELPER, helper)
}

/// A script string as Rust text, with each lone surrogate as U+FFFD.
pub(crate) fn lossy_text<'js>(ctx: &Ctx<'js>, text: &rquickjs::String<'js>) -> String {
    if let Ok(text) = text.to_string() {
        return text;
    }
    match Kit::of(ctx).and_then(|kit| kit.units_of(text)) {
        Ok(units) => String::from_utf16_lossy(&units),
        Err(_) => String::new(),
    }
}

/// A host value as the sandbox receives it: built natively, with every
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

/// [`host_to_js`] for a list of values, built as one sandbox array.
pub(crate) fn host_list_to_js<'js>(ctx: &Ctx<'js>, items: &[serde_json::Value]) -> Result<Array<'js>, String> {
    crate::retained::host_list_to_js(ctx, items).map_err(|error| match error {
        crate::retained::HostValueError::Marshal(message) => message,
        crate::retained::HostValueError::Callback(error) => error.to_string(),
    })
}

/// The elements [`host_list_to_js`] would build, as a list of sandbox values,
/// each built on its own with no array to read back.
pub(crate) fn host_args_to_js<'js>(ctx: &Ctx<'js>, items: &[serde_json::Value]) -> Result<Vec<Value<'js>>, String> {
    let scalar = |item: &serde_json::Value| !matches!(item, serde_json::Value::Array(_) | serde_json::Value::Object(_));
    if items.iter().all(scalar) {
        return items
            .iter()
            .map(|item| build(ctx, item, None).map_err(|_| "a scalar argument could not be built".to_string()))
            .collect();
    }
    items.iter().map(|item| host_to_js(ctx, item)).collect()
}

/// Builds `value` in the sandbox, decoding markers when the runtime has value
/// fidelity on. Callback markers stay plain data.
pub(crate) fn to_js<'js>(ctx: &Ctx<'js>, value: &serde_json::Value) -> rquickjs::Result<Value<'js>> {
    build(ctx, value, None).map_err(|error| match error {
        BuildError::Engine(error) => error,
        BuildError::Refused(message) => rquickjs::Error::new_from_js_message("value", "value", message),
        BuildError::Callback(error) => rquickjs::Error::new_from_js_message("value", "value", error.to_string()),
    })
}

/// Why a host value could not be built in the sandbox.
pub(crate) enum BuildError {
    Engine(rquickjs::Error),
    Refused(String),
    Callback(crate::callback::CallbackError),
}

impl From<rquickjs::Error> for BuildError {
    fn from(error: rquickjs::Error) -> Self {
        BuildError::Engine(error)
    }
}

/// Resolves a retained-callback token to its function: `Ok(None)` when the
/// token is not one this runtime issued, so the marker stays data.
pub(crate) type Revive<'a, 'js> =
    &'a dyn Fn(&str) -> Result<Option<Function<'js>>, crate::callback::CallbackError>;

enum Built<'a, 'js> {
    Done(Value<'js>),
    Open(Object<'js>, Children<'a>),
}

enum Children<'a> {
    Array(std::iter::Enumerate<std::slice::Iter<'a, serde_json::Value>>),
    Object(serde_json::map::Iter<'a>),
}

struct Building<'a, 'js> {
    target: Object<'js>,
    children: Children<'a>,
}

/// Builds `value` in the sandbox without recursing, reviving callback markers
/// through `revive` when given one.
pub(crate) fn build<'js>(
    ctx: &Ctx<'js>,
    value: &serde_json::Value,
    revive: Option<Revive<'_, 'js>>,
) -> Result<Value<'js>, BuildError> {
    match value {
        serde_json::Value::Null => return Ok(Value::new_null(ctx.clone())),
        serde_json::Value::Bool(b) => return Ok(Value::new_bool(ctx.clone(), *b)),
        serde_json::Value::Number(n) => return Ok(float_tagged(ctx, n.as_f64().unwrap_or(f64::NAN))),
        serde_json::Value::String(s) => return Ok(rquickjs::String::from_str(ctx.clone(), s)?.into_value()),
        _ => {}
    }
    let kit = Kit::of(ctx)?;
    let mut stack: Vec<Building<'_, 'js>> = Vec::new();
    let root = match build_node(ctx, &kit, value, &stack, revive)? {
        Built::Done(value) => return Ok(value),
        Built::Open(target, children) => {
            let root = target.clone().into_value();
            stack.push(Building { target, children });
            root
        }
    };
    fill(ctx, &kit, &mut stack, revive)?;
    Ok(root)
}

/// Builds `items` as one sandbox array, exactly as [`build`] builds a host
/// array holding them.
pub(crate) fn build_list<'js>(
    ctx: &Ctx<'js>,
    items: &[serde_json::Value],
    revive: Option<Revive<'_, 'js>>,
) -> Result<Array<'js>, BuildError> {
    let root = Array::new(ctx.clone())?;
    if items.is_empty() {
        return Ok(root);
    }
    let kit = Kit::of(ctx)?;
    let mut stack = vec![Building {
        target: root.clone().into_inner(),
        children: Children::Array(items.iter().enumerate()),
    }];
    fill(ctx, &kit, &mut stack, revive)?;
    Ok(root)
}

/// Builds every child still owed to the containers open on `stack`.
fn fill<'a, 'js>(
    ctx: &Ctx<'js>,
    kit: &Kit<'js>,
    stack: &mut Vec<Building<'a, 'js>>,
    revive: Option<Revive<'_, 'js>>,
) -> Result<(), BuildError> {
    while let Some(top) = stack.last_mut() {
        let next = match &mut top.children {
            Children::Array(items) => items.next().map(|(index, item)| (Slot::Index(index as u32), item)),
            Children::Object(entries) => entries.next().map(|(key, item)| (Slot::Key(key.as_str()), item)),
        };
        let Some((slot, item)) = next else {
            stack.pop();
            continue;
        };
        let target = top.target.clone();
        match build_node(ctx, kit, item, stack, revive)? {
            Built::Done(value) => slot.set(&target, value)?,
            Built::Open(child, children) => {
                if stack.len() >= MAX_DEPTH {
                    return Err(BuildError::Refused(too_deep()));
                }
                slot.set(&target, child.clone().into_value())?;
                stack.push(Building { target: child, children });
            }
        }
    }
    Ok(())
}

enum Slot<'a> {
    Index(u32),
    Key(&'a str),
}

impl Slot<'_> {
    fn set<'js>(&self, target: &Object<'js>, value: Value<'js>) -> rquickjs::Result<()> {
        match self {
            Slot::Index(index) => target.prop(*index, Property::from(value).writable().enumerable().configurable()),
            Slot::Key(key) => target.prop(*key, Property::from(value).writable().enumerable().configurable()),
        }
    }
}

fn build_node<'a, 'js>(
    ctx: &Ctx<'js>,
    kit: &Kit<'js>,
    value: &'a serde_json::Value,
    stack: &[Building<'a, 'js>],
    revive: Option<Revive<'_, 'js>>,
) -> Result<Built<'a, 'js>, BuildError> {
    Ok(match value {
        serde_json::Value::Null => Built::Done(Value::new_null(ctx.clone())),
        serde_json::Value::Bool(b) => Built::Done(Value::new_bool(ctx.clone(), *b)),
        serde_json::Value::Number(n) => Built::Done(float_tagged(ctx, n.as_f64().unwrap_or(f64::NAN))),
        serde_json::Value::String(s) => Built::Done(rquickjs::String::from_str(ctx.clone(), s)?.into_value()),
        serde_json::Value::Array(items) => {
            Built::Open(Array::new(ctx.clone())?.into_inner(), Children::Array(items.iter().enumerate()))
        }
        serde_json::Value::Object(map) => {
            if kit.fidelity
                && let Some(marker) = Marker::from_value(value)
                && let Some(built) = marker_to_js(ctx, kit, marker, stack)?
            {
                return Ok(Built::Done(built));
            }
            if let Some(token) = crate::retained::marker_token(value) {
                if let Some(function) = crate::callback::live_function(ctx, token) {
                    return Ok(Built::Done(function.into_value()));
                }
                if let Some(revive) = revive
                    && let Some(function) = revive(token).map_err(BuildError::Callback)?
                {
                    return Ok(Built::Done(function.into_value()));
                }
                return Ok(Built::Done(Value::new_undefined(ctx.clone())));
            }
            Built::Open(Object::new(ctx.clone())?, Children::Object(map.iter()))
        }
    })
}

fn marker_to_js<'js>(
    ctx: &Ctx<'js>,
    kit: &Kit<'js>,
    marker: Marker,
    stack: &[Building<'_, 'js>],
) -> rquickjs::Result<Option<Value<'js>>> {
    Ok(Some(match marker {
        Marker::Special(special) => match special.as_f64() {
            Some(number) => Value::new_float(ctx.clone(), number),
            None => Value::new_undefined(ctx.clone()),
        },
        Marker::BigInt(digits) => kit.make_bigint.call((digits,))?,
        Marker::Symbol(Some(description)) => kit.make_symbol.call((description,))?,
        Marker::Symbol(None) => kit.make_symbol.call(())?,
        Marker::Utf16(units) => utf16_to_js(ctx, &units)?,
        Marker::Cycle(up) => match stack.len().checked_sub(up) {
            Some(index) => stack[index].target.clone().into_value(),
            None => return Ok(None),
        },
    }))
}

fn utf16_to_js<'js>(ctx: &Ctx<'js>, units: &[u16]) -> rquickjs::Result<Value<'js>> {
    // SAFETY: the context is live, `units` outlives the call, and the
    // returned value is owned by the new `Value`.
    let value = unsafe {
        Value::from_raw(
            ctx.clone(),
            qjs::JS_NewTwoByteString(ctx.as_raw().as_ptr(), units.as_ptr(), units.len() as _),
        )
    };
    if value.is_exception() {
        return Err(rquickjs::Error::Exception);
    }
    Ok(value)
}

/// A host number as the sandbox receives it: always a double, never narrowed
/// to an int even when integral, which is what `JSON.parse` produces and so
/// what a host number has always arrived as.
fn float_tagged<'js>(ctx: &Ctx<'js>, number: f64) -> Value<'js> {
    // SAFETY: a float64 JSValue carries no reference count or pointer.
    unsafe { Value::from_raw(ctx.clone(), qjs::__JS_NewFloat64(number)) }
}

fn too_deep() -> String {
    format!("value is nested more than {MAX_DEPTH} levels deep")
}

/// Why a sandbox value could not be read out for the host.
pub(crate) enum CrossError<'js> {
    /// Script threw while the value was read (a getter, a proxy trap, the
    /// execution limit). The value is what it threw, already caught.
    Thrown(Value<'js>),
    /// The value has no crossing on this runtime.
    Refused(String),
}

/// Reads a sandbox value out for the host. A function or symbol at the top
/// level is `null`, as it is inside an array; inside an object it is omitted,
/// which is what JSON does. `undefined`, `NaN` and the infinities are `null`,
/// or markers when the runtime has them on; `-0` is a float, or its marker. A
/// value that cannot cross reads as `null`; [`try_to_json`] says why.
pub(crate) fn to_json<'js>(ctx: &Ctx<'js>, value: &Value<'js>) -> serde_json::Value {
    try_to_json(ctx, value).unwrap_or(serde_json::Value::Null)
}

/// [`to_json`], failing where a value cannot cross: a getter threw, or the
/// value is a cycle or a BigInt with value fidelity off, or is nested deeper
/// than [`MAX_DEPTH`].
pub(crate) fn try_to_json<'js>(ctx: &Ctx<'js>, value: &Value<'js>) -> Result<serde_json::Value, CrossError<'js>> {
    let kit = Kit::of(ctx).map_err(|e| CrossError::Refused(e.to_string()))?;
    let fidelity = kit.fidelity;
    let special = |special: Special| if fidelity { special.to_value() } else { serde_json::Value::Null };
    match value.type_of() {
        Type::Undefined | Type::Uninitialized => return Ok(special(Special::Undefined)),
        Type::Symbol if fidelity => {
            return Encoder::new(ctx, &kit).encode(value.clone(), Key::Root, true).map(Option::unwrap_or_default);
        }
        Type::Null | Type::Function | Type::Constructor | Type::Symbol => return Ok(serde_json::Value::Null),
        Type::Bool => return Ok(serde_json::Value::Bool(value.as_bool().unwrap_or_default())),
        Type::Int => return Ok(serde_json::Value::from(value.as_int().unwrap_or_default())),
        Type::Float => {
            let f = value.as_float().unwrap_or_default();
            return Ok(match Special::from_f64(f) {
                Some(Special::NegZero) if !fidelity => float_value(false, f),
                Some(found) => special(found),
                None => float_value(fidelity, f),
            });
        }
        Type::String => {
            let text = value.as_string().cloned().ok_or_else(|| CrossError::Refused("not a string".into()))?;
            return Encoder::new(ctx, &kit).string(&text);
        }
        _ => {}
    }
    let encoded = Encoder::new(ctx, &kit).encode(value.clone(), Key::Root, false)?;
    Ok(encoded.unwrap_or(serde_json::Value::Null))
}

/// [`try_to_json`] as `JSON.stringify` would read `value`, whatever the
/// runtime's value fidelity: what JSON cannot spell is `null` or left out.
pub(crate) fn try_to_plain_json<'js>(ctx: &Ctx<'js>, value: &Value<'js>) -> Result<serde_json::Value, CrossError<'js>> {
    let kit = Kit::of(ctx).map_err(|e| CrossError::Refused(e.to_string()))?;
    let mut encoder = Encoder::new(ctx, &kit);
    encoder.fidelity = false;
    Ok(encoder.encode(value.clone(), Key::Root, false)?.unwrap_or(serde_json::Value::Null))
}

/// Reads `value` out as it crosses when it is the property `key` of a plain
/// object `depth` containers below the crossing's root: `toJSON` receives
/// `key`, an integral double is an integer, and `None` is a value the holder
/// omits. This is how a value inside a runtime-built envelope (an export's
/// `{ __xript_ok }`, a hook's `{ modId, seq, value }`) reaches the host, read
/// without building the envelope.
pub(crate) fn try_field_to_json<'js>(
    ctx: &Ctx<'js>,
    value: &Value<'js>,
    key: &rquickjs::Atom<'js>,
    depth: usize,
) -> Result<Option<serde_json::Value>, CrossError<'js>> {
    let kit = Kit::of(ctx).map_err(|e| CrossError::Refused(e.to_string()))?;
    let mut encoder = Encoder::new(ctx, &kit);
    encoder.floor = depth;
    encoder.encode(value.clone(), Key::Name(key.clone()), false)
}

/// A binding's arguments, read out for the host. Each function anywhere in
/// them is pushed onto `functions` and becomes a callback marker holding
/// `token(index)`; a symbol at the top level crosses as its marker when value
/// fidelity is on.
pub(crate) fn args_to_json<'js>(
    ctx: &Ctx<'js>,
    args: &[Value<'js>],
    functions: &mut Vec<Function<'js>>,
    token: &dyn Fn(usize) -> String,
) -> Result<Vec<serde_json::Value>, CrossError<'js>> {
    let kit = Kit::of(ctx).map_err(|e| CrossError::Refused(e.to_string()))?;
    let mut encoder = Encoder::new(ctx, &kit);
    encoder.functions = Functions::Collect(functions, token);
    let mut out = Vec::with_capacity(args.len());
    for arg in args {
        let arg = arg.clone();
        out.push(encoder.encode(arg, Key::Root, true)?.unwrap_or(serde_json::Value::Null));
    }
    Ok(out)
}

/// A script value as a flat token tape for another runtime's script, as the
/// events bus carries it between pool workers: markers for every value JSON
/// cannot spell whatever the runtime's value fidelity, symbols at any depth,
/// and keys in their own order. A function cannot be called from another
/// worker, so it crosses as `undefined`.
///
/// The tape is a JSON array of tokens, never nested deeper than a marker:
/// `["a"]` and `["o"]` open an array or object, `["k", key]` names the next
/// entry of an object, `["v", leaf]` is a primitive or a marker, and `["e"]`
/// closes the innermost container. Neither side recurses over the value's
/// depth to write or read it. A getter that throws throws here; a value too
/// deep throws an `Error`.
pub(crate) fn crossing_tape<'js>(ctx: &Ctx<'js>, value: Value<'js>) -> rquickjs::Result<String> {
    let kit = Kit::of(ctx)?;
    let mut encoder = Encoder {
        ctx,
        kit: &kit,
        functions: Functions::Undefined,
        fidelity: true,
        symbols_anywhere: true,
        tape: Some(Vec::new()),
        floor: 0,
    };
    let leaf = match encoder.encode(value, Key::Root, true) {
        Ok(leaf) => leaf.unwrap_or(serde_json::Value::Null),
        Err(CrossError::Thrown(thrown)) => return Err(ctx.throw(thrown)),
        Err(CrossError::Refused(message)) => return Err(rquickjs::Exception::throw_message(ctx, &message)),
    };
    let mut tokens = encoder.tape.take().unwrap_or_default();
    if tokens.is_empty() {
        tokens.push(leaf_token(&leaf));
    }
    Ok(format!("[{}]", tokens.join(",")))
}

fn leaf_token(leaf: &serde_json::Value) -> String {
    format!("[\"v\",{}]", serde_json::to_string(leaf).unwrap_or_else(|_| "null".into()))
}

fn key_token(key: &str) -> String {
    format!("[\"k\",{}]", serde_json::to_string(key).unwrap_or_else(|_| "\"\"".into()))
}

/// A finite script number held as a double, as the host receives it at the
/// top level. With value fidelity on, an integral value is an integer, exactly
/// as the same number nested in an object or array arrives, so `10` reads the
/// same whichever path made it; otherwise it stays a float.
fn float_value(fidelity: bool, number: f64) -> serde_json::Value {
    if fidelity {
        return crate::value::special::number(number);
    }
    serde_json::Number::from_f64(number)
        .map(serde_json::Value::Number)
        .unwrap_or(serde_json::Value::Null)
}

/// A finite double nested in an object or array, as `JSON.stringify` writes it
/// and `serde_json` reads it back: an integral value below `1e21` is an
/// integer when it fits `u64` (or `i64` when negative), anything else a float.
fn nested_number(number: f64) -> serde_json::Value {
    if number.fract() == 0.0 && number.abs() < 1e21 {
        if (0.0..18_446_744_073_709_551_616.0).contains(&number) {
            return serde_json::Value::from(number as u64);
        }
        if (-9_223_372_036_854_775_808.0..0.0).contains(&number) {
            return serde_json::Value::from(number as i64);
        }
    }
    serde_json::Number::from_f64(number)
        .map(serde_json::Value::Number)
        .unwrap_or(serde_json::Value::Null)
}

/// Where a value sits in its holder, which `toJSON` receives as its argument.
enum Key<'js> {
    Root,
    Index(usize),
    Name(rquickjs::Atom<'js>),
}

enum Step<'js> {
    Done(serde_json::Value),
    Skip,
    Open(Frame<'js>),
}

struct Frame<'js> {
    source: Value<'js>,
    slot: Option<String>,
    body: Body<'js>,
}

enum Body<'js> {
    Array {
        array: Object<'js>,
        len: usize,
        next: usize,
        out: Vec<serde_json::Value>,
    },
    Object {
        object: Object<'js>,
        keys: std::vec::IntoIter<rquickjs::Atom<'js>>,
        out: serde_json::Map<String, serde_json::Value>,
    },
}

impl Drop for Frame<'_> {
    fn drop(&mut self) {
        crate::value::discard(self.take_out());
    }
}

impl<'js> Frame<'js> {
    fn take_out(&mut self) -> serde_json::Value {
        match &mut self.body {
            Body::Array { out, .. } => serde_json::Value::Array(std::mem::take(out)),
            Body::Object { out, .. } => serde_json::Value::Object(std::mem::take(out)),
        }
    }

    fn finish(mut self) -> serde_json::Value {
        self.take_out()
    }

    fn put(&mut self, slot: Option<String>, value: serde_json::Value) {
        match &mut self.body {
            Body::Array { out, .. } => out.push(value),
            Body::Object { out, .. } => {
                out.insert(slot.unwrap_or_default(), value);
            }
        }
    }
}

/// What a function in a crossing value becomes.
enum Functions<'a, 'js> {
    /// Nothing: omitted from an object, `null` in an array.
    Skip,
    /// A callback marker holding the token for the function's index in this
    /// list.
    Collect(&'a mut Vec<Function<'js>>, &'a dyn Fn(usize) -> String),
    /// `undefined`, as a function that cannot be called where it is going.
    Undefined,
}

struct Encoder<'a, 'js> {
    ctx: &'a Ctx<'js>,
    kit: &'a Kit<'js>,
    functions: Functions<'a, 'js>,
    fidelity: bool,
    symbols_anywhere: bool,
    /// Containers written as tape tokens (see [`crossing_tape`]) in their own
    /// key order, rather than built as `serde_json::Value`s.
    tape: Option<Vec<String>>,
    /// How many containers enclose the value being encoded, counted against
    /// [`MAX_DEPTH`] as if they were open on the stack.
    floor: usize,
}

impl<'a, 'js> Encoder<'a, 'js> {
    fn new(ctx: &'a Ctx<'js>, kit: &'a Kit<'js>) -> Self {
        Self { ctx, kit, functions: Functions::Skip, fidelity: kit.fidelity, symbols_anywhere: false, tape: None, floor: 0 }
    }

    fn engine(&self, error: rquickjs::Error) -> CrossError<'js> {
        match error {
            rquickjs::Error::Exception => CrossError::Thrown(self.ctx.catch()),
            other => CrossError::Refused(other.to_string()),
        }
    }

    /// Encodes one value. `None` is a value JSON skips (an `undefined` without
    /// value fidelity, a function with nowhere to put it, a symbol that is not
    /// a top-level argument), which a holder omits or writes as `null`.
    fn encode(&mut self, root: Value<'js>, key: Key<'js>, top_level: bool) -> Result<Option<serde_json::Value>, CrossError<'js>> {
        let mut stack: Vec<Frame<'js>> = Vec::new();
        match self.step(root, key, None, &stack, top_level)? {
            Step::Done(value) => return Ok(Some(value)),
            Step::Skip => return Ok(None),
            Step::Open(frame) => self.opened(&mut stack, frame),
        }
        loop {
            let top = stack.last_mut().expect("an open frame");
            let next = match &mut top.body {
                Body::Array { array, len, next, .. } => {
                    if *next < *len {
                        let index = *next;
                        *next += 1;
                        Some((array.get::<_, Value>(index as u32), Key::Index(index)))
                    } else {
                        None
                    }
                }
                Body::Object { object, keys, .. } => {
                    keys.next().map(|key| (object.get::<_, Value>(key.clone()), Key::Name(key)))
                }
            };
            let Some((child, key)) = next else {
                let frame = stack.pop().expect("an open frame");
                if let Some(tape) = self.tape.as_mut() {
                    tape.push("[\"e\"]".to_string());
                    if stack.is_empty() {
                        return Ok(Some(serde_json::Value::Null));
                    }
                    continue;
                }
                let slot = frame.slot.clone();
                let value = frame.finish();
                match stack.last_mut() {
                    Some(parent) => parent.put(slot, value),
                    None => return Ok(Some(value)),
                }
                continue;
            };
            let in_array = matches!(top.body, Body::Array { .. });
            let child = child.map_err(|e| self.engine(e))?;
            let slot = match &key {
                Key::Name(name) => Some(self.key_text(name)?),
                _ => None,
            };
            match self.step(child, key, slot.clone(), &stack, false)? {
                Step::Done(value) => self.deliver(&mut stack, slot, value),
                Step::Skip if in_array => self.deliver(&mut stack, None, serde_json::Value::Null),
                Step::Skip => {}
                Step::Open(frame) => self.opened(&mut stack, frame),
            }
        }
    }

    /// Puts a finished child into the open frame on top of `stack`.
    fn deliver(&mut self, stack: &mut [Frame<'js>], slot: Option<String>, value: serde_json::Value) {
        let top = stack.last_mut().expect("an open frame");
        match self.tape.as_mut() {
            Some(tape) => {
                if matches!(top.body, Body::Object { .. }) {
                    tape.push(key_token(slot.as_deref().unwrap_or_default()));
                }
                tape.push(leaf_token(&value));
            }
            None => top.put(slot, value),
        }
    }

    /// Opens a container frame, writing where it starts when writing a tape.
    fn opened(&mut self, stack: &mut Vec<Frame<'js>>, frame: Frame<'js>) {
        if let Some(tape) = self.tape.as_mut() {
            if stack.last().is_some_and(|top| matches!(top.body, Body::Object { .. })) {
                tape.push(key_token(frame.slot.as_deref().unwrap_or_default()));
            }
            tape.push(if matches!(frame.body, Body::Array { .. }) { "[\"a\"]" } else { "[\"o\"]" }.to_string());
        }
        stack.push(frame);
    }

    fn step(
        &mut self,
        value: Value<'js>,
        key: Key<'js>,
        slot: Option<String>,
        stack: &[Frame<'js>],
        top_level: bool,
    ) -> Result<Step<'js>, CrossError<'js>> {
        let mut value = value;
        if value.is_object() || value.is_big_int() {
            value = self.apply_to_json(value, &key)?;
        }
        if value.is_object() && !value.is_function() {
            value = self.kit.unwrap_primitive(value).map_err(|e| self.engine(e))?;
        }
        let fidelity = self.fidelity;
        let kind = match (value.is_object(), value.is_function()) {
            (true, true) => Type::Function,
            (true, false) => Type::Object,
            (false, _) => value.type_of(),
        };
        Ok(match kind {
            Type::Undefined | Type::Uninitialized => match fidelity {
                true => Step::Done(Special::Undefined.to_value()),
                false => Step::Skip,
            },
            Type::Null => Step::Done(serde_json::Value::Null),
            Type::Bool => Step::Done(serde_json::Value::Bool(value.as_bool().unwrap_or_default())),
            Type::Int => Step::Done(serde_json::Value::from(value.as_int().unwrap_or_default())),
            Type::Float => {
                let f = value.as_float().unwrap_or_default();
                Step::Done(match Special::from_f64(f) {
                    Some(special) if fidelity => special.to_value(),
                    Some(Special::NegZero) => serde_json::Value::from(0u64),
                    Some(_) => serde_json::Value::Null,
                    None => nested_number(f),
                })
            }
            Type::String => {
                let text = value.as_string().cloned().ok_or_else(|| CrossError::Refused("not a string".into()))?;
                Step::Done(self.string(&text)?)
            }
            Type::Symbol if (top_level || self.symbols_anywhere) && fidelity => {
                let description = value
                    .as_symbol()
                    .map(|symbol| symbol.description())
                    .transpose()
                    .map_err(|e| self.engine(e))?
                    .and_then(|d| d.as_string().cloned());
                let description = match description {
                    Some(text) => Some(match self.kit.read_string(&text).map_err(|e| self.engine(e))? {
                        Ok(text) => text,
                        Err(units) => String::from_utf16_lossy(&units),
                    }),
                    None => None,
                };
                Step::Done(Marker::Symbol(description).to_value())
            }
            Type::Symbol => Step::Skip,
            Type::BigInt if fidelity => {
                let digits: String = self.kit.bigint_digits.call((This(value),)).map_err(|e| self.engine(e))?;
                Step::Done(Marker::BigInt(digits).to_value())
            }
            Type::BigInt => {
                return Err(CrossError::Refused(
                    "cannot pass a BigInt; a runtime built with value fidelity on carries it as a marker".into(),
                ))
            }
            Type::Function | Type::Constructor => match &mut self.functions {
                Functions::Collect(functions, token) => {
                    let index = functions.len();
                    functions.push(value.into_function().expect("a function value"));
                    let mut marker = serde_json::Map::with_capacity(1);
                    marker.insert(crate::callback::CALLBACK_MARKER.to_string(), serde_json::Value::String(token(index)));
                    Step::Done(serde_json::Value::Object(marker))
                }
                Functions::Undefined => Step::Done(Special::Undefined.to_value()),
                Functions::Skip => Step::Skip,
            },
            Type::Module | Type::Unknown => Step::Skip,
            _ => {
                if let Some(index) = stack.iter().rposition(|frame| frame.source == value) {
                    if !fidelity {
                        return Err(CrossError::Refused(
                            "cannot pass a cyclic value; a runtime built with value fidelity on carries it with cycle markers".into(),
                        ));
                    }
                    return Ok(Step::Done(Marker::Cycle(stack.len() - index).to_value()));
                }
                if stack.len() + self.floor >= MAX_DEPTH {
                    return Err(CrossError::Refused(too_deep()));
                }
                Step::Open(self.open(value, slot)?)
            }
        })
    }

    fn open(&self, value: Value<'js>, slot: Option<String>) -> Result<Frame<'js>, CrossError<'js>> {
        let object = value.as_object().cloned().ok_or_else(|| CrossError::Refused("not an object".into()))?;
        // SAFETY: `value` is a live value owned by this context.
        let proxy = unsafe { qjs::JS_IsProxy(value.as_raw()) };
        let is_array = match proxy {
            true => self.kit.is_array.call::<_, bool>((value.clone(),)).map_err(|e| self.engine(e))?,
            false => value.is_array(),
        };
        let body = if is_array {
            let len = match value.as_array() {
                Some(array) if !proxy => array.len(),
                _ => {
                    let length: f64 = object.get("length").map_err(|e| self.engine(e))?;
                    if length.is_finite() && length > 0.0 { length as usize } else { 0 }
                }
            };
            Body::Array { array: object, len, next: 0, out: Vec::with_capacity(len.min(1024)) }
        } else {
            let keys = object
                .keys::<rquickjs::Atom>()
                .collect::<rquickjs::Result<Vec<_>>>()
                .map_err(|e| self.engine(e))?;
            Body::Object { object, keys: keys.into_iter(), out: serde_json::Map::new() }
        };
        Ok(Frame { source: value, slot, body })
    }

    /// `toJSON`, as `JSON.stringify` applies it, except that one which throws
    /// is skipped and the value crosses by its own properties. A throw the
    /// script cannot catch (the execution limit) still ends the crossing.
    fn apply_to_json(&self, value: Value<'js>, key: &Key<'js>) -> Result<Value<'js>, CrossError<'js>> {
        let to_json: Value = match value.as_object() {
            Some(object) => object.get(self.kit.to_json_key.clone()),
            None => self.kit.to_json_of.call((value.clone(),)),
        }
        .map_err(|e| self.engine(e))?;
        let Some(to_json) = to_json.as_function() else {
            return Ok(value);
        };
        let key = match key {
            Key::Root => rquickjs::String::from_str(self.ctx.clone(), ""),
            Key::Index(index) => rquickjs::String::from_str(self.ctx.clone(), &index.to_string()),
            Key::Name(name) => name.to_js_string(),
        }
        .map_err(|e| self.engine(e))?;
        match to_json.call::<_, Value>((This(value.clone()), key)) {
            Ok(result) => Ok(result),
            Err(rquickjs::Error::Exception) => {
                let thrown = self.ctx.catch();
                // SAFETY: `thrown` is a live value owned by this context.
                if unsafe { qjs::JS_IsUncatchableError(thrown.as_raw()) } {
                    return Err(CrossError::Thrown(thrown));
                }
                Ok(value)
            }
            Err(other) => Err(CrossError::Refused(other.to_string())),
        }
    }

    fn string(&self, text: &rquickjs::String<'js>) -> Result<serde_json::Value, CrossError<'js>> {
        Ok(match self.kit.read_string(text).map_err(|e| self.engine(e))? {
            Ok(text) => serde_json::Value::String(text),
            Err(units) if self.fidelity => Marker::Utf16(units).to_value(),
            Err(units) => serde_json::Value::String(String::from_utf16_lossy(&units)),
        })
    }

    /// A key as text, read through a JS string: an atom's own text conversion
    /// stops at a NUL and reads a lone surrogate as three U+FFFD.
    fn key_text(&self, key: &rquickjs::Atom<'js>) -> Result<String, CrossError<'js>> {
        let text = key.to_js_string().map_err(|e| self.engine(e))?;
        Ok(match self.kit.read_string(&text).map_err(|e| self.engine(e))? {
            Ok(text) => text,
            Err(units) => String::from_utf16_lossy(&units),
        })
    }
}
