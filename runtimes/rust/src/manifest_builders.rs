//! Constructors for the public manifest structs a host builds by hand.
//!
//! A struct literal names every field, so it stops compiling whenever the
//! manifest grows a field. `new` takes what a declaration requires and the
//! `with_*` setters add the rest, so code built this way keeps compiling as
//! fields are added.

use std::collections::HashMap;

use serde_json::Value;

use crate::manifest::{
    Binding, EventDefinition, ExecutionIntent, FieldDefinition, FunctionBinding, Limits, NamespaceBinding, Parameter,
};

impl Parameter {
    /// A required, non-variadic parameter of `ty`, which takes the manifest's
    /// type reference shape (`json!("string")`, `json!({ "array": "number" })`).
    pub fn new(name: impl Into<String>, ty: impl Into<Value>) -> Self {
        Self {
            name: name.into(),
            r#type: ty.into(),
            description: None,
            default: None,
            required: None,
            optional: None,
            variadic: false,
            retain: false,
        }
    }

    pub fn with_optional(mut self, optional: bool) -> Self {
        self.optional = Some(optional);
        self
    }

    pub fn with_description(mut self, description: impl Into<String>) -> Self {
        self.description = Some(description.into());
        self
    }

    pub fn with_default(mut self, default: impl Into<Value>) -> Self {
        self.default = Some(default.into());
        self
    }

    pub fn with_required(mut self, required: bool) -> Self {
        self.required = Some(required);
        self
    }

    pub fn with_variadic(mut self, variadic: bool) -> Self {
        self.variadic = variadic;
        self
    }

    pub fn with_retain(mut self, retain: bool) -> Self {
        self.retain = retain;
        self
    }
}

impl FieldDefinition {
    /// A required record field of `ty`, which takes the manifest's type
    /// reference shape.
    pub fn new(ty: impl Into<Value>) -> Self {
        Self {
            r#type: ty.into(),
            description: None,
            optional: false,
            default: None,
            r#enum: None,
            retain: false,
        }
    }

    pub fn with_description(mut self, description: impl Into<String>) -> Self {
        self.description = Some(description.into());
        self
    }

    pub fn with_optional(mut self, optional: bool) -> Self {
        self.optional = optional;
        self
    }

    pub fn with_default(mut self, default: impl Into<Value>) -> Self {
        self.default = Some(default.into());
        self
    }

    pub fn with_enum(mut self, values: Vec<Value>) -> Self {
        self.r#enum = Some(values);
        self
    }

    pub fn with_retain(mut self, retain: bool) -> Self {
        self.retain = retain;
        self
    }
}

impl Limits {
    /// No limits declared: each falls back to the runtime default.
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_timeout_ms(mut self, timeout_ms: u64) -> Self {
        self.timeout_ms = Some(timeout_ms);
        self
    }

    pub fn with_memory_mb(mut self, memory_mb: u64) -> Self {
        self.memory_mb = Some(memory_mb);
        self
    }

    pub fn with_max_stack_depth(mut self, max_stack_depth: usize) -> Self {
        self.max_stack_depth = Some(max_stack_depth);
        self
    }

    pub fn with_max_retained_callbacks(mut self, max_retained_callbacks: usize) -> Self {
        self.max_retained_callbacks = Some(max_retained_callbacks);
        self
    }
}

impl FunctionBinding {
    /// A function binding with no parameters, return type, or gate.
    pub fn new(description: impl Into<String>) -> Self {
        Self {
            description: description.into(),
            params: None,
            returns: None,
            r#async: None,
            capability: None,
            deprecated: None,
            execution: None,
            optional: None,
        }
    }

    pub fn with_params(mut self, params: Vec<Parameter>) -> Self {
        self.params = Some(params);
        self
    }

    /// Appends one parameter.
    pub fn with_param(mut self, param: Parameter) -> Self {
        self.params.get_or_insert_with(Vec::new).push(param);
        self
    }

    pub fn with_returns(mut self, returns: impl Into<Value>) -> Self {
        self.returns = Some(returns.into());
        self
    }

    pub fn with_async(mut self, is_async: bool) -> Self {
        self.r#async = Some(is_async);
        self
    }

    pub fn with_capability(mut self, capability: impl Into<String>) -> Self {
        self.capability = Some(capability.into());
        self
    }

    pub fn with_deprecated(mut self, message: impl Into<String>) -> Self {
        self.deprecated = Some(message.into());
        self
    }

    pub fn with_execution(mut self, execution: ExecutionIntent) -> Self {
        self.execution = Some(execution);
        self
    }

    pub fn with_optional(mut self, optional: bool) -> Self {
        self.optional = Some(optional);
        self
    }
}

impl NamespaceBinding {
    /// A namespace with no members yet.
    pub fn new(description: impl Into<String>) -> Self {
        Self {
            description: description.into(),
            members: HashMap::new(),
            optional: None,
        }
    }

    /// Adds or replaces one member.
    pub fn with_member(mut self, name: impl Into<String>, member: Binding) -> Self {
        self.members.insert(name.into(), member);
        self
    }

    pub fn with_members(mut self, members: HashMap<String, Binding>) -> Self {
        self.members = members;
        self
    }

    pub fn with_optional(mut self, optional: bool) -> Self {
        self.optional = Some(optional);
        self
    }
}

impl EventDefinition {
    /// An event with only its id; a manifest entry also needs a description.
    pub fn new(id: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            description: None,
            payload: None,
            capability: None,
            emit: None,
            pattern: None,
            addressed: None,
            keys: None,
        }
    }

    pub fn with_description(mut self, description: impl Into<String>) -> Self {
        self.description = Some(description.into());
        self
    }

    pub fn with_payload(mut self, payload: impl Into<Value>) -> Self {
        self.payload = Some(payload.into());
        self
    }

    pub fn with_capability(mut self, capability: impl Into<String>) -> Self {
        self.capability = Some(capability.into());
        self
    }

    /// `"host"` (the default) or `"mods"`.
    pub fn with_emit(mut self, emit: impl Into<String>) -> Self {
        self.emit = Some(emit.into());
        self
    }

    pub fn with_pattern(mut self, pattern: bool) -> Self {
        self.pattern = Some(pattern);
        self
    }

    pub fn with_addressed(mut self, shapes: Vec<String>) -> Self {
        self.addressed = Some(shapes);
        self
    }

    pub fn with_keys(mut self, keys: Vec<String>) -> Self {
        self.keys = Some(keys);
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn builds_what_deserializing_builds() {
        let built = FunctionBinding::new("Saves.")
            .with_param(Parameter::new("slot", "string"))
            .with_param(Parameter::new("onDone", "function").with_retain(true))
            .with_capability("storage");
        let parsed: FunctionBinding = serde_json::from_value(json!({
            "description": "Saves.",
            "params": [{ "name": "slot", "type": "string" }, { "name": "onDone", "type": "function", "retain": true }],
            "capability": "storage"
        }))
        .unwrap();
        assert_eq!(format!("{built:?}"), format!("{parsed:?}"));
    }

    #[test]
    fn an_event_and_limits_build_field_by_field() {
        let event = EventDefinition::new("stat.changed")
            .with_description("Fired after any stat changes.")
            .with_emit("mods")
            .with_addressed(vec!["stat.<instanceId>.changed".into()])
            .with_keys(vec!["instanceId".into(), "value".into()]);
        let parsed: EventDefinition = serde_json::from_value(json!({
            "id": "stat.changed",
            "description": "Fired after any stat changes.",
            "emit": "mods",
            "addressed": ["stat.<instanceId>.changed"],
            "keys": ["instanceId", "value"]
        }))
        .unwrap();
        assert_eq!(event, parsed);
        let limits = Limits::new().with_timeout_ms(250).with_max_retained_callbacks(8);
        assert_eq!(limits.timeout_ms, Some(250));
        assert_eq!(limits.max_retained_callbacks, Some(8));
        assert_eq!(limits.memory_mb, None);
    }
}
