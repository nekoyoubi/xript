//! The host-held object the runtime's sandbox-side internals live on.
//!
//! Every registry the runtime keeps in the sandbox (hook handlers, fragment
//! handlers, exports by owner, the event bus's host API) and every helper the
//! host calls into lives on one prototype-free object that only the host
//! holds, in the context's userdata. Nothing is parked on `globalThis`, so a
//! mod can neither read, replace, nor empty any of it.
//!
//! Sandbox-side code the runtime installs is compiled with [`INTRINSICS`] in
//! scope: the built-ins it calls are captured when it is installed, before any
//! mod runs, so a mod that later replaces `Reflect.apply`, `Object.keys` or
//! `Array.prototype.push` changes nothing the runtime does. Lists grow by
//! definition, never by assignment, so an index setter on `Array.prototype`
//! never sees a value.

use rquickjs::function::{IntoArgs, Rest};
use rquickjs::{Ctx, FromJs, Function, JsLifetime, Object, Value};

use crate::error::{Result, XriptError};
use crate::sandbox::CallFlags;

/// The built-ins runtime-installed code calls, captured at install time, and
/// the two helpers it grows objects and lists with.
pub(crate) const INTRINSICS: &str = r#"
    var reflectApply = Reflect.apply;
    var defineProperty = Object.defineProperty;
    var objectKeys = Object.keys;
    var objectCreate = Object.create;
    var objectFreeze = Object.freeze;
    var isFrozen = Object.isFrozen;
    var ownNames = Object.getOwnPropertyNames;
    var ownDescriptor = Object.getOwnPropertyDescriptor;
    var isArray = Array.isArray;
    var ErrorCtor = Error;
    var TypeErrorCtor = TypeError;
    var toText = String;
    function put(target, key, value) {
        defineProperty(target, key, { value: value, writable: true, enumerable: true, configurable: true });
    }
    function append(list, value) {
        put(list, list.length, value);
    }
"#;

#[derive(Clone)]
struct Internals<'js>(Object<'js>);

// SAFETY: the only field is a JS object of lifetime `'js`, re-tagged as `'to`.
unsafe impl<'js> JsLifetime<'js> for Internals<'js> {
    type Changed<'to> = Internals<'to>;
}

/// Creates the internals object. Runs first at construction.
pub(crate) fn install(ctx: &Ctx<'_>) -> rquickjs::Result<()> {
    let object: Object = ctx.eval("Object.create(null)")?;
    let _ = ctx.store_userdata(Internals(object));
    Ok(())
}

/// The internals object.
pub(crate) fn of<'js>(ctx: &Ctx<'js>) -> rquickjs::Result<Object<'js>> {
    match ctx.userdata::<Internals<'js>>() {
        Some(internals) => Ok(internals.0.clone()),
        None => Err(rquickjs::Error::new_from_js_message("internals", "object", "the internals are not installed")),
    }
}

/// `internals[name]`.
pub(crate) fn get<'js, V: FromJs<'js>>(ctx: &Ctx<'js>, name: &str) -> rquickjs::Result<V> {
    of(ctx)?.get(name)
}

/// Compiles `body` as the body of a function whose first parameter is the
/// internals object and whose further parameters are `params`, with
/// [`INTRINSICS`] in scope, and calls it with the internals object and `args`.
pub(crate) fn run<'js, A: IntoArgs<'js>, R: FromJs<'js>>(
    ctx: &Ctx<'js>,
    params: &str,
    body: &str,
    args: A,
) -> rquickjs::Result<R> {
    let separator = if params.is_empty() { "" } else { ", " };
    let installer: Function = ctx.eval(format!("(function (internals{separator}{params}) {{{INTRINSICS}{body}\n}})"))?;
    let mut call = rquickjs::function::Args::new(ctx.clone(), args.num_args() + 1);
    call.push_arg(of(ctx)?)?;
    args.into_args(&mut call)?;
    installer.call_arg(call)
}

/// Calls the internal helper `name` with host values as its arguments, under
/// a call's budget, and settles what it returns as a script's completion value
/// is settled.
pub(crate) async fn call<'js>(
    ctx: &Ctx<'js>,
    flags: &CallFlags,
    name: &str,
    args: &[serde_json::Value],
) -> Result<serde_json::Value> {
    let helper: Function = get(ctx, name).map_err(|e| XriptError::Engine(e.to_string()))?;
    let args = crate::marshal::host_args_to_js(ctx, args).map_err(XriptError::Script)?;
    match helper.call::<_, Value>((Rest(args),)) {
        Ok(returned) => flags.settle(ctx, returned).await,
        Err(_) => Err(flags.thrown(ctx)),
    }
}
