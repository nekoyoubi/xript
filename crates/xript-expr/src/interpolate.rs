use crate::parser::parse;

/// A piece of a segmented text node.
///
/// There is no third variant, and there never will be: a segment lives inside a text node,
/// which has no props and no children, so a resolved value has nowhere to land that would
/// make it markup.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TextSegment {
    Literal(String),
    Expr(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SegmentIssue {
    /// Byte offset into the text node's source.
    pub position: usize,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SegmentResult {
    /// `None` when the scan changed nothing — the node stays byte-identical.
    pub segments: Option<Vec<TextSegment>>,
    pub issues: Vec<SegmentIssue>,
}

const OPEN: &str = "{{";
const CLOSE: &str = "}}";
const ESCAPE: &str = "\\{{";

/// Segments a text node's content into literal and expression pieces.
///
/// The rules, in order:
///
/// 1. `\{{` emits a literal `{{` and consumes the backslash. It is the *only* escape
///    sequence, so `C:\Users` and a `\n` in a code sample are untouched.
/// 2. Otherwise `{{` opens a site, which closes at the first `}}`.
/// 3. An *unclosed* `{{` is literal text, not an error. Prose that says "write `{{` to
///    interpolate" and never closes it survives intact.
/// 4. `}}` outside a site is literal.
/// 5. Single `{` and `}` are never special, anywhere.
/// 6. A site that opens *and closes* but whose body is not an XEG expression is an error:
///    once both delimiters are present the author's intent is unambiguous.
pub fn segment_text(text: &str) -> SegmentResult {
    let mut segments: Vec<TextSegment> = Vec::new();
    let mut issues: Vec<SegmentIssue> = Vec::new();
    let mut literal = String::new();
    let mut changed = false;
    let mut i = 0usize;

    while i < text.len() {
        if text[i..].starts_with(ESCAPE) {
            literal.push_str(OPEN);
            changed = true;
            i += ESCAPE.len();
            continue;
        }

        if !text[i..].starts_with(OPEN) {
            let ch = text[i..].chars().next().unwrap();
            literal.push(ch);
            i += ch.len_utf8();
            continue;
        }

        let rest = &text[i + OPEN.len()..];
        let close = match rest.find(CLOSE) {
            Some(offset) => offset,
            None => {
                literal.push_str(OPEN);
                i += OPEN.len();
                continue;
            }
        };

        let body = &rest[..close];
        changed = true;

        if body.contains(OPEN) {
            issues.push(SegmentIssue {
                position: i,
                message: "nested '{{' inside an interpolation site".to_string(),
            });
        } else if let Err(err) = parse(body.trim()) {
            issues.push(SegmentIssue {
                position: i + OPEN.len() + err.position,
                message: err.message,
            });
        }

        if !literal.is_empty() {
            segments.push(TextSegment::Literal(std::mem::take(&mut literal)));
        }
        segments.push(TextSegment::Expr(body.trim().to_string()));
        i += OPEN.len() + close + CLOSE.len();
    }

    if !changed {
        return SegmentResult { segments: None, issues };
    }

    if !literal.is_empty() {
        segments.push(TextSegment::Literal(literal));
    }

    SegmentResult { segments: Some(segments), issues }
}

/// Whether a text node could open a site at all. Cheap enough to run over every text node
/// before doing the segmenting scan.
pub fn contains_interpolation(text: &str) -> bool {
    text.contains(OPEN)
}

/// Resolves segments to their rendered text.
///
/// Every piece joins as plain text. The tokenizer is never re-entered, so a value that
/// itself contains `{{` or a tag is inert.
pub fn resolve_segments(segments: &[TextSegment], bindings: &crate::eval::Bindings) -> String {
    let mut out = String::new();
    for segment in segments {
        match segment {
            TextSegment::Literal(text) => out.push_str(text),
            TextSegment::Expr(source) => {
                out.push_str(&crate::value::render(&crate::evaluate(source, bindings)))
            }
        }
    }
    out
}

/// Re-serializes segments back to their authored source. Used to assert round-trip
/// fidelity; a tree's stored text is the authoritative source string.
pub fn segments_to_source(segments: &[TextSegment]) -> String {
    let mut out = String::new();
    for segment in segments {
        match segment {
            TextSegment::Literal(text) => out.push_str(&text.replace(OPEN, ESCAPE)),
            TextSegment::Expr(source) => out.push_str(&format!("{{{{ {source} }}}}")),
        }
    }
    out
}
