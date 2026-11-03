use serde_json::{Number, Value};

/// Wraps a float back into a JSON number, collapsing every non-finite result to `null`.
///
/// Division by zero, overflow, and `NaN` all land here. XEG has no infinity and no NaN:
/// a computation that leaves the reals leaves the value domain, and `null` is what the
/// grammar says that looks like.
pub fn finite(value: f64) -> Value {
    if !value.is_finite() {
        return Value::Null;
    }
    match Number::from_f64(value) {
        Some(number) => Value::Number(number),
        None => Value::Null,
    }
}


pub fn is_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().map(|f| f != 0.0 && !f.is_nan()).unwrap_or(false),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `str()` — the one stringification every runtime shares. `null` renders as empty, which
/// is what makes an absent value disappear from prose rather than spelling out "null".
pub fn render(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::Bool(b) => if *b { "true" } else { "false" }.to_string(),
        Value::Number(n) => match n.as_f64() {
            Some(f) if f.is_finite() => format_number(f),
            _ => String::new(),
        },
        Value::String(s) => s.clone(),
        Value::Array(items) => items.iter().map(render).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

/// JavaScript's `String(number)`: the shortest digits that round-trip, laid out in plain
/// notation from 1e-6 up to 1e21 and in exponent form (`1e-7`, `1.5e+300`) outside it.
pub fn format_number(value: f64) -> String {
    if !value.is_finite() {
        return String::new();
    }
    if value == 0.0 {
        return "0".to_string();
    }
    let (digits, point) = shortest_digits(value.abs());
    let sign = if value < 0.0 { "-" } else { "" };
    format!("{sign}{}", layout_digits(&digits, point))
}

/// The shortest round-tripping decimal digits of a positive finite `value`, with no leading
/// or trailing zeros, and the position of the decimal point relative to them: the value is
/// `0.d1d2… × 10^point`.
fn shortest_digits(value: f64) -> (String, i32) {
    let shortest = format!("{value:e}");
    let significant = shortest.split_once('e').map(|(m, _)| m).unwrap_or(&shortest).replace('.', "").len();
    // When two digit strings of that length both round-trip, ECMAScript takes the one nearer
    // the exact value; formatting correctly rounded at the shortest length yields exactly that.
    let scientific = format!("{:.*e}", significant.saturating_sub(1), value);
    let (mantissa, exponent) = scientific.split_once('e').unwrap_or((&scientific, "0"));
    let exponent: i32 = exponent.parse().unwrap_or(0);
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let trimmed = digits.trim_end_matches('0');
    let digits = if trimmed.is_empty() { "0" } else { trimmed };
    (digits.to_string(), exponent + 1)
}

/// ECMAScript `Number::toString` layout for digits `d1…dk` and point position `n`.
fn layout_digits(digits: &str, point: i32) -> String {
    let k = digits.len() as i32;
    if k <= point && point <= 21 {
        format!("{digits}{}", "0".repeat((point - k) as usize))
    } else if 0 < point && point <= 21 {
        format!("{}.{}", &digits[..point as usize], &digits[point as usize..])
    } else if -6 < point && point <= 0 {
        format!("0.{}{digits}", "0".repeat((-point) as usize))
    } else {
        let exponent = point - 1;
        let sign = if exponent < 0 { '-' } else { '+' };
        let mantissa = if k == 1 { digits.to_string() } else { format!("{}.{}", &digits[..1], &digits[1..]) };
        format!("{mantissa}e{sign}{}", exponent.abs())
    }
}

/// JavaScript's `Math.round`: the nearest integer, a half rounding toward positive infinity.
pub fn round_half_up(value: f64) -> f64 {
    let floor = value.floor();
    if value - floor >= 0.5 {
        floor + 1.0
    } else {
        floor
    }
}

/// JavaScript's `Number.prototype.toFixed`: the exact binary value rounded to `digits`
/// places, a half rounding away from zero, and `String(value)` from 1e21 up.
pub fn format_fixed(value: f64, digits: usize) -> String {
    if value.abs() >= 1e21 {
        return format_number(value);
    }
    let negative = value < 0.0;
    let exact = format!("{:.1100}", value.abs());
    let (whole, fraction) = exact.split_once('.').unwrap_or((&exact, ""));
    let mut kept: Vec<u8> = whole.bytes().chain(fraction.bytes().take(digits)).collect();
    if fraction.as_bytes().get(digits).is_some_and(|next| *next >= b'5') {
        let mut i = kept.len();
        loop {
            if i == 0 {
                kept.insert(0, b'1');
                break;
            }
            i -= 1;
            if kept[i] == b'9' {
                kept[i] = b'0';
            } else {
                kept[i] += 1;
                break;
            }
        }
    }
    let split = kept.len() - digits;
    let whole = std::str::from_utf8(&kept[..split]).unwrap_or("0");
    let fraction = std::str::from_utf8(&kept[split..]).unwrap_or("");
    let sign = if negative { "-" } else { "" };
    if digits == 0 {
        format!("{sign}{whole}")
    } else {
        format!("{sign}{whole}.{fraction}")
    }
}

/// JavaScript's whitespace set for `String.prototype.trim`: WhiteSpace plus LineTerminator.
/// Unlike Rust's `char::is_whitespace`, it includes U+FEFF and excludes U+0085.
pub fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\u{0009}' | '\u{000B}' | '\u{000C}' | '\u{0020}' | '\u{00A0}' | '\u{FEFF}'
            | '\u{000A}' | '\u{000D}' | '\u{2028}' | '\u{2029}'
            | '\u{1680}' | '\u{2000}'..='\u{200A}' | '\u{202F}' | '\u{205F}' | '\u{3000}'
    )
}

pub fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_whitespace)
}

/// JavaScript's `Number(string)`, held to XEG's domain: the trimmed text is a decimal literal
/// or an unsigned `0x`, `0o`, or `0b` integer, an empty or non-finite result is `None`, and
/// anything else (`Infinity`, digit separators, a signed hex literal) is `None` as JavaScript's
/// `NaN` would be.
pub fn js_string_to_number(text: &str) -> Option<f64> {
    if js_trim(text).is_empty() {
        return None;
    }
    Some(js_number(text)).filter(|n| n.is_finite())
}

/// JavaScript's `Number(string)` exactly: a blank string is `0`, `Infinity` is infinite, and
/// anything that is not a numeric literal is `NaN`.
pub fn js_number(text: &str) -> f64 {
    let trimmed = js_trim(text);
    if trimmed.is_empty() {
        return 0.0;
    }
    let bytes = trimmed.as_bytes();
    if bytes.len() > 2 && bytes[0] == b'0' {
        let radix = match bytes[1] {
            b'x' | b'X' => 16,
            b'o' | b'O' => 8,
            b'b' | b'B' => 2,
            _ => 0,
        };
        if radix != 0 {
            return radix_integer(&trimmed[2..], radix).unwrap_or(f64::NAN);
        }
    }
    match trimmed {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    if !is_decimal_literal(trimmed) {
        return f64::NAN;
    }
    trimmed.parse::<f64>().unwrap_or(f64::NAN)
}

/// An integer in a power-of-two radix, rounded to the nearest double with ties to even, as
/// JavaScript rounds `Number('0x…')` however many digits it has.
fn radix_integer(digits: &str, radix: u32) -> Option<f64> {
    let width = radix.trailing_zeros();
    let mut bits = Vec::with_capacity(digits.len() * width as usize);
    for c in digits.chars() {
        let digit = c.to_digit(radix)?;
        bits.extend((0..width).rev().map(|k| (digit >> k) & 1 == 1));
    }
    let Some(first) = bits.iter().position(|bit| *bit) else {
        return Some(0.0);
    };
    let bits = &bits[first..];
    let fold = |bits: &[bool]| bits.iter().fold(0u64, |acc, bit| (acc << 1) | u64::from(*bit));
    if bits.len() <= 53 {
        return Some(fold(bits) as f64);
    }
    let mut mantissa = fold(&bits[..53]);
    let round = bits[53];
    let sticky = bits[54..].iter().any(|bit| *bit);
    if round && (sticky || mantissa & 1 == 1) {
        mantissa += 1;
    }
    let mut exponent = bits.len() - 53;
    if mantissa == 1 << 53 {
        mantissa >>= 1;
        exponent += 1;
    }
    if exponent > 1024 {
        return Some(f64::INFINITY);
    }
    Some(mantissa as f64 * 2f64.powi(exponent as i32))
}

/// A decimal literal: optional sign, digits with an optional point, optional exponent.
pub fn is_decimal_literal(text: &str) -> bool {
    let bytes = text.as_bytes();
    let mut i = 0;
    if matches!(bytes.first(), Some(b'+' | b'-')) {
        i += 1;
    }
    let int_start = i;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    let int_digits = i - int_start;
    let mut frac_digits = 0;
    if i < bytes.len() && bytes[i] == b'.' {
        i += 1;
        let frac_start = i;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        frac_digits = i - frac_start;
    }
    if int_digits == 0 && frac_digits == 0 {
        return false;
    }
    if i < bytes.len() && (bytes[i] == b'e' || bytes[i] == b'E') {
        i += 1;
        if matches!(bytes.get(i), Some(b'+' | b'-')) {
            i += 1;
        }
        let exp_start = i;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        if i == exp_start {
            return false;
        }
    }
    i == bytes.len()
}

