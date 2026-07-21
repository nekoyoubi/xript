import { parseExpression, ExpressionError, type ParsedExpression } from "./expr.js";

/**
 * A piece of a segmented text node. A `literal` carries text verbatim; an `expr` carries
 * an XEG source string that the bind pass resolves to a value.
 *
 * There is no third variant, and there never will be: a segment lives inside a
 * `FragmentText`, which has no props and no children, so a resolved value has nowhere to
 * land that would make it markup.
 */
export type TextSegment =
	| { kind: "literal"; value: string }
	| { kind: "expr"; source: string };

export interface SegmentIssue {
	/** Character offset into the text node's source. */
	position: number;
	message: string;
}

export interface SegmentResult {
	/** `null` when the text opened no interpolation site — the node stays byte-identical. */
	segments: TextSegment[] | null;
	issues: SegmentIssue[];
}

const OPEN = "{{";
const CLOSE = "}}";
const ESCAPE = "\\{{";

/**
 * Segments a text node's decoded content into literal and expression pieces.
 *
 * The rules, in order:
 *
 * 1. `\{{` emits a literal `{{` and consumes the backslash. It is the *only* escape
 *    sequence, so `C:\Users` and a `\n` in a code sample are untouched.
 * 2. Otherwise `{{` opens a site, which closes at the first `}}`.
 * 3. An *unclosed* `{{` is literal text, not an error — prose that says "write `{{` to
 *    interpolate" and never closes it survives intact.
 * 4. `}}` outside a site is literal.
 * 5. Single `{` and `}` are never special, anywhere.
 * 6. A site that opens *and closes* but whose body is not an XEG expression is an error:
 *    once both delimiters are present the author's intent is unambiguous, so failing
 *    loudly beats guessing.
 */
export function segmentText(text: string): SegmentResult {
	const segments: TextSegment[] = [];
	const issues: SegmentIssue[] = [];
	let literal = "";
	/**
	 * Whether the scan changed anything. Set by an opened site *and* by a consumed
	 * escape: an escaped delimiter also makes the rendered text differ from `value`, and
	 * a consumer that fell back to `value` would render the backslash.
	 */
	let opened = false;
	let i = 0;

	const flush = (): void => {
		if (literal !== "") {
			segments.push({ kind: "literal", value: literal });
			literal = "";
		}
	};

	while (i < text.length) {
		if (text.startsWith(ESCAPE, i)) {
			literal += OPEN;
			opened = true;
			i += ESCAPE.length;
			continue;
		}

		if (!text.startsWith(OPEN, i)) {
			literal += text[i];
			i++;
			continue;
		}

		const close = text.indexOf(CLOSE, i + OPEN.length);
		if (close === -1) {
			literal += OPEN;
			i += OPEN.length;
			continue;
		}

		const body = text.slice(i + OPEN.length, close);
		opened = true;

		if (body.includes(OPEN)) {
			issues.push({ position: i, message: "nested '{{' inside an interpolation site" });
			flush();
			segments.push({ kind: "expr", source: body.trim() });
			i = close + CLOSE.length;
			continue;
		}

		const source = body.trim();
		try {
			parseExpression(source);
		} catch (err) {
			if (err instanceof ExpressionError) {
				issues.push({ position: i + OPEN.length + err.position, message: err.message });
			} else throw err;
		}

		flush();
		segments.push({ kind: "expr", source });
		i = close + CLOSE.length;
	}

	if (!opened) return { segments: null, issues };
	flush();
	return { segments, issues };
}

/**
 * Whether a text node's source could open an interpolation site at all. Cheap enough to
 * run over every text node before doing the segmenting scan.
 */
export function containsInterpolation(text: string): boolean {
	return text.includes(OPEN);
}

/**
 * Re-serializes segments back to their authored source. Used only to assert round-trip
 * fidelity; the tree's `value` is the authoritative source string.
 */
export function segmentsToSource(segments: readonly TextSegment[]): string {
	return segments
		.map((segment) => (segment.kind === "literal"
			? segment.value.split(OPEN).join(ESCAPE)
			: `{{ ${segment.source} }}`))
		.join("");
}

export type { ParsedExpression };
