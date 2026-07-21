//! A port of the canonical HTML tokenizer.
//!
//! It is deliberately not a spec-conformant HTML parser: it is the exact
//! tokenizer every other xript runtime uses, so that a fragment tokenizes
//! identically wherever it is mounted. Attribute names keep their source case;
//! text content has its character references decoded, so a text node carries
//! real characters and the serializer's escaping round-trips.

use std::sync::LazyLock;

use regex::Regex;

static ENTITY_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);").unwrap()
});

const REPLACEMENT_CHARACTER: &str = "\u{fffd}";

/// A raw U+0000 is a parse error wherever it appears. In a tag name, an attribute
/// name, or an attribute value the parser substitutes U+FFFD; in ordinary text the
/// tree builder discards the character outright, which is why the two helpers
/// differ. A character reference that resolves to U+0000 is not raw and always
/// becomes U+FFFD, so entity decoding runs after the raw pass.
fn replace_nulls(text: &str) -> String {
    text.replace('\0', REPLACEMENT_CHARACTER)
}

fn drop_nulls(text: &str) -> String {
    text.replace('\0', "")
}

fn named_entity(name: &str) -> Option<&'static str> {
    match name.to_ascii_lowercase().as_str() {
        "amp" => Some("&"),
        "lt" => Some("<"),
        "gt" => Some(">"),
        "quot" => Some("\""),
        "apos" => Some("'"),
        "nbsp" => Some("\u{a0}"),
        _ => None,
    }
}

/// Decodes character references so a text token carries real characters rather
/// than their encoded form. Leaving them encoded would double-escape on a round
/// trip, since the serializer escapes text on the way out.
///
/// Decoding is safe because the result lands in a text node: it is re-escaped
/// when serialized and never reinterpreted as markup.
pub fn decode_text_entities(text: &str) -> String {
    if !text.contains('&') {
        return text.to_string();
    }
    ENTITY_PATTERN
        .replace_all(text, |caps: &regex::Captures| {
            let body = &caps[1];
            if let Some(rest) = body.strip_prefix('#') {
                let (digits, radix) = match rest.strip_prefix(['x', 'X']) {
                    Some(hex) => (hex, 16),
                    None => (rest, 10),
                };
                let Ok(code_point) = u32::from_str_radix(digits, radix) else {
                    return caps[0].to_string();
                };
                if code_point == 0 {
                    return REPLACEMENT_CHARACTER.to_string();
                }
                return match char::from_u32(code_point) {
                    Some(character) => character.to_string(),
                    None => caps[0].to_string(),
                };
            }
            named_entity(body).map(str::to_string).unwrap_or_else(|| caps[0].to_string())
        })
        .into_owned()
}

#[derive(Debug, Clone, PartialEq)]
pub struct Attribute {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Token {
    Text {
        value: String,
    },
    Open {
        tag: String,
        raw_tag: String,
        attributes: Vec<Attribute>,
        self_closing: bool,
    },
    Close {
        tag: String,
        #[allow(dead_code)]
        raw_tag: String,
    },
    Comment {
        #[allow(dead_code)]
        value: String,
    },
}

fn is_js_whitespace(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}

fn slice(chars: &[char], start: usize, end: usize) -> String {
    chars[start.min(chars.len())..end.min(chars.len())].iter().collect()
}

fn find_from(chars: &[char], needle: &[char], start: usize) -> Option<usize> {
    if needle.is_empty() || needle.len() > chars.len() {
        return None;
    }
    (start..=chars.len() - needle.len()).find(|&i| &chars[i..i + needle.len()] == needle)
}

pub fn tokenize(html: &str) -> Vec<Token> {
    let chars: Vec<char> = html.chars().collect();
    let mut tokens = Vec::new();
    let mut i = 0usize;

    while i < chars.len() {
        if chars[i] == '<' {
            if chars[i..].starts_with(&['<', '!', '-', '-']) {
                match find_from(&chars, &['-', '-', '>'], i + 4) {
                    None => {
                        tokens.push(Token::Comment { value: slice(&chars, i + 4, chars.len()) });
                        break;
                    }
                    Some(end) => {
                        tokens.push(Token::Comment { value: slice(&chars, i + 4, end) });
                        i = end + 3;
                        continue;
                    }
                }
            }

            if chars.get(i + 1) == Some(&'/') {
                match find_from(&chars, &['>'], i + 2) {
                    None => {
                        tokens.push(Token::Text {
                            value: decode_text_entities(&drop_nulls(&slice(&chars, i, chars.len()))),
                        });
                        break;
                    }
                    Some(end) => {
                        let raw_tag = replace_nulls(slice(&chars, i + 2, end).trim());
                        tokens.push(Token::Close { tag: raw_tag.to_lowercase(), raw_tag });
                        i = end + 1;
                        continue;
                    }
                }
            }

            if let Some((token, end)) = parse_open_tag(&chars, i) {
                tokens.push(token);
                i = end;
                continue;
            }

            tokens.push(Token::Text { value: "<".to_string() });
            i += 1;
        } else {
            let end = find_from(&chars, &['<'], i).unwrap_or(chars.len());
            tokens.push(Token::Text { value: decode_text_entities(&drop_nulls(&slice(&chars, i, end))) });
            i = end;
        }
    }

    tokens
}

fn parse_open_tag(chars: &[char], start: usize) -> Option<(Token, usize)> {
    let mut i = start + 1;

    while i < chars.len() && is_js_whitespace(chars[i]) {
        i += 1;
    }

    let tag_start = i;
    while i < chars.len()
        && (chars[i].is_ascii_alphanumeric()
            || matches!(chars[i], '_' | '.' | ':' | '-')
            || (chars[i] == '\0' && i > tag_start))
    {
        i += 1;
    }
    let raw_tag = replace_nulls(&slice(chars, tag_start, i));
    let tag = raw_tag.to_lowercase();

    if tag.is_empty() {
        return None;
    }

    let mut attributes = Vec::new();

    while i < chars.len() {
        while i < chars.len() && is_js_whitespace(chars[i]) {
            i += 1;
        }

        if i >= chars.len() {
            break;
        }

        if chars[i] == '>' {
            return Some((Token::Open { tag, raw_tag, attributes, self_closing: false }, i + 1));
        }

        if chars[i] == '/' && chars.get(i + 1) == Some(&'>') {
            return Some((Token::Open { tag, raw_tag, attributes, self_closing: true }, i + 2));
        }

        match parse_attribute(chars, i) {
            Some((attribute, end)) => {
                attributes.push(attribute);
                i = end;
            }
            None => i += 1,
        }
    }

    Some((Token::Open { tag, raw_tag, attributes, self_closing: false }, i))
}

fn parse_attribute(chars: &[char], start: usize) -> Option<(Attribute, usize)> {
    let mut i = start;

    let name_start = i;
    while i < chars.len() && !is_js_whitespace(chars[i]) && !matches!(chars[i], '=' | '/' | '>') {
        i += 1;
    }
    let name = replace_nulls(&slice(chars, name_start, i));
    if name.is_empty() {
        return None;
    }

    while i < chars.len() && is_js_whitespace(chars[i]) {
        i += 1;
    }

    if chars.get(i) != Some(&'=') {
        return Some((Attribute { name, value: String::new() }, i));
    }

    i += 1;
    while i < chars.len() && is_js_whitespace(chars[i]) {
        i += 1;
    }

    let value = match chars.get(i) {
        Some('"') | Some('\'') => {
            let quote = chars[i];
            i += 1;
            let value_start = i;
            while i < chars.len() && chars[i] != quote {
                i += 1;
            }
            let value = slice(chars, value_start, i);
            if i < chars.len() {
                i += 1;
            }
            value
        }
        _ => {
            let value_start = i;
            while i < chars.len() && !is_js_whitespace(chars[i]) && chars[i] != '>' {
                i += 1;
            }
            slice(chars, value_start, i)
        }
    };

    Some((Attribute { name, value: replace_nulls(&value) }, i))
}
