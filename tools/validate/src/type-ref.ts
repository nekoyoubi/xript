/**
 * The one reading of a manifest `typeRef` that every tool shares.
 *
 * A `typeRef` is either an object (`{ array }`, `{ union }`, `{ map }`, `{ optional }`) or a
 * string. The string form is a small grammar of its own:
 *
 * ```
 * union    := postfix ( "|" postfix )*
 * postfix  := primary ( "[]" | "?" )*
 * primary  := name | "(" union ")"
 * ```
 *
 * `[]` and `?` bind tighter than `|`, so `string | number[]` is a union with an array, and
 * `(string | number)[]` is an array of a union. A string outside that grammar (a generic such as
 * `Record<string, Player>`) is kept whole as an opaque name and emitted verbatim.
 *
 * Validation accepts a handful of loose type words alongside the canonical primitives. Each
 * resolves to one precise meaning here, so `validate`, `typegen`, `docgen`, and `lint` read a
 * manifest the same way. `spec/type-ref-tests.json` pins every rendering.
 */

export type TypeNode =
	| { kind: "name"; name: string }
	| { kind: "array"; element: TypeNode }
	| { kind: "union"; members: TypeNode[] }
	| { kind: "map"; value: TypeNode }
	| { kind: "optional"; inner: TypeNode }
	| { kind: "function" }
	| { kind: "signature"; params: ParameterShape[]; returns?: TypeNode }
	| { kind: "unknown" };

/** The fields of a manifest parameter that shape its rendered type. */
export interface ParameterShape {
	name?: unknown;
	type?: unknown;
	default?: unknown;
	required?: boolean;
	optional?: boolean;
	variadic?: boolean;
}

/**
 * Every name a manifest may use that TypeScript will not accept where a generator writes an
 * identifier: a `declare function`, a `namespace`, or a parameter. Reserved and strict-mode
 * reserved words, the names strict mode forbids as bindings, and the type names a namespace
 * cannot take.
 */
export const UNSAFE_IDENTIFIERS: ReadonlySet<string> = new Set([
	"break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do",
	"else", "enum", "export", "extends", "false", "finally", "for", "function", "if", "import", "in",
	"instanceof", "new", "null", "return", "super", "switch", "this", "throw", "true", "try",
	"typeof", "var", "void", "while", "with", "implements", "interface", "let", "package",
	"private", "protected", "public", "static", "yield", "await", "eval", "arguments",
	"any", "unknown", "never", "string", "number", "boolean", "symbol", "bigint", "object",
	"undefined",
]);

/** True when `name` can stand as a declared identifier in emitted TypeScript. */
export function isSafeIdentifier(name: string): boolean {
	return /^[A-Za-z_$][\w$]*$/.test(name) && !UNSAFE_IDENTIFIERS.has(name);
}

/** A parameter is optional when it has a default, `required: false`, or `optional: true`. */
export function isOptionalParameter(param: ParameterShape): boolean {
	return param.default !== undefined || param.required === false || param.optional === true;
}

/**
 * The identifier each parameter is emitted under. A parameter name is only a label in a
 * signature, so a reserved word gains a trailing underscore and any character an identifier
 * cannot carry becomes one, rather than letting the name break the declaration.
 */
export function parameterIdentifiers(params: readonly ParameterShape[]): string[] {
	const used = new Set<string>();
	return params.map((param) => {
		let id = String(param.name ?? "arg").replace(/[^\w$]/g, "_");
		if (!/^[A-Za-z_$]/.test(id)) id = `_${id}`;
		if (UNSAFE_IDENTIFIERS.has(id)) id = `${id}_`;
		let unique = id;
		for (let n = 2; used.has(unique); n++) unique = `${id}${n}`;
		used.add(unique);
		return unique;
	});
}

/**
 * A parameter list as TypeScript. A variadic last parameter becomes a rest parameter. An
 * optional parameter that a required one follows is written `T | undefined` rather than `?`,
 * since TypeScript refuses a required parameter after an optional one.
 */
export function parametersToTypeScript(params: readonly ParameterShape[]): string {
	const ids = parameterIdentifiers(params);
	let lastRequired = -1;
	params.forEach((param, index) => {
		if (!param.variadic && !isOptionalParameter(param)) lastRequired = index;
	});
	return params
		.map((param, index) => {
			if (param.variadic) return `...${ids[index]}: ${typeRefToRestArray(param.type)}`;
			const type = typeRefToTypeScript(param.type);
			if (!isOptionalParameter(param)) return `${ids[index]}: ${type}`;
			return index < lastRequired ? `${ids[index]}: ${type} | undefined` : `${ids[index]}?: ${type}`;
		})
		.join(", ");
}

/** Type names every manifest may use without declaring them. */
export const PRIMITIVE_TYPE_NAMES: ReadonlySet<string> = new Set([
	"string",
	"number",
	"boolean",
	"void",
	"null",
	"undefined",
	"any",
	"unknown",
]);

/**
 * Accepted type words that are not canonical spellings. `canonical` is the spelling `lint`
 * suggests; `loose` marks a word that names a shape without its element types, which `lint`
 * flags with a suggestion to say what the elements are.
 */
export const TYPE_WORDS: Readonly<Record<string, { canonical: string; loose?: boolean }>> = {
	int: { canonical: "number" },
	integer: { canonical: "number" },
	float: { canonical: "number" },
	bool: { canonical: "boolean" },
	array: { canonical: "T[] or { \"array\": T }", loose: true },
	object: { canonical: "{ \"map\": T } or a declared type", loose: true },
	function: { canonical: "{ \"function\": { \"params\": [...], \"returns\": T } }", loose: true },
};

/** A parameter or export return: a bare `typeRef`, or `{ type, description }`. */
export function returnTypeRef(returns: unknown): unknown {
	if (typeof returns === "object" && returns !== null && !Array.isArray(returns) && "type" in returns) {
		return (returns as { type: unknown }).type;
	}
	return returns;
}

/** The description half of a `{ type, description }` return, when one is given. */
export function returnDescription(returns: unknown): string | undefined {
	if (typeof returns === "object" && returns !== null && !Array.isArray(returns) && "type" in returns) {
		const description = (returns as { description?: unknown }).description;
		return typeof description === "string" ? description : undefined;
	}
	return undefined;
}

type Token = { t: "name"; v: string } | { t: "|" } | { t: "[]" } | { t: "?" } | { t: "(" } | { t: ")" };

function tokenize(source: string): Token[] | null {
	const tokens: Token[] = [];
	let i = 0;
	while (i < source.length) {
		const ch = source[i];
		if (/\s/.test(ch)) {
			i++;
			continue;
		}
		if (ch === "|" || ch === "?" || ch === "(" || ch === ")") {
			tokens.push({ t: ch });
			i++;
			continue;
		}
		if (ch === "[") {
			let j = i + 1;
			while (j < source.length && /\s/.test(source[j])) j++;
			if (source[j] !== "]") return null;
			tokens.push({ t: "[]" });
			i = j + 1;
			continue;
		}
		const match = /^[A-Za-z_$][\w$.]*/.exec(source.slice(i));
		if (!match) return null;
		tokens.push({ t: "name", v: match[0] });
		i += match[0].length;
	}
	return tokens;
}

function parseTypeString(source: string): TypeNode {
	const opaque: TypeNode = { kind: "name", name: source.trim() };
	const tokens = tokenize(source);
	if (!tokens || tokens.length === 0) return opaque;
	let pos = 0;

	const parseUnion = (): TypeNode | null => {
		const members: TypeNode[] = [];
		const first = parsePostfix();
		if (!first) return null;
		members.push(first);
		while (tokens[pos]?.t === "|") {
			pos++;
			const next = parsePostfix();
			if (!next) return null;
			members.push(next);
		}
		return members.length === 1 ? members[0] : { kind: "union", members };
	};

	const parsePostfix = (): TypeNode | null => {
		let node = parsePrimary();
		if (!node) return null;
		for (;;) {
			const token = tokens[pos];
			if (token?.t === "[]") {
				pos++;
				node = { kind: "array", element: node };
			} else if (token?.t === "?") {
				pos++;
				node = { kind: "optional", inner: node };
			} else {
				return node;
			}
		}
	};

	const parsePrimary = (): TypeNode | null => {
		const token = tokens[pos];
		if (token?.t === "name") {
			pos++;
			return { kind: "name", name: token.v };
		}
		if (token?.t === "(") {
			pos++;
			const inner = parseUnion();
			if (!inner || tokens[pos]?.t !== ")") return null;
			pos++;
			return inner;
		}
		return null;
	};

	const parsed = parseUnion();
	if (!parsed || pos !== tokens.length) return opaque;
	return parsed;
}

/** Parses a `typeRef` into its tree, exactly as authored (type words are not yet resolved). */
export function parseTypeRef(ref: unknown): TypeNode {
	if (typeof ref === "string") return parseTypeString(ref);
	if (typeof ref !== "object" || ref === null || Array.isArray(ref)) return { kind: "unknown" };
	const r = ref as { array?: unknown; union?: unknown; map?: unknown; optional?: unknown; function?: unknown };
	if (r.array !== undefined) return { kind: "array", element: parseTypeRef(r.array) };
	if (Array.isArray(r.union)) return { kind: "union", members: r.union.map(parseTypeRef) };
	if (r.map !== undefined) return { kind: "map", value: parseTypeRef(r.map) };
	if (r.optional !== undefined) return { kind: "optional", inner: parseTypeRef(r.optional) };
	if (typeof r.function === "object" && r.function !== null) {
		const signature = r.function as { params?: unknown; returns?: unknown };
		const params = Array.isArray(signature.params)
			? signature.params.filter((param): param is ParameterShape => typeof param === "object" && param !== null)
			: [];
		return {
			kind: "signature",
			params,
			...(signature.returns !== undefined ? { returns: parseTypeRef(signature.returns) } : {}),
		};
	}
	return { kind: "unknown" };
}

/**
 * Resolves every accepted type word to its precise meaning: `int`/`integer`/`float` to `number`,
 * `bool` to `boolean`, `array` to an array of `any`, `object` to a string-keyed map of `any`, and
 * `function` to a callable of any arity.
 */
export function resolveTypeWords(node: TypeNode): TypeNode {
	switch (node.kind) {
		case "name":
			switch (node.name) {
				case "int":
				case "integer":
				case "float":
					return { kind: "name", name: "number" };
				case "bool":
					return { kind: "name", name: "boolean" };
				case "array":
					return { kind: "array", element: { kind: "name", name: "any" } };
				case "object":
					return { kind: "map", value: { kind: "name", name: "any" } };
				case "function":
					return { kind: "function" };
				default:
					return node;
			}
		case "array":
			return { kind: "array", element: resolveTypeWords(node.element) };
		case "union":
			return { kind: "union", members: node.members.map(resolveTypeWords) };
		case "map":
			return { kind: "map", value: resolveTypeWords(node.value) };
		case "optional":
			return { kind: "optional", inner: resolveTypeWords(node.inner) };
		case "signature":
			return node.returns ? { ...node, returns: resolveTypeWords(node.returns) } : node;
		default:
			return node;
	}
}

/** Binding strength of a rendered type: a function type binds loosest, a postfix or name tightest. */
const enum Precedence {
	Function = 0,
	Union = 1,
	Postfix = 2,
}

interface Rendered {
	text: string;
	precedence: Precedence;
}

interface Style {
	name(name: string): string;
	fn: string;
	pipe: string;
	map(value: string): string;
	/** A whole TypeScript type kept as one unit: verbatim in code, one escaped code span in markdown. */
	code(text: string): string;
}

const TYPESCRIPT_STYLE: Style = {
	name: (name) => name,
	fn: "(...args: any[]) => any",
	pipe: " | ",
	map: (value) => `Record<string, ${value}>`,
	code: (text) => text,
};

const MARKDOWN_STYLE: Style = {
	name: (name) => `\`${name}\``,
	fn: "`(...args: any[]) => any`",
	pipe: " \\| ",
	map: (value) => `Record<string, ${value}>`,
	code: (text) => `\`${text.replace(/\|/g, "\\|")}\``,
};

function wrap(rendered: Rendered, minimum: Precedence): string {
	return rendered.precedence < minimum ? `(${rendered.text})` : rendered.text;
}

function render(node: TypeNode, style: Style): Rendered {
	switch (node.kind) {
		case "name":
			return { text: style.name(node.name), precedence: Precedence.Postfix };
		case "function":
			return { text: style.fn, precedence: Precedence.Function };
		case "signature": {
			const returns = node.returns ? render(node.returns, TYPESCRIPT_STYLE).text : "void";
			return { text: style.code(`(${parametersToTypeScript(node.params)}) => ${returns}`), precedence: Precedence.Function };
		}
		case "array":
			return { text: `${wrap(render(node.element, style), Precedence.Postfix)}[]`, precedence: Precedence.Postfix };
		case "map":
			return { text: style.map(render(node.value, style).text), precedence: Precedence.Postfix };
		case "union":
			return {
				text: node.members.map((member) => wrap(render(member, style), Precedence.Union)).join(style.pipe),
				precedence: Precedence.Union,
			};
		case "optional":
			return {
				text: `${wrap(render(node.inner, style), Precedence.Union)}${style.pipe}${style.name("undefined")}`,
				precedence: Precedence.Union,
			};
		default:
			return { text: style.name("unknown"), precedence: Precedence.Postfix };
	}
}

/** The TypeScript a `typeRef` denotes, with every accepted type word resolved. */
export function typeRefToTypeScript(ref: unknown): string {
	return render(resolveTypeWords(parseTypeRef(ref)), TYPESCRIPT_STYLE).text;
}

/** The TypeScript for the element type of a rest parameter: `T` in `...name: T[]`. */
export function typeRefToRestArray(ref: unknown): string {
	return render({ kind: "array", element: resolveTypeWords(parseTypeRef(ref)) }, TYPESCRIPT_STYLE).text;
}

/** A `typeRef` for a markdown table cell: names backticked, pipes escaped. */
export function typeRefToMarkdown(ref: unknown): string {
	return render(resolveTypeWords(parseTypeRef(ref)), MARKDOWN_STYLE).text;
}

/** The custom type names a `typeRef` bottoms out in, after type words resolve. */
export function typeRefNames(ref: unknown): Set<string> {
	const names = new Set<string>();
	const walk = (node: TypeNode): void => {
		switch (node.kind) {
			case "name":
				if (!PRIMITIVE_TYPE_NAMES.has(node.name)) names.add(node.name);
				return;
			case "array":
				return walk(node.element);
			case "union":
				return node.members.forEach(walk);
			case "map":
				return walk(node.value);
			case "optional":
				return walk(node.inner);
			case "signature":
				for (const param of node.params) for (const name of typeRefNames(param.type)) names.add(name);
				if (node.returns) walk(node.returns);
				return;
			default:
				return;
		}
	};
	walk(resolveTypeWords(parseTypeRef(ref)));
	return names;
}

/** A type spelling `lint` would suggest replacing, with the spelling it suggests. */
export interface TypeSpelling {
	/** The authored spelling. */
	word: string;
	/** The suggested spelling. */
	canonical: string;
	/** True when the word names a shape without its element types. */
	loose: boolean;
}

/**
 * Every non-canonical spelling inside a `typeRef`: the accepted type words, and the `T?` string
 * suffix, whose canonical form is `{ "optional": T }`.
 */
export function nonCanonicalSpellings(ref: unknown): TypeSpelling[] {
	const found: TypeSpelling[] = [];
	const walk = (node: TypeNode): void => {
		switch (node.kind) {
			case "name": {
				const word = TYPE_WORDS[node.name];
				if (word) found.push({ word: node.name, canonical: word.canonical, loose: word.loose === true });
				return;
			}
			case "array":
				return walk(node.element);
			case "union":
				return node.members.forEach(walk);
			case "map":
				return walk(node.value);
			case "optional":
				return walk(node.inner);
			case "signature":
				for (const param of node.params) found.push(...nonCanonicalSpellings(param.type));
				if (node.returns) walk(node.returns);
				return;
			default:
				return;
		}
	};
	walk(parseTypeRef(ref));
	if (typeof ref === "string" && /\?/.test(ref)) {
		found.push({ word: "T?", canonical: "{ \"optional\": T }", loose: false });
	}
	const visitObject = (value: unknown): void => {
		if (typeof value === "string") {
			if (value !== ref && /\?/.test(value)) found.push({ word: "T?", canonical: "{ \"optional\": T }", loose: false });
			return;
		}
		if (typeof value !== "object" || value === null) return;
		const node = value as { array?: unknown; union?: unknown; map?: unknown; optional?: unknown; function?: { returns?: unknown } };
		for (const child of [node.array, node.map, node.optional, node.function?.returns]) visitObject(child);
		if (Array.isArray(node.union)) node.union.forEach(visitObject);
	};
	if (typeof ref === "object") visitObject(ref);
	return found;
}
