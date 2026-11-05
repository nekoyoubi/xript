//! The events bus: the shared kernel installed into a runtime, and the host
//! side of it.
//!
//! The kernel (`event_bus_kernel.js`) is the same source every xript runtime
//! evaluates, so bus semantics cannot drift between engines. This module hands
//! it the host object (token, manifest events, caller context, capability
//! check) and keeps the host API it returns, with the few host-side helpers
//! that call it, on the internals object only the host holds. Every host
//! method there demands the token as well.
//!
//! In a pool, a delivery to a handler on another worker crosses as JSON text.
//! Payloads and results are encoded with every marker in [`crate::value`]
//! whatever the runtimes' value fidelity, symbols at any depth and keys in
//! their own order, so a handler on another worker receives what a handler on
//! the same worker would, short of identity: a function, which cannot be
//! called from another worker, arrives as `undefined`, and a symbol as a fresh
//! one.

use std::collections::HashSet;
use std::hash::{BuildHasher, Hasher};

use rquickjs::{Ctx, Function, Object};

use crate::caller_context::CallerContext;
use crate::error::{Result, XriptError};
use crate::manifest::Manifest;

const KERNEL: &str = include_str!("event_bus_kernel.js");

const INSTALL: &str = r#"
    var installGlobal = config.installGlobal === true;
    var peer = null;
    if (peerRaw) {
        peer = objectFreeze({
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
        encode: config.encode,
        caller: function () { var current = currentRaw(); return typeof current === 'string' ? current : null; },
        enter: function (owner) { enterRaw(typeof owner === 'string' ? owner : null); },
        leave: function () { leaveRaw(); },
        satisfies: function (capability) { return satisfiesRaw(toText(capability)) === true; }
    });
    var token = config.token;
    var events = installGlobal ? globalThis.events : undefined;
    var names = events ? events.names : undefined;
    var subscribers = events ? events.subscribers : undefined;
    internals.bus = objectFreeze({ api: api });
    internals.busServe = function () { return api.serveInbox(token); };
    internals.busCancelOwned = function (owner) { return api.cancelOwned(token, owner); };
    internals.busDeclare = function (entry) {
        try {
            return { ok: api.declare(token, entry) };
        } catch (e) {
            return { err: toText(e && e.message) };
        }
    };
    internals.busSubscribed = function (modId) {
        var out = [];
        if (!events) return out;
        var ids = reflectApply(names, events, []);
        for (var i = 0; i < ids.length; i++) {
            var owners = reflectApply(subscribers, events, [ids[i]]).owners;
            for (var j = 0; j < owners.length; j++) {
                if (owners[j].owner === modId) { append(out, ids[i]); break; }
            }
        }
        return out;
    };
"#;

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

/// Refuses construction in host events mode unless the manifest declares a
/// top-level `events` binding for the runtime to install. A manifest `events`
/// catalogue is allowed; it documents the host's events but is wired to no
/// script-visible bus.
pub(crate) fn check_host_events(manifest: &Manifest) -> Result<()> {
    let binding_named_events = manifest
        .bindings
        .as_ref()
        .is_some_and(|bindings| bindings.contains_key("events"));
    if !binding_named_events {
        return Err(XriptError::HostEvents {
            message: "host events mode needs a top-level `events` binding in the manifest to install as the `events` global; declare one, or construct the runtime without host events mode to get the built-in bus".into(),
        });
    }
    Ok(())
}

/// The error for a host call into the built-in bus's API while the host's
/// own binding is `events`.
pub(crate) fn host_events_refusal(api: &str) -> XriptError {
    XriptError::HostEvents {
        message: format!(
            "`{api}` is not available in host events mode: the host's own `events` binding is the bus mods see, so the built-in bus has no subscribers to reach"
        ),
    }
}

/// Evaluates the kernel in `ctx` and wires it to this runtime. With a `peer`,
/// the bus is the one every runtime holding a seat on the same hub shares.
/// Under `host_events` the kernel never assigns the `events` global, so the
/// host's binding keeps the name whether or not the manifest has a catalogue.
pub(crate) fn install<'js>(
    ctx: &Ctx<'js>,
    manifest: &Manifest,
    granted: &HashSet<String>,
    caller: &CallerContext,
    token: &str,
    peer: Option<&Seat>,
    host_events: bool,
) -> Result<()> {
    let engine = |e: rquickjs::Error| XriptError::Engine(e.to_string());
    let kernel: Function = ctx.eval(KERNEL).map_err(engine)?;
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

    let encode = Function::new(ctx.clone(), |ctx: Ctx<'js>, value: rquickjs::Value<'js>| {
        crate::marshal::crossing_tape(&ctx, value)
    })
    .map_err(engine)?;

    let config = Object::new(ctx.clone()).map_err(engine)?;
    config.set("token", token).map_err(engine)?;
    config.set("encode", encode).map_err(engine)?;
    config.set("events", events_json).map_err(engine)?;
    config.set("installGlobal", installs_global(manifest) && !host_events).map_err(engine)?;

    let peer_object = match peer {
        Some(seat) => Some(peer_object(ctx, seat, caller).map_err(engine)?),
        None => None,
    };

    crate::internals::run::<_, ()>(
        ctx,
        "kernel, config, currentRaw, enterRaw, leaveRaw, satisfiesRaw, peerRaw",
        INSTALL,
        (kernel, config, current, enter, leave, satisfies, peer_object),
    )
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
