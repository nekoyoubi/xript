//! The host-to-script entry points, driven natively in either runtime mode.
//!
//! Invoking an export, firing a hook and emitting an event run as native calls
//! against the context, with nothing parsed per call and no host-supplied name
//! spliced into source. The export or handler list is read from its registry
//! on the host-held internals object on every call, the arguments are built
//! straight into the sandbox, and each result is read out as the field of
//! the envelope a script-side dispatch would wrap it in (`{ __xript_ok }`, `{ modId, seq, value }`,
//! `{ owner, value }`), which is what the host has always received.
//!
//! Where a script-side `await` would be observable (an export returning a
//! promise or a thenable, or leaving promise jobs queued behind its result)
//! the call goes through `async` sandbox helpers compiled once at
//! construction, and the promise they return settles the way any call's
//! completion value does: polled to completion on a sync runtime, awaited
//! under the call's budget on an async one. Everything else completes on its
//! first poll.

use rquickjs::function::{Rest, This};
use rquickjs::{qjs, Array, Atom, Ctx, Function, IntoAtom, JsLifetime, Object, Value};

use crate::error::{Result, XriptError};
use crate::sandbox::{drain_jobs, export_outcome, CallFlags, HookArgs, OrderedResult, TaggedResult};

const SOURCE: &str = r#"(function (resultOf) {
    var reflectApply = Reflect.apply;
    var toText = String;
    function message(e) {
        return (e && e.message) ? e.message : toText(e);
    }
    async function settle(pending) {
        try {
            return { __xript_ok: resultOf(await pending) };
        } catch (e) {
            return { __xript_err: message(e) };
        }
    }
    function adopt(value, then) {
        return settle({ then: function (resolve, reject) { return reflectApply(then, value, [resolve, reject]); } });
    }
    async function settleLater(value) {
        await undefined;
        return { __xript_ok: resultOf(value) };
    }
    return [message, settle, adopt, settleLater];
})"#;

/// The property names a dispatch reads on every call, interned once.
#[derive(Clone)]
struct Names<'js> {
    ok: Atom<'js>,
    err: Atom<'js>,
    exports: Atom<'js>,
    then: Atom<'js>,
    length: Atom<'js>,
    phase: Atom<'js>,
    handler: Atom<'js>,
    mod_id: Atom<'js>,
    seq: Atom<'js>,
    bus: Atom<'js>,
    api: Atom<'js>,
    emit: Atom<'js>,
    #[cfg(feature = "threads")]
    stepped: SteppedNames<'js>,
    owner: Atom<'js>,
    value: Atom<'js>,
}

/// The bus methods a stepped emit calls.
#[cfg(feature = "threads")]
#[derive(Clone)]
struct SteppedNames<'js> {
    begin: Atom<'js>,
    step: Atom<'js>,
    resume: Atom<'js>,
    finish: Atom<'js>,
}

impl<'js> Names<'js> {
    fn intern(ctx: &Ctx<'js>) -> rquickjs::Result<Self> {
        let atom = |name: &str| Atom::from_str(ctx.clone(), name);
        Ok(Names {
            ok: atom("__xript_ok")?,
            err: atom("__xript_err")?,
            exports: atom("exports")?,
            then: atom("then")?,
            length: atom("length")?,
            phase: atom("phase")?,
            handler: atom("handler")?,
            mod_id: atom("modId")?,
            seq: atom("seq")?,
            bus: atom("bus")?,
            api: atom("api")?,
            emit: atom("emit")?,
            #[cfg(feature = "threads")]
            stepped: SteppedNames {
                begin: atom("begin")?,
                step: atom("step")?,
                resume: atom("resume")?,
                finish: atom("finish")?,
            },
            owner: atom("owner")?,
            value: atom("value")?,
        })
    }
}

/// The compiled helpers, kept in the context's userdata.
#[derive(Clone)]
pub(crate) struct Dispatch<'js> {
    result_of: Function<'js>,
    message: Function<'js>,
    settle: Function<'js>,
    adopt: Function<'js>,
    settle_later: Function<'js>,
    names: Names<'js>,
    internals: Object<'js>,
}

unsafe impl<'js> JsLifetime<'js> for Dispatch<'js> {
    type Changed<'to> = Dispatch<'to>;
}

impl<'js> Dispatch<'js> {
    /// Compiles the helpers. Runs at construction, after the result helper is
    /// installed and before any mod code runs.
    pub(crate) fn install(ctx: &Ctx<'js>) -> rquickjs::Result<()> {
        let result_of: Function = crate::internals::get(ctx, crate::marshal::RESULT_HELPER)?;
        let factory: Function = ctx.eval(SOURCE)?;
        let parts: Array = factory.call((result_of.clone(),))?;
        let dispatch = Dispatch {
            result_of,
            message: parts.get(0)?,
            settle: parts.get(1)?,
            adopt: parts.get(2)?,
            settle_later: parts.get(3)?,
            names: Names::intern(ctx)?,
            internals: crate::internals::of(ctx)?,
        };
        let _ = ctx.store_userdata(dispatch);
        Ok(())
    }

    fn of<'a>(ctx: &'a Ctx<'js>) -> Result<rquickjs::runtime::UserDataGuard<'a, Dispatch<'js>>> {
        ctx.userdata::<Dispatch<'js>>()
            .ok_or_else(|| XriptError::Engine("the dispatch helpers are not installed".into()))
    }

    /// What a dispatch loop collects for a handler's result: a symbol becomes
    /// its marker object when value fidelity is on, anything else passes.
    fn result(&self, value: Value<'js>) -> rquickjs::Result<Value<'js>> {
        if value.is_symbol() {
            self.result_of.call((value,))
        } else {
            Ok(value)
        }
    }
}

fn engine(error: rquickjs::Error) -> XriptError {
    XriptError::Engine(error.to_string())
}

/// JavaScript truthiness.
fn truthy(ctx: &Ctx<'_>, value: &Value<'_>) -> bool {
    // SAFETY: both the context and the value are live for the call, and
    // `JS_ToBool` neither consumes the value nor runs script.
    unsafe { qjs::JS_ToBool(ctx.as_raw().as_ptr(), value.as_raw()) == 1 }
}

fn jobs_pending(ctx: &Ctx<'_>) -> bool {
    // SAFETY: the context is live, and so is the runtime it belongs to.
    unsafe { qjs::JS_IsJobPending(qjs::JS_GetRuntime(ctx.as_raw().as_ptr())) }
}

fn uncatchable(value: &Value<'_>) -> bool {
    // SAFETY: `value` is a live value owned by its context.
    unsafe { qjs::JS_IsUncatchableError(value.as_raw()) }
}

/// `holder[key]` for an object holder, `undefined` for anything else.
fn field<'js, K: IntoAtom<'js>>(ctx: &Ctx<'js>, holder: &Value<'js>, key: K) -> rquickjs::Result<Value<'js>> {
    match holder.as_object() {
        Some(object) => object.get(key),
        None => Ok(Value::new_undefined(ctx.clone())),
    }
}

/// The function `name` resolves to: in `owner`'s bucket of the export
/// registry when an owner is named, else in the one bucket that holds it.
fn lookup_export<'js>(
    ctx: &Ctx<'js>,
    internals: &Object<'js>,
    names: &Names<'js>,
    name: &str,
    owner: Option<&str>,
) -> rquickjs::Result<Option<Function<'js>>> {
    let registry: Value = internals.get(names.exports.clone())?;
    let found = match owner {
        Some(owner) => {
            let bucket = field(ctx, &registry, owner)?;
            if truthy(ctx, &bucket) {
                field(ctx, &bucket, name)?
            } else {
                Value::new_undefined(ctx.clone())
            }
        }
        None => {
            let Some(registry) = registry.as_object() else {
                return Ok(None);
            };
            let mut found = None;
            let mut owners = 0;
            for key in registry.keys::<rquickjs::Atom>() {
                let bucket: Value = registry.get(key?)?;
                let candidate = field(ctx, &bucket, name)?;
                if candidate.is_function() {
                    owners += 1;
                    found = Some(candidate);
                }
            }
            match found {
                Some(candidate) if owners == 1 => candidate,
                _ => return Ok(None),
            }
        }
    };
    Ok(found.into_function())
}

/// Invokes an export on a sync runtime, as an async-mode runtime's source does:
///
/// ```js
/// var fn = lookupExport(name, owner);
/// if (typeof fn !== 'function') return { __xript_err: "export " + name + " not found" };
/// try {
///     return { __xript_ok: result(await fn.apply(null, args)) };
/// } catch (e) {
///     return { __xript_err: (e && e.message) ? e.message : String(e) };
/// }
/// ```
pub(crate) async fn invoke_export<'js>(
    ctx: &Ctx<'js>,
    flags: &CallFlags,
    name: &str,
    owner: Option<&str>,
    args: &[serde_json::Value],
) -> Result<serde_json::Value> {
    let dispatch = Dispatch::of(ctx)?;
    let function = match lookup_export(ctx, &dispatch.internals, &dispatch.names, name, owner) {
        Ok(Some(function)) => function,
        Ok(None) => {
            drain_jobs(ctx);
            return Err(XriptError::Invoke {
                export: name.to_string(),
                message: format!("export {name} not found"),
            });
        }
        Err(_) => return Err(after_throw(ctx, flags)),
    };
    let list = match crate::marshal::host_args_to_js(ctx, args) {
        Ok(list) => list,
        Err(message) => {
            drain_jobs(ctx);
            return Err(XriptError::Invoke {
                export: name.to_string(),
                message,
            });
        }
    };
    let returned = match function.call::<_, Value>((This(Value::new_null(ctx.clone())), Rest(list))) {
        Ok(returned) => returned,
        Err(rquickjs::Error::Exception) => return failed(ctx, flags, &dispatch, name, ctx.catch()),
        Err(other) => return Err(engine(other)),
    };

    if let Some(object) = returned.as_object() {
        if returned.is_promise() {
            let pending = dispatch.settle.call::<_, Value>((returned,)).map_err(engine)?;
            return export_outcome(name, flags.settle(ctx, pending).await?);
        }
        let then = match object.get::<_, Value>(dispatch.names.then.clone()) {
            Ok(then) => then,
            Err(rquickjs::Error::Exception) => return failed(ctx, flags, &dispatch, name, ctx.catch()),
            Err(other) => return Err(engine(other)),
        };
        if let Some(then) = then.into_function() {
            let pending = dispatch.adopt.call::<_, Value>((returned, then)).map_err(engine)?;
            return export_outcome(name, flags.settle(ctx, pending).await?);
        }
    }

    if jobs_pending(ctx) {
        let pending = dispatch.settle_later.call::<_, Value>((returned,)).map_err(engine)?;
        return export_outcome(name, flags.settle(ctx, pending).await?);
    }
    let value = dispatch.result(returned).map_err(|_| flags.thrown(ctx))?;
    match crate::marshal::try_field_to_json(ctx, &value, &dispatch.names.ok, 1) {
        Ok(json) => Ok(json.unwrap_or(serde_json::Value::Null)),
        Err(error) => Err(flags.unread(ctx, error)),
    }
}

/// The error for a throw pending on `ctx` outside the export's own `try`: a
/// deadline or cancellation as such, anything else after the queued jobs run.
fn after_throw(ctx: &Ctx<'_>, flags: &CallFlags) -> XriptError {
    let caught = ctx.catch();
    if uncatchable(&caught) {
        return flags.caught(ctx, &caught);
    }
    drain_jobs(ctx);
    flags.caught(ctx, &caught)
}

/// An export that threw `caught`: its `catch` block's envelope.
fn failed<'js>(
    ctx: &Ctx<'js>,
    flags: &CallFlags,
    dispatch: &Dispatch<'js>,
    name: &str,
    caught: Value<'js>,
) -> Result<serde_json::Value> {
    if uncatchable(&caught) {
        return Err(flags.caught(ctx, &caught));
    }
    let message = match dispatch.message.call::<_, Value>((caught,)) {
        Ok(message) => message,
        Err(_) => return Err(after_throw(ctx, flags)),
    };
    drain_jobs(ctx);
    match crate::marshal::try_field_to_json(ctx, &message, &dispatch.names.err, 1) {
        Ok(Some(serde_json::Value::String(message))) => Err(XriptError::Invoke {
            export: name.to_string(),
            message,
        }),
        Ok(other) => {
            other.into_iter().for_each(crate::value::discard);
            Ok(serde_json::Value::Null)
        }
        Err(error) => Err(flags.unread(ctx, error)),
    }
}

/// The arguments every handler of a fire receives, spread from its payload as
/// the dispatch loop spreads it: a payload of one plain object, or a `data`
/// plain object, passes that object's values in key order.
fn spread_args<'js>(ctx: &Ctx<'js>, args: &HookArgs) -> std::result::Result<Vec<Value<'js>>, String> {
    let plain = |value: &Value<'js>| value.as_object().filter(|_| !value.is_function() && !value.is_array()).cloned();
    let values_of = |object: Object<'js>| -> std::result::Result<Vec<Value<'js>>, String> {
        object
            .values::<Value>()
            .collect::<rquickjs::Result<Vec<_>>>()
            .map_err(|e| e.to_string())
    };
    match args {
        HookArgs::Payload(payload) => {
            let items = crate::marshal::host_args_to_js(ctx, payload)?;
            if items.len() == 1
                && let Some(object) = plain(&items[0])
            {
                return values_of(object);
            }
            Ok(items)
        }
        HookArgs::Data(None) => Ok(Vec::new()),
        HookArgs::Data(Some(data)) => {
            let raw = crate::marshal::host_to_js(ctx, data)?;
            match plain(&raw) {
                Some(object) => values_of(object),
                None if raw.is_undefined() => Ok(Vec::new()),
                None => Ok(vec![raw]),
            }
        }
    }
}

/// One handler's result, held in the sandbox until every handler has run.
struct Collected<'js> {
    mod_id: Value<'js>,
    seq: Value<'js>,
    value: Value<'js>,
}

/// Runs every handler `internals[registry][id]` holds (only those of
/// `phase`, when given) in registration order, each as the mod that
/// registered it, and returns their results. Mirrors an async-mode runtime's
/// dispatch loop: a handler that throws yields `undefined`, and a handler
/// registered during the fire runs in it.
pub(crate) async fn fire_hooks<'js>(
    ctx: &Ctx<'js>,
    flags: &CallFlags,
    caller: &crate::caller_context::CallerContext,
    registry: &str,
    id: &str,
    phase: Option<&str>,
    args: &HookArgs,
) -> Result<Vec<OrderedResult>> {
    let dispatch = Dispatch::of(ctx)?;
    let spread = spread_args(ctx, args).map_err(XriptError::Script)?;
    let thrown = |_| flags.thrown(ctx);
    let holder: Value = dispatch.internals.get(registry).map_err(thrown)?;
    let entries = if truthy(ctx, &holder) {
        field(ctx, &holder, id).map_err(thrown)?
    } else {
        Value::new_undefined(ctx.clone())
    };
    let entries = entries.into_object();
    let names = &dispatch.names;

    let mut collected: Vec<Collected<'js>> = Vec::new();
    let mut index = 0usize;
    while let Some(ref list) = entries {
        let length = list.get::<_, Value>(names.length.clone()).map_err(thrown)?.as_number().unwrap_or(0.0);
        if length.is_nan() || index as f64 >= length {
            break;
        }
        let entry: Value = list.get(index as u32).map_err(thrown)?;
        index += 1;
        let present = truthy(ctx, &entry);
        if let Some(phase) = phase {
            let matches = present
                && field(ctx, &entry, names.phase.clone())
                    .map_err(thrown)?
                    .as_string()
                    .and_then(|text| text.to_string().ok())
                    .is_some_and(|text| text == phase);
            if !matches {
                continue;
            }
        }
        let handler = if present {
            let handler = field(ctx, &entry, names.handler.clone()).map_err(thrown)?;
            if truthy(ctx, &handler) { handler } else { entry.clone() }
        } else {
            entry.clone()
        };
        let mod_id = if present { field(ctx, &entry, names.mod_id.clone()).map_err(thrown)? } else { entry.clone() };
        let mod_id = if truthy(ctx, &mod_id) {
            mod_id
        } else {
            rquickjs::String::from_str(ctx.clone(), "").map_err(engine)?.into_value()
        };
        let seq = match present {
            true => Some(field(ctx, &entry, names.seq.clone()).map_err(thrown)?).filter(Value::is_number),
            false => None,
        }
        .unwrap_or_else(|| Value::new_int(ctx.clone(), (index - 1) as i32));
        let value = call_as(ctx, flags, caller, &dispatch, &mod_id, handler, &spread)?;
        collected.push(Collected { mod_id, seq, value });
    }

    drain_jobs(ctx);
    let mut counters: Vec<(String, u32)> = Vec::new();
    let mut out = Vec::with_capacity(collected.len());
    for Collected { mod_id, seq, value } in collected {
        let read = |value: &Value<'js>, key: &Atom<'js>| {
            crate::marshal::try_field_to_json(ctx, value, key, 2).map_err(|error| flags.unread(ctx, error))
        };
        let mod_id = match read(&mod_id, &names.mod_id)? {
            Some(serde_json::Value::String(text)) => text,
            _ => String::new(),
        };
        let seq = read(&seq, &names.seq)?.and_then(|seq| seq.as_u64());
        let value = read(&value, &names.value)?.unwrap_or(serde_json::Value::Null);
        let index = next_index(&mut counters, &mod_id);
        out.push(OrderedResult {
            seq,
            tagged: TaggedResult { mod_id, index, value },
        });
    }
    Ok(out)
}

/// The position of the next result `mod_id` contributes, counting from zero.
fn next_index(counters: &mut Vec<(String, u32)>, mod_id: &str) -> u32 {
    match counters.iter_mut().find(|(id, _)| id == mod_id) {
        Some((_, count)) => {
            *count += 1;
            *count - 1
        }
        None => {
            counters.push((mod_id.to_string(), 1));
            0
        }
    }
}

/// Calls one handler as the mod that registered it, with the dispatch
/// loop's `try`: a handler that throws, or a mod id
/// or handler of the wrong type, yields `undefined`.
fn call_as<'js>(
    ctx: &Ctx<'js>,
    flags: &CallFlags,
    caller: &crate::caller_context::CallerContext,
    dispatch: &Dispatch<'js>,
    mod_id: &Value<'js>,
    handler: Value<'js>,
    spread: &[Value<'js>],
) -> Result<Value<'js>> {
    let undefined = || Value::new_undefined(ctx.clone());
    let (Some(mod_id), Some(handler)) = (mod_id.as_string(), handler.into_function()) else {
        return Ok(undefined());
    };
    let Ok(mod_id) = mod_id.to_string() else {
        return Ok(undefined());
    };
    let outcome = {
        let _caller = caller.enter((!mod_id.is_empty()).then_some(mod_id));
        handler.call::<_, Value>((This(Value::new_null(ctx.clone())), Rest(spread.to_vec())))
    };
    let returned = match outcome {
        Ok(returned) => returned,
        Err(rquickjs::Error::Exception) => {
            let caught = ctx.catch();
            if uncatchable(&caught) {
                return Err(flags.caught(ctx, &caught));
            }
            return Ok(undefined());
        }
        Err(_) => return Ok(undefined()),
    };
    match dispatch.result(returned) {
        Ok(value) => Ok(value),
        Err(_) => {
            let caught = ctx.catch();
            if uncatchable(&caught) {
                return Err(flags.caught(ctx, &caught));
            }
            Ok(undefined())
        }
    }
}

/// `internals.bus.api[method]`, with the `api` object it is called on.
fn bus_method<'js>(ctx: &Ctx<'js>, flags: &CallFlags, method: &Atom<'js>) -> Result<(Value<'js>, Function<'js>)> {
    let dispatch = Dispatch::of(ctx)?;
    let names = &dispatch.names;
    let thrown = |_| flags.thrown(ctx);
    let bus: Value = dispatch.internals.get(names.bus.clone()).map_err(thrown)?;
    let api = field(ctx, &bus, names.api.clone()).map_err(thrown)?;
    let function = field(ctx, &api, method.clone())
        .map_err(thrown)?
        .into_function()
        .ok_or_else(|| XriptError::Script("TypeError: not a function".into()))?;
    Ok((api, function))
}

/// Each subscriber's result from a bus delivery's `[{ owner, value }]`,
/// tagged by its mod, as `.map(function (r) { return { owner: r.owner, value:
/// result(r.value) }; })` hands them over. A `value` the crossing
/// omits reads as `missing`.
fn bus_results<'js>(
    ctx: &Ctx<'js>,
    flags: &CallFlags,
    delivered: Value<'js>,
    missing: &serde_json::Value,
) -> Result<Vec<TaggedResult>> {
    let dispatch = Dispatch::of(ctx)?;
    let names = &dispatch.names;
    let thrown = |_| flags.thrown(ctx);
    let delivered = delivered
        .into_array()
        .ok_or_else(|| XriptError::Script("TypeError: not an array".into()))?;
    let mut collected: Vec<(Value<'js>, Value<'js>)> = Vec::with_capacity(delivered.len());
    for entry in delivered.iter::<Value>() {
        let entry = entry.map_err(thrown)?;
        let owner = field(ctx, &entry, names.owner.clone()).map_err(thrown)?;
        let value = field(ctx, &entry, names.value.clone()).map_err(thrown)?;
        let value = dispatch.result(value).map_err(thrown)?;
        collected.push((owner, value));
    }

    drain_jobs(ctx);
    let mut counters: Vec<(String, u32)> = Vec::new();
    let mut out = Vec::with_capacity(collected.len());
    for (owner, value) in collected {
        let read = |value: &Value<'js>, key: &Atom<'js>| {
            crate::marshal::try_field_to_json(ctx, value, key, 2).map_err(|error| flags.unread(ctx, error))
        };
        let mod_id = match read(&owner, &names.owner)? {
            Some(serde_json::Value::String(text)) => text,
            _ => String::new(),
        };
        let value = read(&value, &names.value)?.unwrap_or_else(|| missing.clone());
        let index = next_index(&mut counters, &mod_id);
        out.push(TaggedResult { mod_id, index, value });
    }
    Ok(out)
}

/// Emits `event` on the bus as the host and returns each subscriber's result
/// tagged by its mod: `internals.bus.api.emit(token, event, args)`, its results
/// read out as [`bus_results`] reads them.
pub(crate) async fn emit<'js>(
    ctx: &Ctx<'js>,
    flags: &CallFlags,
    token: &str,
    event: &str,
    payload: &[serde_json::Value],
) -> Result<Vec<TaggedResult>> {
    let emit = Dispatch::of(ctx)?.names.emit.clone();
    let (api, deliver) = bus_method(ctx, flags, &emit)?;
    let args = crate::marshal::host_list_to_js(ctx, payload).map_err(XriptError::Script)?;
    let delivered: Value = deliver
        .call((This(api), token, event, args))
        .map_err(|_| flags.thrown(ctx))?;
    bus_results(ctx, flags, delivered, &serde_json::Value::Null)
}

/// One step of a host emit walked a delivery at a time, on a runtime whose
/// bus other workers share.
#[cfg(feature = "threads")]
pub(crate) enum BusStep<'a> {
    /// `begin(token, event, args)`: the session id, or `-1` for no delivery.
    Begin { event: &'a str, payload: &'a [serde_json::Value] },
    /// `step(token, session)`: the next step, as JSON text.
    Step { session: i64 },
    /// `resume(token, session, outcome)`, with another worker's answer.
    Resume { session: i64, outcome: &'a str },
}

/// Runs one [`BusStep`] and reads its result out as a script's result is.
#[cfg(feature = "threads")]
pub(crate) async fn bus_step<'js>(
    ctx: &Ctx<'js>,
    flags: &CallFlags,
    token: &str,
    step: BusStep<'_>,
) -> Result<serde_json::Value> {
    let names = Dispatch::of(ctx)?.names.stepped.clone();
    let thrown = |_| flags.thrown(ctx);
    let returned: Value = match step {
        BusStep::Begin { event, payload } => {
            let (api, begin) = bus_method(ctx, flags, &names.begin)?;
            let args = crate::marshal::host_list_to_js(ctx, payload).map_err(XriptError::Script)?;
            begin.call((This(api), token, event, args)).map_err(thrown)?
        }
        BusStep::Step { session } => {
            let (api, step) = bus_method(ctx, flags, &names.step)?;
            step.call((This(api), token, session as f64)).map_err(thrown)?
        }
        BusStep::Resume { session, outcome } => {
            let (api, resume) = bus_method(ctx, flags, &names.resume)?;
            resume.call((This(api), token, session as f64, outcome)).map_err(thrown)?
        }
    };
    flags.settle(ctx, returned).await
}

/// Finishes a stepped emit: `finish(token, session)`, its results read out as
/// [`bus_results`] reads them.
#[cfg(feature = "threads")]
pub(crate) async fn bus_finish<'js>(
    ctx: &Ctx<'js>,
    flags: &CallFlags,
    token: &str,
    session: i64,
    missing: &serde_json::Value,
) -> Result<Vec<TaggedResult>> {
    let finish = Dispatch::of(ctx)?.names.stepped.finish.clone();
    let (api, finish) = bus_method(ctx, flags, &finish)?;
    let delivered: Value = finish
        .call((This(api), token, session as f64))
        .map_err(|_| flags.thrown(ctx))?;
    bus_results(ctx, flags, delivered, missing)
}

/// Evaluates `code` as a script and settles its completion value. On an
/// async-mode runtime the jobs a throwing script queued still run before the
/// call ends.
pub(crate) async fn evaluate<'js>(ctx: &Ctx<'js>, flags: &CallFlags, code: &str) -> Result<serde_json::Value> {
    match ctx.eval::<Value, _>(code) {
        Ok(value) => flags.settle(ctx, value).await,
        Err(_) => {
            if flags.yielding() {
                drain_jobs(ctx);
            }
            Err(flags.thrown(ctx))
        }
    }
}

/// Drives a dispatch future on a sync runtime, where it never waits on
/// anything: it completes on its first poll.
pub(crate) fn run_now<F: std::future::Future>(future: F) -> F::Output {
    let mut future = std::pin::pin!(future);
    match future.as_mut().poll(&mut std::task::Context::from_waker(std::task::Waker::noop())) {
        std::task::Poll::Ready(output) => output,
        std::task::Poll::Pending => pollster::block_on(future),
    }
}
