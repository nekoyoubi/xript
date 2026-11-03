//! The deprecation channel: one notice per code per runtime, delivered to the
//! host's [`DeprecationSink`] or, without one, written once to stderr.
//!
//! The codes, their triggers, and what to do instead are listed in
//! `spec/deprecations.md`; `spec/deprecation-tests.json` pins the notices.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use rquickjs::Ctx;

use crate::error::{Result, XriptError};
use crate::manifest::Manifest;

/// One deprecation notice: a stable `code`, what happened, and what to do instead.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Deprecation {
    pub code: String,
    pub message: String,
    pub replacement: String,
}

/// Receives each deprecation notice a runtime raises, at most once per code.
pub type DeprecationSink = Arc<dyn Fn(&Deprecation) + Send + Sync>;

/// A runtime's deprecation channel. A code is raised at most once, whether or
/// not the host supplied a sink.
pub(crate) struct DeprecationChannel {
    sink: Option<DeprecationSink>,
    raised: Mutex<HashSet<String>>,
}

impl DeprecationChannel {
    pub(crate) fn new(sink: Option<DeprecationSink>) -> Self {
        Self {
            sink,
            raised: Mutex::new(HashSet::new()),
        }
    }

    /// Raises `code` unless this runtime already has. Without a sink the
    /// notice goes to stderr.
    pub(crate) fn raise(&self, code: &str, message: String, replacement: &str) {
        let first = self
            .raised
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(code.to_string());
        if !first {
            return;
        }
        let notice = Deprecation {
            code: code.to_string(),
            message,
            replacement: replacement.to_string(),
        };
        match &self.sink {
            Some(sink) => sink(&notice),
            None => eprintln!("xript: {} ({}). {}", notice.message, notice.code, notice.replacement),
        }
    }
}

/// The globals the runtime installs over a host binding of the same name, in
/// the order a `binding-shadows-builtin` notice names them.
const SHADOWABLE: [&str; 3] = ["events", "hooks", "xript"];

fn declared_shadowable(manifest: &Manifest) -> Vec<&'static str> {
    let Some(bindings) = manifest.bindings.as_ref() else {
        return Vec::new();
    };
    SHADOWABLE.into_iter().filter(|name| bindings.contains_key(*name)).collect()
}

/// Records what a top-level binding named like a built-in installed as, so
/// [`replaced_bindings`] can tell whether a built-in later replaced it. Runs
/// after the host bindings install and before the built-ins do.
pub(crate) fn stash_shadowable(ctx: &Ctx<'_>, manifest: &Manifest) -> Result<()> {
    let names = declared_shadowable(manifest);
    if names.is_empty() {
        return Ok(());
    }
    let script = format!(
        "(function (names) {{ var probe = {{}}; for (var i = 0; i < names.length; i++) probe[names[i]] = globalThis[names[i]]; \
         Object.defineProperty(globalThis, '__xript_shadow_probe', {{ value: probe, configurable: true }}); }})({})",
        serde_json::to_string(&names).unwrap_or_else(|_| "[]".into()),
    );
    ctx.eval::<(), _>(script.as_str())
        .map_err(|e| XriptError::Engine(e.to_string()))
}

/// The bindings [`stash_shadowable`] recorded that a built-in has since
/// replaced, in notice order. Removes the record.
pub(crate) fn replaced_bindings(ctx: &Ctx<'_>, manifest: &Manifest) -> Result<Vec<String>> {
    if declared_shadowable(manifest).is_empty() {
        return Ok(Vec::new());
    }
    let script = format!(
        "(function (order) {{ var probe = globalThis.__xript_shadow_probe; delete globalThis.__xript_shadow_probe; \
         var out = []; for (var i = 0; i < order.length; i++) {{ var n = order[i]; \
         if (Object.prototype.hasOwnProperty.call(probe, n) && globalThis[n] !== probe[n]) out.push(n); }} \
         return JSON.stringify(out); }})({})",
        serde_json::to_string(&SHADOWABLE).unwrap_or_else(|_| "[]".into()),
    );
    let raw: String = ctx
        .eval(script.as_str())
        .map_err(|e| XriptError::Engine(e.to_string()))?;
    Ok(serde_json::from_str(&raw).unwrap_or_default())
}

/// Raises `binding-shadows-builtin` naming every replaced binding.
pub(crate) fn raise_shadowed(channel: &DeprecationChannel, replaced: &[String]) {
    if replaced.is_empty() {
        return;
    }
    channel.raise(
        "binding-shadows-builtin",
        format!(
            "host bindings replaced by a built-in global of the same name, which mods see instead: {}",
            replaced.join(", ")
        ),
        "Rename the binding or move it under a namespace.",
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn raises_each_code_once() {
        let count = Arc::new(AtomicUsize::new(0));
        let seen = count.clone();
        let channel = DeprecationChannel::new(Some(Arc::new(move |_: &Deprecation| {
            seen.fetch_add(1, Ordering::SeqCst);
        })));
        channel.raise("a", "first".into(), "do b");
        channel.raise("a", "again".into(), "do b");
        channel.raise("c", "other".into(), "do d");
        assert_eq!(count.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn the_default_path_records_each_code_once() {
        let channel = DeprecationChannel::new(None);
        channel.raise("a", "first".into(), "do b");
        channel.raise("a", "again".into(), "do b");
        assert_eq!(channel.raised.lock().unwrap().len(), 1);
    }
}
