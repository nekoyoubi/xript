//! The command slot kind: fills of a slot whose `accepts` includes
//! `application/x-xript-command` are named, invocable actions backed by mod
//! exports. Normalization, bound-argument merging, and resolution live here as
//! pure data-in/data-out functions; invocation is the runtime's job and routes
//! through the mod-scoped export path so a command can never reach an export
//! another mod owns.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use serde_json::{Map, Value};

use crate::manifest::Slot;
pub use crate::manifest::COMMAND_SLOT_ACCEPT;

/// Which contribution kind a fill belongs to, decided by the target slot's
/// `accepts` and then by the fill's own shape. The order is normative and
/// shared by every runtime: role, hook, command, fragment, data.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FillKind {
    Role,
    Hook,
    Command,
    Fragment,
    Data,
}

impl FillKind {
    pub fn as_str(self) -> &'static str {
        match self {
            FillKind::Role => "role",
            FillKind::Hook => "hook",
            FillKind::Command => "command",
            FillKind::Fragment => "fragment",
            FillKind::Data => "data",
        }
    }
}

/// Classifies one fill against the slot it targets. A slot listing more than
/// one reserved accept is claimed by the first match in role → hook → command
/// order, and a reserved accept always beats the fragment sniff.
pub fn classify_fill(slot: &Slot, fill: &Map<String, Value>) -> FillKind {
    if slot.is_role_slot() {
        FillKind::Role
    } else if slot.is_hook_slot() {
        FillKind::Hook
    } else if slot.is_command_slot() {
        FillKind::Command
    } else if fill.get("format").and_then(Value::as_str).is_some()
        && fill.get("source").and_then(Value::as_str).is_some()
    {
        FillKind::Fragment
    } else {
        FillKind::Data
    }
}

/// A normalized command fill: every default applied, every optional key
/// carried through verbatim.
#[derive(Debug, Clone, PartialEq)]
pub struct CommandFill {
    /// The mod that declared the fill, and the first half of export identity.
    pub mod_name: String,
    pub slot: String,
    pub id: String,
    /// `${mod}:${id}` — a total address, never renamed and never dropped.
    pub qualified_id: String,
    pub title: String,
    pub description: Option<String>,
    pub icon: Option<String>,
    pub group: Option<String>,
    pub keywords: Vec<String>,
    /// The mod export that runs the command, addressed within `mod_name`.
    pub handler: String,
    pub args: Map<String, Value>,
    pub input: Option<Value>,
    pub output: Option<Value>,
    pub priority: i64,
    pub exposed: bool,
}

/// A command fill resolved for a host: the fill plus the authority a host can
/// render and whether its bare id is ambiguous within the slot.
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedCommand {
    pub mod_name: String,
    pub slot: String,
    pub id: String,
    pub qualified_id: String,
    pub title: String,
    pub description: Option<String>,
    pub icon: Option<String>,
    pub group: Option<String>,
    pub keywords: Vec<String>,
    pub handler: String,
    pub args: Map<String, Value>,
    pub input: Option<Value>,
    pub output: Option<Value>,
    /// Informational only, never consulted at invoke: the handler's export
    /// capability when it declares one, otherwise the slot's gate.
    pub capability: Option<String>,
    pub priority: i64,
    pub exposed: bool,
    pub collides: bool,
}

impl ResolvedCommand {
    fn from_fill(fill: &CommandFill, capability: Option<String>, collides: bool) -> Self {
        Self {
            mod_name: fill.mod_name.clone(),
            slot: fill.slot.clone(),
            id: fill.id.clone(),
            qualified_id: fill.qualified_id.clone(),
            title: fill.title.clone(),
            description: fill.description.clone(),
            icon: fill.icon.clone(),
            group: fill.group.clone(),
            keywords: fill.keywords.clone(),
            handler: fill.handler.clone(),
            args: fill.args.clone(),
            input: fill.input.clone(),
            output: fill.output.clone(),
            capability,
            priority: fill.priority,
            exposed: fill.exposed,
            collides,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandDefectCode {
    FillCapability,
    MissingHandler,
    InvalidId,
    DuplicateId,
    ArgsNotObject,
    UnboundArg,
}

impl CommandDefectCode {
    pub fn as_str(self) -> &'static str {
        match self {
            CommandDefectCode::FillCapability => "command-fill-capability",
            CommandDefectCode::MissingHandler => "command-missing-handler",
            CommandDefectCode::InvalidId => "command-invalid-id",
            CommandDefectCode::DuplicateId => "command-duplicate-id",
            CommandDefectCode::ArgsNotObject => "command-args-not-object",
            CommandDefectCode::UnboundArg => "command-unbound-arg",
        }
    }
}

/// A fill-time rejection. `fill` is the index within the slot's fill array, so
/// a host reads the offending entry straight out of the manifest.
#[derive(Debug, Clone, PartialEq)]
pub struct CommandDefect {
    pub code: CommandDefectCode,
    pub slot: String,
    pub fill: usize,
    pub id: Option<String>,
    pub handler: Option<String>,
    pub arg: Option<String>,
}

impl CommandDefect {
    /// The path a [`crate::error::ValidationIssue`] carries for this defect.
    pub fn path(&self) -> String {
        let base = format!("/fills/{}/{}", self.slot, self.fill);
        match self.code {
            CommandDefectCode::FillCapability => format!("{base}/capability"),
            CommandDefectCode::MissingHandler => format!("{base}/handler"),
            CommandDefectCode::InvalidId | CommandDefectCode::DuplicateId => format!("{base}/id"),
            CommandDefectCode::ArgsNotObject => format!("{base}/args"),
            CommandDefectCode::UnboundArg => format!("{base}/args"),
        }
    }

    pub fn message(&self) -> String {
        let id = self.id.as_deref().unwrap_or("<unnamed>");
        match self.code {
            CommandDefectCode::FillCapability => format!(
                "command '{id}' declares a 'capability'; per-action authority lives on the export it names — move it to entry.exports.{}.capability",
                self.handler.as_deref().unwrap_or("<handler>")
            ),
            CommandDefectCode::MissingHandler => {
                "a command fill must name a 'handler' export".to_string()
            }
            CommandDefectCode::InvalidId => {
                "a command fill must carry an 'id' matching ^[a-z][a-z0-9.-]*$".to_string()
            }
            CommandDefectCode::DuplicateId => {
                format!("command id '{id}' is declared twice in slot '{}'", self.slot)
            }
            CommandDefectCode::ArgsNotObject => {
                "bound 'args' must be an object of argument values".to_string()
            }
            CommandDefectCode::UnboundArg => format!(
                "bound argument '{}' is not declared in this command's 'input'",
                self.arg.as_deref().unwrap_or("")
            ),
        }
    }
}

/// Whether `id` matches the command id grammar `^[a-z][a-z0-9.-]*$`.
pub fn is_valid_command_id(id: &str) -> bool {
    let mut chars = id.chars();
    match chars.next() {
        Some(first) if first.is_ascii_lowercase() => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '-')
}

fn optional_string(fill: &Map<String, Value>, key: &str) -> Option<String> {
    fill.get(key)
        .and_then(Value::as_str)
        .map(|value| value.to_string())
}

/// Normalizes one slot's command fills for one mod. Every defect is fatal: a
/// command slot is a typed accept, so a malformed fill is a load-time error
/// with a fix-it message rather than an opaque object handed to the host.
pub fn normalize_command_fills(
    mod_name: &str,
    slot_id: &str,
    entries: &[Value],
) -> Result<Vec<CommandFill>, CommandDefect> {
    let mut out: Vec<CommandFill> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    for (index, entry) in entries.iter().enumerate() {
        let empty = Map::new();
        let fill = entry.as_object().unwrap_or(&empty);
        let id = optional_string(fill, "id");
        let handler = optional_string(fill, "handler").filter(|h| !h.is_empty());

        let defect = |code: CommandDefectCode, arg: Option<String>| CommandDefect {
            code,
            slot: slot_id.to_string(),
            fill: index,
            id: id.clone(),
            handler: handler.clone(),
            arg,
        };

        if fill.contains_key("capability") {
            return Err(defect(CommandDefectCode::FillCapability, None));
        }
        let Some(handler_name) = handler.clone() else {
            return Err(defect(CommandDefectCode::MissingHandler, None));
        };
        let Some(command_id) = id.clone().filter(|id| is_valid_command_id(id)) else {
            return Err(defect(CommandDefectCode::InvalidId, None));
        };
        if !seen.insert(command_id.clone()) {
            return Err(defect(CommandDefectCode::DuplicateId, None));
        }

        let args = match fill.get("args") {
            None | Some(Value::Null) => Map::new(),
            Some(Value::Object(map)) => map.clone(),
            Some(_) => return Err(defect(CommandDefectCode::ArgsNotObject, None)),
        };

        let input = fill.get("input").cloned().filter(|v| !v.is_null());
        if let Some(ref input) = input
            && input
                .get("additionalProperties")
                .and_then(Value::as_bool)
                == Some(false)
        {
            let declared = input.get("properties").and_then(Value::as_object);
            for key in args.keys() {
                let known = declared.is_some_and(|props| props.contains_key(key));
                if !known {
                    return Err(defect(CommandDefectCode::UnboundArg, Some(key.clone())));
                }
            }
        }

        let keywords = fill
            .get("keywords")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(|s| s.to_string())
                    .collect()
            })
            .unwrap_or_default();

        out.push(CommandFill {
            mod_name: mod_name.to_string(),
            slot: slot_id.to_string(),
            qualified_id: format!("{mod_name}:{command_id}"),
            title: optional_string(fill, "title").unwrap_or_else(|| command_id.clone()),
            id: command_id,
            description: optional_string(fill, "description"),
            icon: optional_string(fill, "icon"),
            group: optional_string(fill, "group"),
            keywords,
            handler: handler_name,
            args,
            input,
            output: fill.get("output").cloned().filter(|v| !v.is_null()),
            priority: fill.get("priority").and_then(Value::as_i64).unwrap_or(0),
            exposed: fill.get("exposed").and_then(Value::as_bool).unwrap_or(true),
        });
    }

    Ok(out)
}

/// Merges bound arguments with call-time arguments. Shallow, top-level only;
/// call-time wins on a conflicting key, and a conflict is never an error.
pub fn merge_command_args(bound: &Map<String, Value>, call: Option<&Map<String, Value>>) -> Map<String, Value> {
    let mut effective = bound.clone();
    if let Some(call) = call {
        for (key, value) in call {
            effective.insert(key.clone(), value.clone());
        }
    }
    effective
}

/// The shared slot ordering: priority descending, then fill id ascending, then
/// owning mod name ascending. The third key is what makes resolution total
/// when two mods declare the same id.
fn command_order(a: &CommandFill, b: &CommandFill) -> Ordering {
    b.priority
        .cmp(&a.priority)
        .then_with(|| a.id.cmp(&b.id))
        .then_with(|| a.mod_name.cmp(&b.mod_name))
}

fn colliding_ids(fills: &[&CommandFill]) -> HashSet<String> {
    let mut seen: HashMap<&str, usize> = HashMap::new();
    for fill in fills {
        *seen.entry(fill.id.as_str()).or_insert(0) += 1;
    }
    seen.into_iter()
        .filter(|(_, count)| *count > 1)
        .map(|(id, _)| id.to_string())
        .collect()
}

/// Every command filling `slot_id`, ordered, with no cardinality applied.
/// `capability_for` supplies the informational authority for a command.
pub fn resolve_commands_all_with(
    slot_id: &str,
    fills: &[CommandFill],
    capability_for: &dyn Fn(&CommandFill) -> Option<String>,
) -> Vec<ResolvedCommand> {
    let mut matching: Vec<&CommandFill> = fills.iter().filter(|f| f.slot == slot_id).collect();
    matching.sort_by(|a, b| command_order(a, b));
    let collisions = colliding_ids(&matching);
    matching
        .into_iter()
        .map(|fill| {
            ResolvedCommand::from_fill(fill, capability_for(fill), collisions.contains(&fill.id))
        })
        .collect()
}

/// Every command filling `slot_id`, ordered, gate rendered from the slot alone.
pub fn resolve_commands_all(slot_id: &str, fills: &[CommandFill], slots: &[Slot]) -> Vec<ResolvedCommand> {
    let gate = slot_capability(slot_id, slots);
    resolve_commands_all_with(slot_id, fills, &|_| gate.clone())
}

fn slot_capability(slot_id: &str, slots: &[Slot]) -> Option<String> {
    slots
        .iter()
        .find(|slot| slot.id == slot_id)
        .and_then(|slot| slot.capability.clone())
}

fn slot_is_multiple(slot_id: &str, slots: &[Slot]) -> bool {
    slots
        .iter()
        .find(|slot| slot.id == slot_id)
        .and_then(|slot| slot.multiple)
        .unwrap_or(false)
}

/// The commands filling `slot_id` after the slot's cardinality is applied.
/// `multiple: false` yields exactly one command across all mods, the same as
/// every other slot kind.
pub fn resolve_commands_with(
    slot_id: &str,
    fills: &[CommandFill],
    slots: &[Slot],
    capability_for: &dyn Fn(&CommandFill) -> Option<String>,
) -> Vec<ResolvedCommand> {
    let mut resolved = resolve_commands_all_with(slot_id, fills, capability_for);
    if !slot_is_multiple(slot_id, slots) {
        resolved.truncate(1);
    }
    resolved
}

pub fn resolve_commands(slot_id: &str, fills: &[CommandFill], slots: &[Slot]) -> Vec<ResolvedCommand> {
    let gate = slot_capability(slot_id, slots);
    resolve_commands_with(slot_id, fills, slots, &|_| gate.clone())
}

/// Resolves a bare id or a `mod:id` qualified id against every command slot.
/// A qualified id is total and ignores preferences; a bare id takes the
/// preferred mod when one is named and present, else the ordering winner.
pub fn resolve_command_with(
    reference: &str,
    fills: &[CommandFill],
    slots: &[Slot],
    preferences: &HashMap<String, String>,
    capability_for: &dyn Fn(&CommandFill) -> Option<String>,
) -> Option<ResolvedCommand> {
    let mut slot_ids: Vec<String> = Vec::new();
    for fill in fills {
        if !slot_ids.contains(&fill.slot) {
            slot_ids.push(fill.slot.clone());
        }
    }
    slot_ids.sort();

    let mut candidates: Vec<ResolvedCommand> = Vec::new();
    for slot_id in &slot_ids {
        candidates.extend(resolve_commands_with(slot_id, fills, slots, capability_for));
    }

    if let Some((owner, id)) = reference.split_once(':') {
        return candidates
            .into_iter()
            .find(|c| c.mod_name == owner && c.id == id);
    }

    let mut matches: Vec<ResolvedCommand> = candidates
        .into_iter()
        .filter(|c| c.id == reference)
        .collect();
    matches.sort_by(|a, b| {
        b.priority
            .cmp(&a.priority)
            .then_with(|| a.id.cmp(&b.id))
            .then_with(|| a.mod_name.cmp(&b.mod_name))
    });

    let preferred = preferences
        .get(reference)
        .or_else(|| matches.first().and_then(|c| preferences.get(&c.slot)));
    if let Some(preferred) = preferred
        && let Some(hit) = matches.iter().find(|c| &c.mod_name == preferred)
    {
        return Some(hit.clone());
    }
    matches.into_iter().next()
}

pub fn resolve_command(
    reference: &str,
    fills: &[CommandFill],
    slots: &[Slot],
    preferences: &HashMap<String, String>,
) -> Option<ResolvedCommand> {
    resolve_command_with(reference, fills, slots, preferences, &|fill| {
        slot_capability(&fill.slot, slots)
    })
}

#[cfg(test)]
mod conformance {
    use super::*;

    const CORPUS: &str = include_str!("../../../spec/command-tests.json");

    fn corpus() -> Value {
        serde_json::from_str(CORPUS).expect("corpus parses")
    }

    fn slot_from(value: &Value) -> Slot {
        serde_json::from_value(value.clone()).expect("slot parses")
    }

    fn slot_accepting(accepts: &Value) -> Slot {
        slot_from(&serde_json::json!({ "id": "s", "accepts": accepts }))
    }

    #[test]
    fn matches_branch_order_section() {
        let corpus = corpus();
        let cases = corpus["branchOrder"].as_array().expect("branchOrder");
        let mut failures = Vec::new();
        for case in cases {
            let slot = slot_accepting(&case["accepts"]);
            let fill = case["fill"].as_object().expect("fill object").clone();
            let got = classify_fill(&slot, &fill).as_str();
            let expected = case["expected"].as_str().expect("expected");
            if got != expected {
                failures.push(format!(
                    "case '{}'\n  expected: {expected}\n  got:      {got}",
                    case["description"].as_str().unwrap_or("")
                ));
            }
        }
        assert!(
            failures.is_empty(),
            "{} of {} branchOrder cases failed:\n{}",
            failures.len(),
            cases.len(),
            failures.join("\n")
        );
    }

    #[test]
    fn matches_normalize_section() {
        let corpus = corpus();
        let cases = corpus["normalize"].as_array().expect("normalize");
        let mut failures = Vec::new();
        for case in cases {
            let description = case["description"].as_str().unwrap_or("");
            let mod_name = case["mod"].as_str().expect("mod");
            let slot_id = case["slot"].as_str().expect("slot");
            let entries = case["fills"].as_array().expect("fills");
            let outcome = normalize_command_fills(mod_name, slot_id, entries);
            let expected = &case["expected"];

            if expected["ok"].as_bool() == Some(true) {
                match outcome {
                    Err(defect) => failures.push(format!(
                        "case '{description}' expected ok, got defect {}",
                        defect.code.as_str()
                    )),
                    Ok(commands) => {
                        let expected_commands =
                            expected["commands"].as_array().expect("commands");
                        if commands.len() != expected_commands.len() {
                            failures.push(format!(
                                "case '{description}' expected {} commands, got {}",
                                expected_commands.len(),
                                commands.len()
                            ));
                            continue;
                        }
                        for (got, want) in commands.iter().zip(expected_commands) {
                            if let Some(diff) = command_diff(got, want) {
                                failures.push(format!("case '{description}': {diff}"));
                            }
                        }
                    }
                }
            } else {
                let want = &expected["error"];
                match outcome {
                    Ok(_) => failures.push(format!("case '{description}' expected a defect")),
                    Err(defect) => {
                        let want_code = want["code"].as_str().expect("code");
                        if defect.code.as_str() != want_code {
                            failures.push(format!(
                                "case '{description}' expected code {want_code}, got {}",
                                defect.code.as_str()
                            ));
                        }
                        if let Some(fill) = want["fill"].as_u64()
                            && defect.fill != fill as usize
                        {
                            failures.push(format!(
                                "case '{description}' expected fill index {fill}, got {}",
                                defect.fill
                            ));
                        }
                        if let Some(id) = want["id"].as_str()
                            && defect.id.as_deref() != Some(id)
                        {
                            failures.push(format!(
                                "case '{description}' expected id {id}, got {:?}",
                                defect.id
                            ));
                        }
                        if let Some(handler) = want["handler"].as_str()
                            && defect.handler.as_deref() != Some(handler)
                        {
                            failures.push(format!(
                                "case '{description}' expected handler {handler}, got {:?}",
                                defect.handler
                            ));
                        }
                        if let Some(arg) = want["arg"].as_str()
                            && defect.arg.as_deref() != Some(arg)
                        {
                            failures.push(format!(
                                "case '{description}' expected arg {arg}, got {:?}",
                                defect.arg
                            ));
                        }
                    }
                }
            }
        }
        assert!(
            failures.is_empty(),
            "{} normalize corpus failures:\n{}",
            failures.len(),
            failures.join("\n")
        );
    }

    fn command_diff(got: &CommandFill, want: &Value) -> Option<String> {
        let mut diffs = Vec::new();
        let mut check = |field: &str, got: Value, want: Value| {
            if got != want {
                diffs.push(format!("{field}: expected {want}, got {got}"));
            }
        };
        check("mod", got.mod_name.clone().into(), want["mod"].clone());
        check("slot", got.slot.clone().into(), want["slot"].clone());
        check("id", got.id.clone().into(), want["id"].clone());
        check(
            "qualifiedId",
            got.qualified_id.clone().into(),
            want["qualifiedId"].clone(),
        );
        check("title", got.title.clone().into(), want["title"].clone());
        check("handler", got.handler.clone().into(), want["handler"].clone());
        check(
            "keywords",
            serde_json::to_value(&got.keywords).unwrap(),
            want.get("keywords").cloned().unwrap_or(serde_json::json!([])),
        );
        check(
            "args",
            Value::Object(got.args.clone()),
            want.get("args").cloned().unwrap_or(serde_json::json!({})),
        );
        check("priority", got.priority.into(), want["priority"].clone());
        check("exposed", got.exposed.into(), want["exposed"].clone());
        for (field, got) in [
            ("description", got.description.clone().map(Value::from)),
            ("icon", got.icon.clone().map(Value::from)),
            ("group", got.group.clone().map(Value::from)),
            ("input", got.input.clone()),
            ("output", got.output.clone()),
        ] {
            let want = want.get(field).cloned();
            if got != want {
                diffs.push(format!("{field}: expected {want:?}, got {got:?}"));
            }
        }
        if diffs.is_empty() {
            None
        } else {
            Some(diffs.join("; "))
        }
    }

    #[test]
    fn matches_bound_args_section() {
        let corpus = corpus();
        let cases = corpus["boundArgs"].as_array().expect("boundArgs");
        let mut failures = Vec::new();
        for case in cases {
            let bound = case["args"].as_object().cloned().unwrap_or_default();
            let call = case["callArgs"].as_object().cloned();
            let got = Value::Object(merge_command_args(&bound, call.as_ref()));
            if got != case["expected"] {
                failures.push(format!(
                    "case '{}'\n  expected: {}\n  got:      {got}",
                    case["description"].as_str().unwrap_or(""),
                    case["expected"]
                ));
            }
        }
        assert!(
            failures.is_empty(),
            "{} boundArgs corpus failures:\n{}",
            failures.len(),
            failures.join("\n")
        );
    }

    #[test]
    fn matches_resolution_section() {
        let corpus = corpus();
        let cases = corpus["resolution"].as_array().expect("resolution");
        let mut failures = Vec::new();
        for case in cases {
            let description = case["description"].as_str().unwrap_or("");
            let slots: Vec<Slot> = case["slots"]
                .as_array()
                .expect("slots")
                .iter()
                .map(slot_from)
                .collect();

            // The slot capability gate runs at normalization in the runtime, so
            // an ungranted mod contributes nothing; replay that here.
            let mut fills: Vec<CommandFill> = Vec::new();
            for entry in case["mods"].as_array().expect("mods") {
                let mod_name = entry["name"].as_str().expect("name");
                let granted: HashSet<String> = entry["capabilities"]
                    .as_array()
                    .map(|caps| {
                        caps.iter()
                            .filter_map(Value::as_str)
                            .map(|s| s.to_string())
                            .collect()
                    })
                    .unwrap_or_default();
                for (slot_id, entries) in entry["fills"].as_object().expect("fills") {
                    let slot = slots.iter().find(|s| &s.id == slot_id).expect("declared slot");
                    if let Some(ref cap) = slot.capability
                        && !crate::cap_match::granted_satisfies(&granted, cap)
                    {
                        continue;
                    }
                    let entries = entries.as_array().expect("fill array");
                    match normalize_command_fills(mod_name, slot_id, entries) {
                        Ok(normalized) => fills.extend(normalized),
                        Err(defect) => failures.push(format!(
                            "case '{description}' unexpected defect {}",
                            defect.code.as_str()
                        )),
                    }
                }
            }

            let slot_id = slots[0].id.clone();
            let resolved = resolve_commands(&slot_id, &fills, &slots);
            let order: Vec<String> = resolved.iter().map(|c| c.qualified_id.clone()).collect();
            let expected_order: Vec<String> = case["expected"]["order"]
                .as_array()
                .expect("order")
                .iter()
                .filter_map(Value::as_str)
                .map(|s| s.to_string())
                .collect();
            if order != expected_order {
                failures.push(format!(
                    "case '{description}' order\n  expected: {expected_order:?}\n  got:      {order:?}"
                ));
            }

            let mut collides: Vec<String> = resolve_commands_all(&slot_id, &fills, &slots)
                .into_iter()
                .filter(|c| c.collides)
                .map(|c| c.qualified_id)
                .collect();
            let mut expected_collides: Vec<String> = case["expected"]["collides"]
                .as_array()
                .expect("collides")
                .iter()
                .filter_map(Value::as_str)
                .map(|s| s.to_string())
                .collect();
            collides.sort();
            expected_collides.sort();
            if collides != expected_collides {
                failures.push(format!(
                    "case '{description}' collides\n  expected: {expected_collides:?}\n  got:      {collides:?}"
                ));
            }

            if let Some(lookup) = case["lookup"].as_str() {
                let preferences: HashMap<String, String> = case["preferences"]
                    .as_object()
                    .map(|prefs| {
                        prefs
                            .iter()
                            .filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_string())))
                            .collect()
                    })
                    .unwrap_or_default();
                let got = resolve_command(lookup, &fills, &slots, &preferences)
                    .map(|c| c.qualified_id);
                let want = case["expected"]["resolved"].as_str().map(|s| s.to_string());
                if got != want {
                    failures.push(format!(
                        "case '{description}' lookup '{lookup}'\n  expected: {want:?}\n  got:      {got:?}"
                    ));
                }
            }
        }
        assert!(
            failures.is_empty(),
            "{} resolution corpus failures:\n{}",
            failures.len(),
            failures.join("\n")
        );
    }
}

#[cfg(test)]
mod unit {
    use super::*;

    fn fill(mod_name: &str, id: &str, priority: i64) -> CommandFill {
        CommandFill {
            mod_name: mod_name.into(),
            slot: "palette.commands".into(),
            id: id.into(),
            qualified_id: format!("{mod_name}:{id}"),
            title: id.into(),
            description: None,
            icon: None,
            group: None,
            keywords: Vec::new(),
            handler: "run".into(),
            args: Map::new(),
            input: None,
            output: None,
            priority,
            exposed: true,
        }
    }

    fn palette(multiple: bool) -> Vec<Slot> {
        vec![serde_json::from_value(serde_json::json!({
            "id": "palette.commands",
            "accepts": [COMMAND_SLOT_ACCEPT],
            "multiple": multiple
        }))
        .unwrap()]
    }

    #[test]
    fn command_id_grammar() {
        assert!(is_valid_command_id("wrap.double-quote"));
        assert!(is_valid_command_id("a"));
        assert!(!is_valid_command_id(""));
        assert!(!is_valid_command_id("Wrap"));
        assert!(!is_valid_command_id("1wrap"));
        assert!(!is_valid_command_id("wrap_double"));
        assert!(!is_valid_command_id(".wrap"));
    }

    #[test]
    fn resolution_is_independent_of_declaration_order() {
        let slots = palette(true);
        let forward = vec![fill("alpha", "wrap", 0), fill("zeta", "wrap", 0)];
        let reverse = vec![fill("zeta", "wrap", 0), fill("alpha", "wrap", 0)];
        let ids = |fills: &[CommandFill]| -> Vec<String> {
            resolve_commands("palette.commands", fills, &slots)
                .into_iter()
                .map(|c| c.qualified_id)
                .collect()
        };
        assert_eq!(ids(&forward), ids(&reverse));
        assert_eq!(ids(&forward), vec!["alpha:wrap", "zeta:wrap"]);
    }

    #[test]
    fn singular_slot_yields_one_command() {
        let slots = palette(false);
        let fills = vec![fill("alpha", "b", 0), fill("alpha", "a", 0)];
        let resolved = resolve_commands("palette.commands", &fills, &slots);
        assert_eq!(resolved.len(), 1);
        assert_eq!(resolved[0].id, "a");
    }

    #[test]
    fn qualified_lookup_ignores_preferences() {
        let slots = palette(true);
        let fills = vec![fill("alpha", "wrap", 0), fill("zeta", "wrap", 0)];
        let prefs: HashMap<String, String> =
            [("wrap".to_string(), "alpha".to_string())].into_iter().collect();
        let resolved = resolve_command("zeta:wrap", &fills, &slots, &prefs).unwrap();
        assert_eq!(resolved.qualified_id, "zeta:wrap");
    }

    #[test]
    fn slot_preference_selects_the_owner() {
        let slots = palette(true);
        let fills = vec![fill("alpha", "wrap", 0), fill("zeta", "wrap", 0)];
        let prefs: HashMap<String, String> = [(
            "palette.commands".to_string(),
            "zeta".to_string(),
        )]
        .into_iter()
        .collect();
        let resolved = resolve_command("wrap", &fills, &slots, &prefs).unwrap();
        assert_eq!(resolved.qualified_id, "zeta:wrap");
    }

    #[test]
    fn capability_is_the_export_gate_when_the_handler_declares_one() {
        let slots: Vec<Slot> = vec![serde_json::from_value(serde_json::json!({
            "id": "palette.commands",
            "accepts": [COMMAND_SLOT_ACCEPT],
            "capability": "write:editor.text",
            "multiple": true
        }))
        .unwrap()];
        let mut destructive = fill("alpha", "strip", 0);
        destructive.handler = "stripFormatting".into();
        let fills = vec![fill("alpha", "wrap", 0), destructive];
        let resolved = resolve_commands_with("palette.commands", &fills, &slots, &|f| {
            if f.handler == "stripFormatting" {
                Some("write:editor-destructive".to_string())
            } else {
                Some("write:editor.text".to_string())
            }
        });
        assert_eq!(
            resolved[0].capability.as_deref(),
            Some("write:editor-destructive")
        );
        assert_eq!(resolved[1].capability.as_deref(), Some("write:editor.text"));
    }
}
