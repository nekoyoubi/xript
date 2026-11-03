//! Caller-aware host bindings: a binding that learns which mod called it.

use std::sync::Arc;

use crate::caller_context::CallerContext;
use crate::sandbox::HostFn;

/// What a caller-aware binding learns about the call it is serving.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostCallInfo {
    /// The calling mod's id, or `None` for code no mod owns.
    pub mod_id: Option<String>,
    /// The binding's qualified name, `"save"` or `"world.getHealth"`.
    pub binding: String,
}

/// A host binding that receives [`HostCallInfo`] ahead of the script's arguments.
pub type CallerHostFn = Arc<
    dyn Fn(&HostCallInfo, &[serde_json::Value]) -> std::result::Result<serde_json::Value, String>
        + Send
        + Sync,
>;

/// Turns a caller-aware binding into an ordinary one that reads the caller
/// from `caller` at call time and knows its own qualified name.
pub(crate) fn bind_caller(f: CallerHostFn, caller: &CallerContext, binding: String) -> HostFn {
    let caller = caller.clone();
    Arc::new(move |args| {
        let info = HostCallInfo {
            mod_id: caller.current(),
            binding: binding.clone(),
        };
        f(&info, args)
    })
}
