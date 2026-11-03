//! The events bus: the shared kernel installed into a runtime, and the host
//! side of it.
//!
//! The kernel (`event_bus_kernel.js`) is the same source every xript runtime
//! evaluates, so bus semantics cannot drift between engines. This module hands
//! it the host object (token, manifest events, caller context, capability
//! check) and parks the host API it returns on a non-writable
//! `globalThis.__xript_bus`, where the runtime's string-evaluated calls reach
//! it. Every host method there demands the token, so a mod that finds the
//! object cannot use it.

use std::collections::HashSet;
use std::hash::{BuildHasher, Hasher};

use rquickjs::{Ctx, Function, Object};

use crate::caller_context::CallerContext;
use crate::error::{Result, XriptError};
use crate::manifest::Manifest;

const KERNEL: &str = include_str!("event_bus_kernel.js");

const INSTALL: &str = r#"(function (kernel, config, currentRaw, enterRaw, leaveRaw, satisfiesRaw, peerRaw) {
    var installGlobal = config.installGlobal === true;
    var peer = null;
    if (peerRaw) {
        peer = Object.freeze({
            self: peerRaw.self,
            read: function () { return peerRaw.read(); },
            write: function (version, state) { return peerRaw.write(version, state) === true; },
            call: function (worker, request) { return peerRaw.call(worker, request); },
            poll: function (ticket) { var answer = peerRaw.poll(ticket); return typeof answer === 'string' ? answer : null; },
            take: function () { var request = peerRaw.take(); return typeof request === 'string' ? request : null; },
            reply: function (id, outcome) { peerRaw.reply(id, outcome); },
            ask: peerRaw.ask ? function (worker, request, answer) { peerRaw.ask(worker, request, answer); } : undefined
        });
    }
    var api = kernel({
        token: config.token,
        events: config.events,
        installGlobal: installGlobal,
        peer: peer,
        caller: function () { var current = currentRaw(); return typeof current === 'string' ? current : null; },
        enter: function (owner) { enterRaw(typeof owner === 'string' ? owner : null); },
        leave: function () { leaveRaw(); },
        satisfies: function (capability) { return satisfiesRaw(String(capability)) === true; }
    });
    var bus = Object.freeze({ api: api, events: installGlobal ? globalThis.events : undefined });
    Object.defineProperty(globalThis, '__xript_bus', { value: bus, writable: false, enumerable: false, configurable: false });
})"#;

/// A per-runtime secret, 128 bits of hex. Seeded from the standard library's
/// per-process random hasher keys and the clock, so it needs no extra crate.
pub(crate) fn bus_token() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    let mut token = String::with_capacity(32);
    for round in 0..2u8 {
        let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
        hasher.write_u128(nanos);
        hasher.write_u8(round);
        token.push_str(&format!("{:016x}", hasher.finish()));
    }
    token
}

/// Whether the kernel should assign the `events` global. A runtime that
/// declares no events and has a top-level binding named `events` never
/// installed the global before the bus existed, so the binding keeps the name.
pub(crate) fn installs_global(manifest: &Manifest) -> bool {
    let declares_events = manifest.events.as_ref().is_some_and(|events| !events.is_empty());
    let binding_named_events = manifest
        .bindings
        .as_ref()
        .is_some_and(|bindings| bindings.contains_key("events"));
    declares_events || !binding_named_events
}

/// Evaluates the kernel in `ctx` and wires it to this runtime. With a `peer`,
/// the bus is the one every runtime holding a seat on the same hub shares.
pub(crate) fn install(
    ctx: &Ctx<'_>,
    manifest: &Manifest,
    granted: &HashSet<String>,
    caller: &CallerContext,
    token: &str,
    peer: Option<&Seat>,
) -> Result<()> {
    let engine = |e: rquickjs::Error| XriptError::Engine(e.to_string());
    let kernel: Function = ctx.eval(KERNEL).map_err(engine)?;
    let install: Function = ctx.eval(INSTALL).map_err(engine)?;
    let events_json = serde_json::to_string(manifest.events.as_deref().unwrap_or(&[]))?;

    let current = {
        let caller = caller.clone();
        Function::new(ctx.clone(), move || caller.current()).map_err(engine)?
    };
    let enter = {
        let caller = caller.clone();
        Function::new(ctx.clone(), move |owner: Option<String>| caller.push(owner)).map_err(engine)?
    };
    let leave = {
        let caller = caller.clone();
        Function::new(ctx.clone(), move || caller.pop()).map_err(engine)?
    };
    let satisfies = {
        let granted = granted.clone();
        Function::new(ctx.clone(), move |capability: String| {
            crate::cap_match::granted_satisfies(&granted, &capability)
        })
        .map_err(engine)?
    };

    let config = Object::new(ctx.clone()).map_err(engine)?;
    config.set("token", token).map_err(engine)?;
    config.set("events", events_json).map_err(engine)?;
    config.set("installGlobal", installs_global(manifest)).map_err(engine)?;

    let peer_object = match peer {
        Some(seat) => Some(peer_object(ctx, seat, caller).map_err(engine)?),
        None => None,
    };

    install
        .call::<_, ()>((
            kernel,
            config,
            current,
            enter,
            leave,
            satisfies,
            peer_object,
        ))
        .map_err(|e| XriptError::Engine(format!("event bus install: {e}")))
}

/// Captures the budget frames governing the call running now, so a wait that
/// outlives the host call that started it can still tell when that budget is
/// spent.
pub(crate) type BudgetSnapshot = std::sync::Arc<dyn Fn() -> Vec<crate::sandbox::InterruptFrame> + Send + Sync>;

/// What the kernel needs from the runtime to wait on a peer: the shared hub
/// and this runtime's seat on it, plus a way to tell that the call doing the
/// waiting has run out of budget. A yielding runtime also hands over `budget`,
/// which lets a mod's `events.emitAsync` await another worker's answer
/// without holding the thread.
pub(crate) struct Seat {
    pub(crate) peer: crate::bus_hub::BusPeer,
    pub(crate) stopped: std::sync::Arc<dyn Fn() -> bool + Send + Sync>,
    pub(crate) budget: Option<BudgetSnapshot>,
}

/// How long a forwarded delivery is awaited when no budget frame governs the
/// code that asked for it.
#[cfg(feature = "threads")]
const UNGOVERNED_WAIT: std::time::Duration = std::time::Duration::from_secs(3600);

/// The host half of `host.peer`, bound to one seat.
fn peer_object<'js>(ctx: &Ctx<'js>, seat: &Seat, caller: &CallerContext) -> rquickjs::Result<Object<'js>> {
    let object = Object::new(ctx.clone())?;
    let worker = seat.peer.worker;
    object.set("self", worker as f64)?;
    let hub = seat.peer.hub.clone();
    object.set("read", Function::new(ctx.clone(), move || hub.read())?)?;
    let hub = seat.peer.hub.clone();
    object.set(
        "write",
        Function::new(ctx.clone(), move |version: f64, state: String| hub.write(version as u64, state))?,
    )?;
    let hub = seat.peer.hub.clone();
    object.set(
        "call",
        Function::new(ctx.clone(), move |target: f64, request: String| hub.call(target as usize, &request) as f64)?,
    )?;
    let hub = seat.peer.hub.clone();
    let stopped = seat.stopped.clone();
    object.set(
        "poll",
        Function::new(ctx.clone(), move |ticket: f64| -> Option<String> {
            if stopped() {
                return Some("stop".to_string());
            }
            hub.poll(worker, ticket as u64)
        })?,
    )?;
    let hub = seat.peer.hub.clone();
    object.set("take", Function::new(ctx.clone(), move || hub.take(worker))?)?;
    let hub = seat.peer.hub.clone();
    object.set(
        "reply",
        Function::new(ctx.clone(), move |id: f64, outcome: String| hub.reply(id as u64, &outcome))?,
    )?;
    #[cfg(feature = "threads")]
    if let Some(budget) = seat.budget.clone() {
        object.set("ask", ask_function(ctx, seat.peer.hub.clone(), caller.clone(), budget)?)?;
    }
    #[cfg(not(feature = "threads"))]
    let _ = (caller, &seat.budget);
    Ok(object)
}

/// `peer.ask(worker, request, answer)` on a yielding runtime: forwards one
/// delivery and awaits the answer on the runtime's own executor, so the
/// thread keeps running other calls, and serving what other workers ask of
/// it, meanwhile. `answer` is called with the kernel's outcome, or with
/// `"stop"` once the budget governing the asking call is spent, in the caller
/// lane the ask was made from, and the job queue is drained there, so the
/// emit's continuation is credited to the call it belongs to.
#[cfg(feature = "threads")]
fn ask_function<'js>(
    ctx: &Ctx<'js>,
    hub: std::sync::Arc<crate::bus_hub::BusHub>,
    caller: CallerContext,
    budget: BudgetSnapshot,
) -> rquickjs::Result<Function<'js>> {
    Function::new(
        ctx.clone(),
        move |ctx: Ctx<'js>, target: f64, request: String, answer: Function<'js>| -> rquickjs::Result<()> {
            let ticket = hub.call(target as usize, &request);
            let governing = budget();
            let deadline = governing
                .iter()
                .map(|frame| frame.deadline)
                .min()
                .unwrap_or_else(|| std::time::Instant::now() + UNGOVERNED_WAIT);
            let spent = move || -> Result<u64> {
                if crate::sandbox::frames_spent(&governing) {
                    Err(XriptError::ExecutionLimit { limit: "timeout_ms".into() })
                } else {
                    Ok(1)
                }
            };
            let waiting = crate::sandbox::AwaitAnswer::new(hub.clone(), ticket, deadline, spent);
            let lane = caller.active_lane();
            let caller = caller.clone();
            let settle_ctx = ctx.clone();
            ctx.spawn(async move {
                let message = waiting.await.unwrap_or_else(|_| "stop".to_string());
                let _lane = caller.activate(lane);
                let _ = answer.call::<_, ()>((message,));
                crate::sandbox::drain_jobs(&settle_ctx);
            });
            Ok(())
        },
    )
}

/// A JS string literal for `value`, safe to splice into evaluated source.
fn js_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".into())
}

/// A JS string literal holding `value` serialized as JSON, safe to splice into
/// evaluated source whatever the data contains.
pub(crate) fn json_literal<T: serde::Serialize + ?Sized>(value: &T) -> String {
    let json = serde_json::to_string(value).unwrap_or_else(|_| "null".into());
    serde_json::to_string(&json).unwrap_or_else(|_| "\"null\"".into())
}

/// Source for a host emit: the kernel dispatch, results as a JSON array of
/// `{ owner, value }`. A payload carrying a retained callback marker is
/// revived first, so the handler receives the original function.
pub(crate) fn emit_source(token: &str, event: &str, args: &[serde_json::Value]) -> String {
    let parsed = format!("JSON.parse({})", json_literal(args));
    let args = if args.iter().any(crate::retained::contains_marker) {
        format!("{}({parsed})", crate::retained::REVIVE_GLOBAL)
    } else {
        parsed
    };
    format!(
        "(function () {{ var results = globalThis.__xript_bus.api.emit({token}, {event}, {args}); \
         return JSON.stringify(results.map(function (r) {{ return {{ owner: r.owner, value: r.value === undefined ? null : r.value }}; }})); }})()",
        token = js_string(token),
        event = js_string(event),
    )
}

/// Source that runs every request a peer queued for this runtime, returning
/// how many it served.
#[cfg_attr(not(feature = "threads"), allow(dead_code))]
pub(crate) fn serve_inbox_source(token: &str) -> String {
    format!("globalThis.__xript_bus.api.serveInbox({token})", token = js_string(token))
}

/// Source for a host `cancelOwned`, returning the count.
pub(crate) fn cancel_owned_source(token: &str, owner: Option<&str>) -> String {
    format!(
        "globalThis.__xript_bus.api.cancelOwned({token}, JSON.parse({owner}))",
        token = js_string(token),
        owner = json_literal(&owner),
    )
}

/// Source for a host `declare`, returning `{ ok }` or `{ err }` as JSON.
pub(crate) fn declare_source(token: &str, entry: &serde_json::Value) -> String {
    format!(
        "(function () {{ try {{ return JSON.stringify({{ ok: globalThis.__xript_bus.api.declare({token}, JSON.parse({entry})) }}); }} \
         catch (e) {{ return JSON.stringify({{ err: String(e && e.message) }}); }} }})()",
        token = js_string(token),
        entry = json_literal(entry),
    )
}

/// Source listing the events `mod_id` holds a listener on, as a JSON array.
pub(crate) fn subscribed_events_source(mod_id: &str) -> String {
    format!(
        "(function () {{ var bus = globalThis.__xript_bus; var events = bus && bus.events; var out = []; \
         if (!events) return JSON.stringify(out); var want = JSON.parse({mod_id}); var names = events.names(); \
         for (var i = 0; i < names.length; i++) {{ var owners = events.subscribers(names[i]).owners; \
         for (var j = 0; j < owners.length; j++) {{ if (owners[j].owner === want) {{ out.push(names[i]); break; }} }} }} \
         return JSON.stringify(out); }})()",
        mod_id = json_literal(mod_id),
    )
}
