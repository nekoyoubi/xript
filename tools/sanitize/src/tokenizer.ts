export interface Attribute {
	name: string;
	value: string;
}

const REPLACEMENT_CHARACTER = "\uFFFD";

/**
 * A raw U+0000 is a parse error wherever it appears. In a tag name, an attribute
 * name, or an attribute value the parser substitutes U+FFFD; in ordinary text the
 * tree builder discards the character outright, which is why the two helpers
 * differ. A character reference that resolves to U+0000 is not raw and always
 * becomes U+FFFD, so entity decoding runs after the raw pass.
 */
function replaceNulls(text: string): string {
	return text.replace(/\u0000/g, REPLACEMENT_CHARACTER);
}

function dropNulls(text: string): string {
	return text.replace(/\u0000/g, "");
}

const NAMED_ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
};

/**
 * Decodes character references so a text token or attribute value carries real
 * characters rather than their encoded form. The tree is the canonical
 * representation and the serializer escapes on the way out, so leaving
 * references encoded here would double-escape them on a round trip.
 *
 * Decoding is safe precisely because the result lands in a text node or an
 * attribute value: it is re-escaped when serialized and never reinterpreted as
 * markup. It also hardens the sink checks, which run against the decoded value
 * and so can no longer be walked past with an encoded `javascript&#58;`.
 */
export function decodeEntities(text: string): string {
	if (!text.includes("&")) return text;
	return text.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
		if (body[0] === "#") {
			const codePoint =
				body[1] === "x" || body[1] === "X"
					? Number.parseInt(body.slice(2), 16)
					: Number.parseInt(body.slice(1), 10);
			if (!Number.isFinite(codePoint) || codePoint > 0x10ffff) return match;
			if (codePoint === 0) return REPLACEMENT_CHARACTER;
			try {
				return String.fromCodePoint(codePoint);
			} catch {
				return match;
			}
		}
		const named = NAMED_ENTITIES[body.toLowerCase()];
		return named === undefined ? match : named;
	});
}

export type Token =
	| { type: "text"; value: string }
	| { type: "open"; tag: string; rawTag: string; attributes: Attribute[]; selfClosing: boolean }
	| { type: "close"; tag: string; rawTag: string }
	| { type: "comment"; value: string };

export function tokenize(html: string): Token[] {
	const tokens: Token[] = [];
	let i = 0;

	while (i < html.length) {
		if (html[i] === "<") {
			if (html.startsWith("<!--", i)) {
				const end = html.indexOf("-->", i + 4);
				if (end === -1) {
					tokens.push({ type: "comment", value: html.slice(i + 4) });
					break;
				}
				tokens.push({ type: "comment", value: html.slice(i + 4, end) });
				i = end + 3;
				continue;
			}

			if (html[i + 1] === "/") {
				const end = html.indexOf(">", i + 2);
				if (end === -1) {
					tokens.push({ type: "text", value: decodeEntities(dropNulls(html.slice(i))) });
					break;
				}
				const rawTag = replaceNulls(html.slice(i + 2, end).trim());
				tokens.push({ type: "close", tag: rawTag.toLowerCase(), rawTag });
				i = end + 1;
				continue;
			}

			const result = parseOpenTag(html, i);
			if (result) {
				tokens.push(result.token);
				i = result.end;
				continue;
			}

			tokens.push({ type: "text", value: "<" });
			i++;
		} else {
			let end = html.indexOf("<", i);
			if (end === -1) end = html.length;
			tokens.push({ type: "text", value: decodeEntities(dropNulls(html.slice(i, end))) });
			i = end;
		}
	}

	return tokens;
}

function parseOpenTag(html: string, start: number): { token: Token; end: number } | null {
	let i = start + 1;

	while (i < html.length && /\s/.test(html[i])) i++;

	const tagStart = i;
	while (i < html.length && (/[A-Za-z0-9_.:-]/.test(html[i]) || (html[i] === "\u0000" && i > tagStart))) i++;
	const rawTag = replaceNulls(html.slice(tagStart, i));
	const tag = rawTag.toLowerCase();

	if (!tag) return null;

	const attributes: Attribute[] = [];

	while (i < html.length) {
		while (i < html.length && /\s/.test(html[i])) i++;

		if (i >= html.length) break;

		if (html[i] === ">") {
			return { token: { type: "open", tag, rawTag, attributes, selfClosing: false }, end: i + 1 };
		}

		if (html[i] === "/" && html[i + 1] === ">") {
			return { token: { type: "open", tag, rawTag, attributes, selfClosing: true }, end: i + 2 };
		}

		const attrResult = parseAttribute(html, i);
		if (attrResult) {
			attributes.push(attrResult.attribute);
			i = attrResult.end;
		} else {
			i++;
		}
	}

	return { token: { type: "open", tag, rawTag, attributes, selfClosing: false }, end: i };
}

function parseAttribute(html: string, start: number): { attribute: Attribute; end: number } | null {
	let i = start;

	const nameStart = i;
	while (i < html.length && /[^\s=/>]/.test(html[i])) i++;
	const name = replaceNulls(html.slice(nameStart, i));
	if (!name) return null;

	while (i < html.length && /\s/.test(html[i])) i++;

	if (html[i] !== "=") {
		return { attribute: { name, value: "" }, end: i };
	}

	i++;
	while (i < html.length && /\s/.test(html[i])) i++;

	let value: string;

	if (html[i] === '"') {
		i++;
		const valStart = i;
		while (i < html.length && html[i] !== '"') i++;
		value = html.slice(valStart, i);
		if (i < html.length) i++;
	} else if (html[i] === "'") {
		i++;
		const valStart = i;
		while (i < html.length && html[i] !== "'") i++;
		value = html.slice(valStart, i);
		if (i < html.length) i++;
	} else {
		const valStart = i;
		while (i < html.length && /[^\s>]/.test(html[i])) i++;
		value = html.slice(valStart, i);
	}

	return { attribute: { name, value: decodeEntities(replaceNulls(value)) }, end: i };
}
