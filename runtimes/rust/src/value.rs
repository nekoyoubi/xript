//! Script values JSON cannot spell, at the host boundary.
//!
//! A host binding, a hook payload, an export's arguments and every result the
//! host reads are `serde_json::Value`, and JSON has no `undefined`, `NaN`,
//! `Infinity`, `-Infinity`, BigInt or Symbol, writes `-0` as `0`, cannot hold
//! a string that is not well-formed UTF-16, and cannot hold a cycle. On a
//! runtime built with
//! [`RuntimeOptions::value_fidelity`](crate::RuntimeOptions::value_fidelity),
//! each of these travels as a marker object instead, in the same family as the
//! callback marker:
//!
//! ```json
//! { "$xript": "undefined" }
//! { "$xript": "NaN" }
//! { "$xript": "Infinity" }
//! { "$xript": "-Infinity" }
//! { "$xript": "-0" }
//! { "$xript": "bigint", "value": "-12345678901234567890" }
//! { "$xript": "symbol", "description": "token" }
//! { "$xript": "string", "units": [97, 55296] }
//! { "$xript": "cycle", "up": 1 }
//! ```
//!
//! A marker is an object whose `$xript` names a known tag and whose other keys
//! are exactly that tag's payload keys. Anything else (an unknown tag, an
//! extra key, a missing or malformed payload) is plain data.
//!
//! - `bigint`: `value` is the decimal digits, with an optional leading `-`.
//! - `symbol`: `description` is the symbol's description, omitted when it has
//!   none. A symbol crosses out as a binding's top-level argument or as a
//!   whole result (of a script, a hook or event handler, an export, or a
//!   callback); nested symbols follow JSON (dropped from objects, `null` in
//!   arrays). Crossing in,
//!   it becomes a fresh `Symbol(description)`.
//! - `string`: `units` is every UTF-16 code unit of a string holding a lone
//!   surrogate. A well-formed string never uses it.
//! - `cycle`: a back-reference to an ancestor container. `up: 1` is the object
//!   or array directly holding the marker, `up: 2` its container, and so on.
//!   Only a back-edge becomes one; a value reached twice without a cycle still
//!   crosses as two copies.
//!
//! A script value crossing out is encoded at any depth: `echo(Infinity,
//! undefined, 1)` reaches the host as `[{"$xript":"Infinity"},
//! {"$xript":"undefined"}, 1]`. A marker crossing in (a binding's return, a
//! hook or event payload, an export's arguments) is decoded back to the real
//! value before script sees it.
//!
//! ```
//! use xript_runtime::{special, Marker, Special, XriptValue};
//!
//! let value = special::number(f64::INFINITY);
//! assert_eq!(value, serde_json::json!({ "$xript": "Infinity" }));
//! assert_eq!(value.as_js_number(), Some(f64::INFINITY));
//! assert_eq!(special::undefined().special(), Some(Special::Undefined));
//! assert_eq!(special::number(10.0), serde_json::json!(10));
//! assert_eq!(special::bigint(-7).marker(), Some(Marker::BigInt("-7".into())));
//! assert_eq!(special::utf16(&[104, 105]), serde_json::json!("hi"));
//! ```

/// The key of the marker object that stands in for a special value.
pub const SPECIAL_MARKER: &str = "$xript";

/// How deeply nested a value can be and still cross the host boundary, in
/// either direction, whatever the value fidelity setting. Past it the
/// crossing fails with an error naming the binding.
///
/// The runtime itself walks values without recursing, so the limit is set by
/// the host's side: `serde_json` clones, drops and compares a `Value`
/// recursively, and a value much deeper than this would overflow a 1 MiB
/// thread stack in an unoptimized build.
pub const MAX_DEPTH: usize = 1_024;

/// A script value with no JSON spelling.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Special {
    Undefined,
    NaN,
    Infinity,
    NegInfinity,
    NegZero,
}

impl Special {
    /// The marker's tag: `"undefined"`, `"NaN"`, `"Infinity"`, `"-Infinity"`,
    /// or `"-0"`.
    pub fn tag(self) -> &'static str {
        match self {
            Special::Undefined => "undefined",
            Special::NaN => "NaN",
            Special::Infinity => "Infinity",
            Special::NegInfinity => "-Infinity",
            Special::NegZero => "-0",
        }
    }

    /// The special value a marker tag names.
    pub fn from_tag(tag: &str) -> Option<Special> {
        match tag {
            "undefined" => Some(Special::Undefined),
            "NaN" => Some(Special::NaN),
            "Infinity" => Some(Special::Infinity),
            "-Infinity" => Some(Special::NegInfinity),
            "-0" => Some(Special::NegZero),
            _ => None,
        }
    }

    /// The marker object for this value.
    pub fn to_value(self) -> serde_json::Value {
        let mut marker = serde_json::Map::with_capacity(1);
        marker.insert(SPECIAL_MARKER.to_string(), serde_json::Value::String(self.tag().to_string()));
        serde_json::Value::Object(marker)
    }

    /// Reads a marker object. `None` for anything else, including an object
    /// with other keys beside `$xript`.
    pub fn from_value(value: &serde_json::Value) -> Option<Special> {
        let object = value.as_object()?;
        if object.len() != 1 {
            return None;
        }
        Special::from_tag(object.get(SPECIAL_MARKER)?.as_str()?)
    }

    /// The special a number JSON cannot spell is: a non-finite one or
    /// negative zero. `None` for any other number.
    pub fn from_f64(number: f64) -> Option<Special> {
        if number.is_nan() {
            Some(Special::NaN)
        } else if number == f64::INFINITY {
            Some(Special::Infinity)
        } else if number == f64::NEG_INFINITY {
            Some(Special::NegInfinity)
        } else if number == 0.0 && number.is_sign_negative() {
            Some(Special::NegZero)
        } else {
            None
        }
    }

    /// The number this special is; `None` for `undefined`.
    pub fn as_f64(self) -> Option<f64> {
        match self {
            Special::Undefined => None,
            Special::NaN => Some(f64::NAN),
            Special::Infinity => Some(f64::INFINITY),
            Special::NegInfinity => Some(f64::NEG_INFINITY),
            Special::NegZero => Some(-0.0),
        }
    }
}

/// Any marker object, read off a `serde_json::Value`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Marker {
    /// `undefined`, `NaN`, an infinity, or `-0`.
    Special(Special),
    /// A BigInt, as its decimal digits with an optional leading `-`.
    BigInt(String),
    /// A symbol and its description, `None` when it has none.
    Symbol(Option<String>),
    /// A string that is not well-formed UTF-16, as its code units.
    Utf16(Vec<u16>),
    /// A back-reference `up` containers out from the marker.
    Cycle(usize),
}

impl Marker {
    /// Reads a marker object. `None` for plain data: an unknown tag, an extra
    /// key, or a missing or malformed payload.
    pub fn from_value(value: &serde_json::Value) -> Option<Marker> {
        let object = value.as_object()?;
        let tag = object.get(SPECIAL_MARKER)?.as_str()?;
        let payload = |key: &str| if object.len() == 2 { object.get(key) } else { None };
        match tag {
            "bigint" => {
                let digits = payload("value")?.as_str()?;
                is_decimal(digits).then(|| Marker::BigInt(digits.to_string()))
            }
            "symbol" => match object.len() {
                1 => Some(Marker::Symbol(None)),
                _ => Some(Marker::Symbol(Some(payload("description")?.as_str()?.to_string()))),
            },
            "string" => payload("units")?
                .as_array()?
                .iter()
                .map(|unit| unit.as_u64().and_then(|u| u16::try_from(u).ok()))
                .collect::<Option<Vec<u16>>>()
                .map(Marker::Utf16),
            "cycle" => {
                let up = payload("up")?.as_u64()?;
                (up >= 1).then_some(Marker::Cycle(up as usize))
            }
            _ => Special::from_value(value).map(Marker::Special),
        }
    }

    /// The marker object for this value.
    pub fn to_value(&self) -> serde_json::Value {
        let mut marker = serde_json::Map::with_capacity(2);
        let tag = |tag: &str| serde_json::Value::String(tag.to_string());
        match self {
            Marker::Special(special) => return special.to_value(),
            Marker::BigInt(digits) => {
                marker.insert(SPECIAL_MARKER.into(), tag("bigint"));
                marker.insert("value".into(), serde_json::Value::String(digits.clone()));
            }
            Marker::Symbol(description) => {
                marker.insert(SPECIAL_MARKER.into(), tag("symbol"));
                if let Some(description) = description {
                    marker.insert("description".into(), serde_json::Value::String(description.clone()));
                }
            }
            Marker::Utf16(units) => {
                marker.insert(SPECIAL_MARKER.into(), tag("string"));
                marker.insert("units".into(), units.iter().map(|&u| serde_json::Value::from(u)).collect());
            }
            Marker::Cycle(up) => {
                marker.insert(SPECIAL_MARKER.into(), tag("cycle"));
                marker.insert("up".into(), serde_json::Value::from(*up));
            }
        }
        serde_json::Value::Object(marker)
    }
}

fn is_decimal(digits: &str) -> bool {
    let unsigned = digits.strip_prefix('-').unwrap_or(digits);
    !unsigned.is_empty() && unsigned.bytes().all(|b| b.is_ascii_digit())
}

/// Constructors for values a host hands the sandbox.
pub mod special {
    use super::{Marker, Special};

    /// `undefined`.
    pub fn undefined() -> serde_json::Value {
        Special::Undefined.to_value()
    }

    /// `NaN`.
    pub fn nan() -> serde_json::Value {
        Special::NaN.to_value()
    }

    /// `Infinity`.
    pub fn infinity() -> serde_json::Value {
        Special::Infinity.to_value()
    }

    /// `-Infinity`.
    pub fn neg_infinity() -> serde_json::Value {
        Special::NegInfinity.to_value()
    }

    /// `-0`.
    pub fn neg_zero() -> serde_json::Value {
        Special::NegZero.to_value()
    }

    /// A BigInt. Any integer type, or anything else whose `Display` is decimal
    /// digits, such as an `i128`.
    pub fn bigint(value: impl std::fmt::Display) -> serde_json::Value {
        Marker::BigInt(value.to_string()).to_value()
    }

    /// A symbol, with its description or without one.
    pub fn symbol(description: Option<&str>) -> serde_json::Value {
        Marker::Symbol(description.map(str::to_string)).to_value()
    }

    /// A string from UTF-16 code units: a plain string when they are
    /// well-formed, the `string` marker when they hold a lone surrogate.
    pub fn utf16(units: &[u16]) -> serde_json::Value {
        match String::from_utf16(units) {
            Ok(text) => serde_json::Value::String(text),
            Err(_) => Marker::Utf16(units.to_vec()).to_value(),
        }
    }

    /// A back-reference to the container `up` levels out from the marker.
    pub fn cycle(up: usize) -> serde_json::Value {
        Marker::Cycle(up).to_value()
    }

    /// Any `f64`, as the runtime itself reports a script number: a marker
    /// when it is not finite or is `-0`, an integer when it has an integral value that
    /// fits `i64`, otherwise a float. `special::number(10.0)` is `10`, not
    /// `10.0`, exactly as a script's `10` arrives.
    pub fn number(number: f64) -> serde_json::Value {
        if let Some(special) = Special::from_f64(number) {
            return special.to_value();
        }
        if number.fract() == 0.0 && number.abs() < 9_223_372_036_854_775_808.0 {
            return serde_json::Value::from(number as i64);
        }
        serde_json::Number::from_f64(number)
            .map(serde_json::Value::Number)
            .unwrap_or(serde_json::Value::Null)
    }

    /// Reads a value as a script number: a JSON number, or a `NaN`,
    /// `Infinity`, `-Infinity`, or `-0` marker. `None` for anything else.
    pub fn as_f64(value: &serde_json::Value) -> Option<f64> {
        match value {
            serde_json::Value::Number(n) => n.as_f64(),
            other => Special::from_value(other).and_then(Special::as_f64),
        }
    }

    /// Whether a value is the `undefined` marker.
    pub fn is_undefined(value: &serde_json::Value) -> bool {
        Special::from_value(value) == Some(Special::Undefined)
    }
}

/// Reads the markers straight off a `serde_json::Value`.
pub trait XriptValue {
    /// The special value this is, if it is a marker.
    fn special(&self) -> Option<Special>;

    /// The marker this is, of any tag.
    fn marker(&self) -> Option<Marker>;

    /// Whether this is the `undefined` marker.
    fn is_undefined(&self) -> bool;

    /// This value as a script number, the infinities, `NaN` and `-0` included.
    fn as_js_number(&self) -> Option<f64>;
}

impl XriptValue for serde_json::Value {
    fn special(&self) -> Option<Special> {
        Special::from_value(self)
    }

    fn marker(&self) -> Option<Marker> {
        Marker::from_value(self)
    }

    fn is_undefined(&self) -> bool {
        special::is_undefined(self)
    }

    fn as_js_number(&self) -> Option<f64> {
        special::as_f64(self)
    }
}

/// Drops `value` without recursing, so a deeply nested value costs no native
/// stack to let go of.
pub(crate) fn discard(value: serde_json::Value) {
    if !matches!(value, serde_json::Value::Array(_) | serde_json::Value::Object(_)) {
        return;
    }
    let mut pending = vec![value];
    while let Some(value) = pending.pop() {
        match value {
            serde_json::Value::Array(items) => pending.extend(items),
            serde_json::Value::Object(map) => pending.extend(map.into_iter().map(|(_, item)| item)),
            _ => {}
        }
    }
}

/// Clones each of `values` without recursing.
pub(crate) fn copy_all(values: &[serde_json::Value]) -> Vec<serde_json::Value> {
    values.iter().map(copy).collect()
}

/// Moves the field `key` out of `value`, an object, and discards the rest,
/// neither step recursing.
pub(crate) fn take_field(value: serde_json::Value, key: &str) -> Option<serde_json::Value> {
    let serde_json::Value::Object(mut map) = value else {
        discard(value);
        return None;
    };
    let field = map.remove(key);
    discard(serde_json::Value::Object(map));
    field
}

/// Clones `value` without recursing.
pub(crate) fn copy(value: &serde_json::Value) -> serde_json::Value {
    enum Source<'a> {
        Array(std::slice::Iter<'a, serde_json::Value>),
        Object(serde_json::map::Iter<'a>),
    }
    enum Out {
        Array(Vec<serde_json::Value>),
        Object(serde_json::Map<String, serde_json::Value>),
    }
    struct Frame<'a> {
        source: Source<'a>,
        out: Out,
        key: Option<String>,
    }
    fn open<'a>(value: &'a serde_json::Value, key: Option<String>) -> Result<Frame<'a>, serde_json::Value> {
        match value {
            serde_json::Value::Array(items) => Ok(Frame {
                source: Source::Array(items.iter()),
                out: Out::Array(Vec::with_capacity(items.len())),
                key,
            }),
            serde_json::Value::Object(map) => Ok(Frame {
                source: Source::Object(map.iter()),
                out: Out::Object(serde_json::Map::new()),
                key,
            }),
            leaf => Err(leaf.clone()),
        }
    }
    fn put(out: &mut Out, key: Option<String>, value: serde_json::Value) {
        match out {
            Out::Array(items) => items.push(value),
            Out::Object(map) => {
                map.insert(key.unwrap_or_default(), value);
            }
        }
    }
    let mut stack = match open(value, None) {
        Ok(frame) => vec![frame],
        Err(leaf) => return leaf,
    };
    loop {
        let top = stack.last_mut().expect("an open frame");
        let next = match &mut top.source {
            Source::Array(items) => items.next().map(|item| (None, item)),
            Source::Object(entries) => entries.next().map(|(key, item)| (Some(key.clone()), item)),
        };
        match next {
            Some((key, item)) => match open(item, key.clone()) {
                Ok(frame) => stack.push(frame),
                Err(leaf) => put(&mut top.out, key, leaf),
            },
            None => {
                let frame = stack.pop().expect("an open frame");
                let done = match frame.out {
                    Out::Array(items) => serde_json::Value::Array(items),
                    Out::Object(map) => serde_json::Value::Object(map),
                };
                match stack.last_mut() {
                    Some(parent) => put(&mut parent.out, frame.key, done),
                    None => return done,
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn copy_matches_clone() {
        let value = json!({ "a": [1, { "b": null, "c": [true, "x"] }], "d": {}, "e": [] });
        assert_eq!(copy(&value), value);
        assert_eq!(copy(&json!(3)), json!(3));
        discard(value);
    }

    #[test]
    fn markers_round_trip() {
        for s in [Special::Undefined, Special::NaN, Special::Infinity, Special::NegInfinity, Special::NegZero] {
            assert_eq!(Special::from_value(&s.to_value()), Some(s));
        }
        assert_eq!(Special::from_value(&json!({ "$xript": "NaN", "x": 1 })), None);
        assert_eq!(Special::from_value(&json!({ "$xript": "nan" })), None);
    }

    #[test]
    fn widened_markers_round_trip() {
        for marker in [
            Marker::BigInt("-120".into()),
            Marker::Symbol(None),
            Marker::Symbol(Some("".into())),
            Marker::Utf16(vec![97, 0xD800]),
            Marker::Cycle(3),
            Marker::Special(Special::NaN),
        ] {
            assert_eq!(Marker::from_value(&marker.to_value()), Some(marker));
        }
    }

    #[test]
    fn malformed_markers_are_data() {
        for data in [
            json!({ "$xript": "bigint" }),
            json!({ "$xript": "bigint", "value": "1.5" }),
            json!({ "$xript": "bigint", "value": "-" }),
            json!({ "$xript": "bigint", "value": 12 }),
            json!({ "$xript": "bigint", "value": "1", "extra": true }),
            json!({ "$xript": "symbol", "description": 4 }),
            json!({ "$xript": "symbol", "label": "x" }),
            json!({ "$xript": "string", "units": [70000] }),
            json!({ "$xript": "string", "units": "ab" }),
            json!({ "$xript": "string" }),
            json!({ "$xript": "cycle", "up": 0 }),
            json!({ "$xript": "cycle", "up": 1.5 }),
            json!({ "$xript": "cycle" }),
            json!({ "$xript": "NaN", "x": 1 }),
            json!({ "$xript": "Symbol" }),
        ] {
            assert_eq!(Marker::from_value(&data), None, "{data}");
        }
    }

    #[test]
    fn numbers_normalize() {
        assert_eq!(special::number(10.0), json!(10));
        assert!(special::number(10.0).is_i64());
        assert_eq!(special::number(0.0), json!(0));
        assert_eq!(special::number(-0.0), special::neg_zero());
        assert!(special::as_f64(&special::neg_zero()).unwrap().is_sign_negative());
        assert_eq!(special::number(1.5), json!(1.5));
        assert_eq!(special::number(f64::NEG_INFINITY), special::neg_infinity());
        assert!(special::as_f64(&special::nan()).unwrap().is_nan());
        assert_eq!(special::as_f64(&json!(3)), Some(3.0));
        assert_eq!(special::as_f64(&special::undefined()), None);
    }

    #[test]
    fn constructors_spell_markers() {
        assert_eq!(special::bigint(10u8), json!({ "$xript": "bigint", "value": "10" }));
        assert_eq!(special::symbol(None), json!({ "$xript": "symbol" }));
        assert_eq!(special::symbol(Some("k")), json!({ "$xript": "symbol", "description": "k" }));
        assert_eq!(special::utf16(&[0xDC00]), json!({ "$xript": "string", "units": [0xDC00] }));
        assert_eq!(special::cycle(2), json!({ "$xript": "cycle", "up": 2 }));
    }
}
