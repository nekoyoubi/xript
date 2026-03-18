export interface Attribute {
	name: string;
	value: string;
}

export type Token =
	| { type: "text"; value: string }
	| { type: "open"; tag: string; attributes: Attribute[]; selfClosing: boolean }
	| { type: "close"; tag: string }
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
					tokens.push({ type: "text", value: html.slice(i) });
					break;
				}
				const tag = html.slice(i + 2, end).trim().toLowerCase();
				tokens.push({ type: "close", tag });
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
			tokens.push({ type: "text", value: html.slice(i, end) });
			i = end;
		}
	}

	return tokens;
}

function parseOpenTag(html: string, start: number): { token: Token; end: number } | null {
	let i = start + 1;

	while (i < html.length && /\s/.test(html[i])) i++;

	const tagStart = i;
	while (i < html.length && /[a-zA-Z0-9-]/.test(html[i])) i++;
	const tag = html.slice(tagStart, i).toLowerCase();

	if (!tag) return null;

	const attributes: Attribute[] = [];

	while (i < html.length) {
		while (i < html.length && /\s/.test(html[i])) i++;

		if (i >= html.length) break;

		if (html[i] === ">") {
			return { token: { type: "open", tag, attributes, selfClosing: false }, end: i + 1 };
		}

		if (html[i] === "/" && html[i + 1] === ">") {
			return { token: { type: "open", tag, attributes, selfClosing: true }, end: i + 2 };
		}

		const attrResult = parseAttribute(html, i);
		if (attrResult) {
			attributes.push(attrResult.attribute);
			i = attrResult.end;
		} else {
			i++;
		}
	}

	return { token: { type: "open", tag, attributes, selfClosing: false }, end: i };
}

function parseAttribute(html: string, start: number): { attribute: Attribute; end: number } | null {
	let i = start;

	const nameStart = i;
	while (i < html.length && /[^\s=/>]/.test(html[i])) i++;
	const name = html.slice(nameStart, i);
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

	return { attribute: { name, value }, end: i };
}
