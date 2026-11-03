//! Script values JSON cannot spell, at the host boundary.
//!
//! A host binding, a hook payload, an export's arguments and every result the
//! host reads are `serde_json::Value`, and JSON has no `undefined`, `NaN`,
//! `Infinity` or `-Infinity`, and writes `-0` as `0`. On a runtime built with
//! [`RuntimeOptions::value_fidelity`](crate::RuntimeOptions::value_fidelity),
//! each of the five travels as a one-key marker object instead, in the same
//! family as the callback marker:
//!
//! ```json
//! { "$xript": "undefined" }
//! { "$xript": "NaN" }
//! { "$xript": "Infinity" }
//! { "$xript": "-Infinity" }
//! { "$xript": "-0" }
//! ```
//!
//! A script value crossing out is encoded at any depth: `echo(Infinity,
//! undefined, 1)` reaches the host as `[{"$xript":"Infinity"},
//! {"$xript":"undefined"}, 1]`. A marker crossing in (a binding's return, a
//! hook or event payload, an export's arguments) is decoded back to the real
//! value before script sees it. The key `$xript` is reserved for this: a
//! one-key object whose only key is `$xript` and whose value is one of the five
//! tags always means the special value.
//!
//! ```
//! use xript_runtime::{special, Special, XriptValue};
//!
//! let value = special::number(f64::INFINITY);
//! assert_eq!(value, serde_json::json!({ "$xript": "Infinity" }));
//! assert_eq!(value.as_js_number(), Some(f64::INFINITY));
//! assert_eq!(special::undefined().special(), Some(Special::Undefined));
//! assert_eq!(special::number(10.0), serde_json::json!(10));
//! ```

/// The key of the marker object that stands in for a special value.
pub const SPECIAL_MARKER: &str = "$xript";

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

/// Constructors for values a host hands the sandbox.
pub mod special {
    use super::Special;

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

    /// Whether this is the `undefined` marker.
    fn is_undefined(&self) -> bool;

    /// This value as a script number, the infinities, `NaN` and `-0` included.
    fn as_js_number(&self) -> Option<f64>;
}

impl XriptValue for serde_json::Value {
    fn special(&self) -> Option<Special> {
        Special::from_value(self)
    }

    fn is_undefined(&self) -> bool {
        special::is_undefined(self)
    }

    fn as_js_number(&self) -> Option<f64> {
        special::as_f64(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markers_round_trip() {
        for s in [Special::Undefined, Special::NaN, Special::Infinity, Special::NegInfinity, Special::NegZero] {
            assert_eq!(Special::from_value(&s.to_value()), Some(s));
        }
        assert_eq!(Special::from_value(&serde_json::json!({ "$xript": "NaN", "x": 1 })), None);
        assert_eq!(Special::from_value(&serde_json::json!({ "$xript": "nan" })), None);
    }

    #[test]
    fn numbers_normalize() {
        assert_eq!(special::number(10.0), serde_json::json!(10));
        assert!(special::number(10.0).is_i64());
        assert_eq!(special::number(0.0), serde_json::json!(0));
        assert_eq!(special::number(-0.0), special::neg_zero());
        assert!(special::as_f64(&special::neg_zero()).unwrap().is_sign_negative());
        assert_eq!(special::number(1.5), serde_json::json!(1.5));
        assert_eq!(special::number(f64::NEG_INFINITY), special::neg_infinity());
        assert!(special::as_f64(&special::nan()).unwrap().is_nan());
        assert_eq!(special::as_f64(&serde_json::json!(3)), Some(3.0));
        assert_eq!(special::as_f64(&special::undefined()), None);
    }
}
