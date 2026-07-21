/**
 * XEG — the xript Expression Grammar.
 *
 * One total, pure expression language shared by `data-if`, `data-bind`, and inline
 * `{{ … }}` interpolation. Identifiers resolve only against a fill's declared bindings
 * and calls resolve only against the closed builtin table, so no production names a host
 * global and no evaluation reaches a value's methods. There is no code generation
 * anywhere in the pipeline: the parser produces an AST and the evaluator walks it.
 *
 * Semantics are pinned by `spec/expression-tests.json`, not by "whatever JavaScript does".
 */

export type ExprValue =
	| string
	| number
	| boolean
	| null
	| ExprValue[]
	| { [key: string]: ExprValue };

export type ExprAst =
	| { t: "num"; v: number }
	| { t: "str"; v: string }
	| { t: "bool"; v: boolean }
	| { t: "null" }
	| { t: "name"; name: string }
	| { t: "member"; obj: ExprAst; name: string }
	| { t: "index"; obj: ExprAst; index: ExprAst }
	| { t: "unary"; op: "!" | "-" | "+"; arg: ExprAst }
	| { t: "binary"; op: BinaryOp; left: ExprAst; right: ExprAst }
	| { t: "logical"; op: "&&" | "||" | "??"; left: ExprAst; right: ExprAst }
	| { t: "cond"; test: ExprAst; cons: ExprAst; alt: ExprAst }
	| { t: "call"; name: string; args: ExprAst[] };

export type BinaryOp =
	| "==" | "!=" | "<" | "<=" | ">" | ">="
	| "+" | "-" | "*" | "/" | "%";

/** The classification that decides whether a `data-bind` target is writable. */
export type ExpressionKind = "name" | "expression";

export interface ParsedExpression {
	/** The authored source, verbatim. */
	source: string;
	kind: ExpressionKind;
	ast: ExprAst;
	/** Every identifier the expression reads, in first-appearance order. */
	names: string[];
	nodeCount: number;
}

export class ExpressionError extends Error {
	readonly source: string;
	readonly position: number;

	constructor(source: string, position: number, message: string) {
		super(message);
		this.name = "ExpressionError";
		this.source = source;
		this.position = position;
	}
}

export interface ParseExpressionOptions {
	/** Hard cap on AST size, so evaluation cost is bounded at parse time. */
	maxExpressionNodes?: number;
}

export const DEFAULT_MAX_EXPRESSION_NODES = 256;

/**
 * Builtin call arity, as `[min, max]`. `Infinity` marks a variadic tail.
 * A builtin is not a capability channel: the table is closed and extended only by
 * spec revision, so a host cannot register one.
 */
export const BUILTINS: Readonly<Record<string, readonly [number, number]>> = Object.freeze({
	abs: [1, 1],
	round: [1, 1],
	floor: [1, 1],
	ceil: [1, 1],
	min: [1, Infinity],
	max: [1, Infinity],
	clamp: [3, 3],
	fixed: [2, 2],
	upper: [1, 1],
	lower: [1, 1],
	trim: [1, 1],
	pad: [2, 3],
	slice: [2, 3],
	len: [1, 1],
	has: [2, 2],
	join: [1, 2],
	at: [2, 2],
	str: [1, 1],
	num: [1, 1],
	bool: [1, 1],
});

export const BUILTIN_NAMES: readonly string[] = Object.freeze(Object.keys(BUILTINS));

/**
 * Words the grammar refuses as identifiers. Each names a JavaScript capability XEG
 * does not have; rejecting them by name makes the error say so instead of surfacing
 * as an anonymous syntax error two tokens later.
 */
const RESERVED_WORDS = new Set([
	"function", "return", "var", "let", "const", "new", "delete", "typeof", "void",
	"in", "instanceof", "this", "class", "import", "export", "await", "yield",
	"if", "else", "for", "while", "do", "switch", "case", "try", "catch", "throw",
	"undefined", "globalThis", "eval", "arguments",
]);

type TokenType = "num" | "str" | "name" | "punct" | "eof";

interface Token {
	type: TokenType;
	value: string;
	num?: number;
	str?: string;
	pos: number;
}

const PUNCT_3 = ["===", "!=="];
const PUNCT_2 = ["==", "!=", "<=", ">=", "&&", "||", "??"];
const PUNCT_1 = ["<", ">", "+", "-", "*", "/", "%", "!", "?", ":", "(", ")", "[", "]", ",", "."];

function isIdentStart(ch: string): boolean {
	return /[A-Za-z_$]/.test(ch);
}

function isIdentPart(ch: string): boolean {
	return /[A-Za-z0-9_$]/.test(ch);
}

function tokenize(source: string): Token[] {
	const tokens: Token[] = [];
	let i = 0;

	const fail = (pos: number, message: string): never => {
		throw new ExpressionError(source, pos, message);
	};

	while (i < source.length) {
		const ch = source[i];

		if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\v") {
			i++;
			continue;
		}

		if (ch >= "0" && ch <= "9") {
			const start = i;
			while (i < source.length && source[i] >= "0" && source[i] <= "9") i++;
			if (source[i] === "." && source[i + 1] >= "0" && source[i + 1] <= "9") {
				i++;
				while (i < source.length && source[i] >= "0" && source[i] <= "9") i++;
			}
			if (source[i] === "e" || source[i] === "E") {
				let j = i + 1;
				if (source[j] === "+" || source[j] === "-") j++;
				if (source[j] >= "0" && source[j] <= "9") {
					i = j;
					while (i < source.length && source[i] >= "0" && source[i] <= "9") i++;
				}
			}
			const text = source.slice(start, i);
			tokens.push({ type: "num", value: text, num: Number(text), pos: start });
			continue;
		}

		if (ch === "." && source[i + 1] >= "0" && source[i + 1] <= "9") {
			const start = i;
			i++;
			while (i < source.length && source[i] >= "0" && source[i] <= "9") i++;
			const text = source.slice(start, i);
			tokens.push({ type: "num", value: text, num: Number(text), pos: start });
			continue;
		}

		if (ch === '"' || ch === "'") {
			const start = i;
			const quote = ch;
			i++;
			let out = "";
			while (i < source.length && source[i] !== quote) {
				if (source[i] === "\\") {
					i++;
					const esc = source[i];
					if (esc === undefined) fail(start, "unterminated string literal");
					if (esc === "n") out += "\n";
					else if (esc === "t") out += "\t";
					else if (esc === "r") out += "\r";
					else if (esc === "b") out += "\b";
					else if (esc === "f") out += "\f";
					else if (esc === "0") out += "\0";
					else if (esc === "u") {
						const hex = source.slice(i + 1, i + 5);
						if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail(i, "invalid unicode escape");
						out += String.fromCharCode(parseInt(hex, 16));
						i += 4;
					} else out += esc;
					i++;
					continue;
				}
				if (source[i] === "\n") fail(start, "unterminated string literal");
				out += source[i];
				i++;
			}
			if (i >= source.length) fail(start, "unterminated string literal");
			i++;
			tokens.push({ type: "str", value: source.slice(start, i), str: out, pos: start });
			continue;
		}

		if (isIdentStart(ch)) {
			const start = i;
			while (i < source.length && isIdentPart(source[i])) i++;
			tokens.push({ type: "name", value: source.slice(start, i), pos: start });
			continue;
		}

		const three = source.slice(i, i + 3);
		if (PUNCT_3.includes(three)) {
			tokens.push({ type: "punct", value: three === "===" ? "==" : "!=", pos: i });
			i += 3;
			continue;
		}

		const two = source.slice(i, i + 2);
		if (PUNCT_2.includes(two)) {
			tokens.push({ type: "punct", value: two, pos: i });
			i += 2;
			continue;
		}

		if (two === "++" || two === "--") fail(i, `'${two}' is not part of the xript expression grammar`);
		if (two === "=>") fail(i, "arrow functions are not part of the xript expression grammar");
		if (two === "?." ) fail(i, "optional chaining is not part of the xript expression grammar");

		if (PUNCT_1.includes(ch)) {
			tokens.push({ type: "punct", value: ch, pos: i });
			i++;
			continue;
		}

		if (ch === "=") fail(i, "assignment is not part of the xript expression grammar");
		if (ch === ";") fail(i, "statements are not part of the xript expression grammar");
		if (ch === "{" || ch === "}") fail(i, "object literals and blocks are not part of the xript expression grammar");
		if (ch === "&" || ch === "|" || ch === "^" || ch === "~") {
			fail(i, "bitwise operators are not part of the xript expression grammar");
		}
		if (ch === "`") fail(i, "template literals are not part of the xript expression grammar");
		if (ch === "#") fail(i, "block helpers ('{{#if}}', '{{#each}}') do not exist — a fragment carries no control flow");

		fail(i, `unexpected character '${ch}'`);
	}

	tokens.push({ type: "eof", value: "", pos: source.length });
	return tokens;
}

class Parser {
	private readonly tokens: Token[];
	private index = 0;
	private count = 0;
	private readonly names: string[] = [];

	constructor(private readonly source: string, private readonly maxNodes: number) {
		this.tokens = tokenize(source);
	}

	parse(): ParsedExpression {
		const ast = this.parseExpr();
		if (this.peek().type !== "eof") {
			this.fail(this.peek().pos, `unexpected token '${this.peek().value}'`);
		}
		return {
			source: this.source,
			kind: ast.t === "name" ? "name" : "expression",
			ast,
			names: this.names,
			nodeCount: this.count,
		};
	}

	private peek(offset = 0): Token {
		return this.tokens[Math.min(this.index + offset, this.tokens.length - 1)];
	}

	private next(): Token {
		return this.tokens[this.index++];
	}

	private at(value: string): boolean {
		const token = this.peek();
		return token.type === "punct" && token.value === value;
	}

	private eat(value: string): boolean {
		if (!this.at(value)) return false;
		this.index++;
		return true;
	}

	private expect(value: string): void {
		if (!this.eat(value)) this.fail(this.peek().pos, `expected '${value}'`);
	}

	private fail(pos: number, message: string): never {
		throw new ExpressionError(this.source, pos, message);
	}

	private node<T extends ExprAst>(node: T): T {
		this.count++;
		if (this.count > this.maxNodes) {
			this.fail(0, `expression exceeds the ${this.maxNodes}-node limit`);
		}
		return node;
	}

	private parseExpr(): ExprAst {
		const test = this.parseNullish();
		if (!this.eat("?")) return test;
		const cons = this.parseExpr();
		this.expect(":");
		const alt = this.parseExpr();
		return this.node({ t: "cond", test, cons, alt });
	}

	private parseNullish(): ExprAst {
		let left = this.parseOr();
		while (this.at("??")) {
			this.next();
			left = this.node({ t: "logical", op: "??", left, right: this.parseOr() });
		}
		return left;
	}

	private parseOr(): ExprAst {
		let left = this.parseAnd();
		while (this.at("||")) {
			this.next();
			left = this.node({ t: "logical", op: "||", left, right: this.parseAnd() });
		}
		return left;
	}

	private parseAnd(): ExprAst {
		let left = this.parseEquality();
		while (this.at("&&")) {
			this.next();
			left = this.node({ t: "logical", op: "&&", left, right: this.parseEquality() });
		}
		return left;
	}

	private parseEquality(): ExprAst {
		let left = this.parseRelational();
		while (this.at("==") || this.at("!=")) {
			const op = this.next().value as "==" | "!=";
			left = this.node({ t: "binary", op, left, right: this.parseRelational() });
		}
		return left;
	}

	private parseRelational(): ExprAst {
		let left = this.parseAdditive();
		while (this.at("<") || this.at(">") || this.at("<=") || this.at(">=")) {
			const op = this.next().value as "<" | ">" | "<=" | ">=";
			left = this.node({ t: "binary", op, left, right: this.parseAdditive() });
		}
		return left;
	}

	private parseAdditive(): ExprAst {
		let left = this.parseMultiplicative();
		while (this.at("+") || this.at("-")) {
			const op = this.next().value as "+" | "-";
			left = this.node({ t: "binary", op, left, right: this.parseMultiplicative() });
		}
		return left;
	}

	private parseMultiplicative(): ExprAst {
		let left = this.parseUnary();
		while (this.at("*") || this.at("/") || this.at("%")) {
			const op = this.next().value as "*" | "/" | "%";
			left = this.node({ t: "binary", op, left, right: this.parseUnary() });
		}
		return left;
	}

	private parseUnary(): ExprAst {
		if (this.at("!") || this.at("-") || this.at("+")) {
			const op = this.next().value as "!" | "-" | "+";
			return this.node({ t: "unary", op, arg: this.parseUnary() });
		}
		return this.parsePostfix();
	}

	private parsePostfix(): ExprAst {
		let target = this.parsePrimary();
		for (;;) {
			if (this.eat(".")) {
				const token = this.next();
				if (token.type !== "name") this.fail(token.pos, "expected a property name after '.'");
				target = this.node({ t: "member", obj: target, name: token.value });
				continue;
			}
			if (this.eat("[")) {
				const index = this.parseExpr();
				this.expect("]");
				target = this.node({ t: "index", obj: target, index });
				continue;
			}
			if (this.at("(")) {
				this.fail(this.peek().pos, "only builtin functions are callable; a binding value is not");
			}
			return target;
		}
	}

	private parsePrimary(): ExprAst {
		const token = this.peek();

		if (token.type === "num") {
			this.next();
			return this.node({ t: "num", v: token.num as number });
		}

		if (token.type === "str") {
			this.next();
			return this.node({ t: "str", v: token.str as string });
		}

		if (token.type === "name") {
			this.next();
			if (token.value === "true" || token.value === "false") {
				return this.node({ t: "bool", v: token.value === "true" });
			}
			if (token.value === "null") return this.node({ t: "null" });
			if (RESERVED_WORDS.has(token.value)) {
				this.fail(token.pos, `'${token.value}' is not part of the xript expression grammar`);
			}

			if (this.at("(")) {
				const arity = Object.prototype.hasOwnProperty.call(BUILTINS, token.value)
					? BUILTINS[token.value]
					: undefined;
				if (!arity) {
					this.fail(
						token.pos,
						`unknown function '${token.value}' — the builtin table is ${BUILTIN_NAMES.join(", ")}`,
					);
				}
				this.next();
				const args: ExprAst[] = [];
				if (!this.at(")")) {
					args.push(this.parseExpr());
					while (this.eat(",")) args.push(this.parseExpr());
				}
				this.expect(")");
				if (args.length < arity[0] || args.length > arity[1]) {
					const expected = arity[1] === Infinity
						? `at least ${arity[0]}`
						: arity[0] === arity[1] ? `${arity[0]}` : `${arity[0]}–${arity[1]}`;
					this.fail(token.pos, `'${token.value}' takes ${expected} argument(s), got ${args.length}`);
				}
				return this.node({ t: "call", name: token.value, args });
			}

			if (!this.names.includes(token.value)) this.names.push(token.value);
			return this.node({ t: "name", name: token.value });
		}

		if (this.eat("(")) {
			const inner = this.parseExpr();
			this.expect(")");
			return inner;
		}

		this.fail(token.pos, token.type === "eof" ? "unexpected end of expression" : `unexpected token '${token.value}'`);
	}
}

/**
 * Parses an XEG expression.
 *
 * @throws {ExpressionError} when the source is not a member of the grammar
 */
export function parseExpression(source: string, options: ParseExpressionOptions = {}): ParsedExpression {
	const max = options.maxExpressionNodes ?? DEFAULT_MAX_EXPRESSION_NODES;
	if (source.trim() === "") throw new ExpressionError(source, 0, "empty expression");
	return new Parser(source, max).parse();
}

export type ParseExpressionResult =
	| { ok: true; expression: ParsedExpression }
	| { ok: false; error: ExpressionError };

export function tryParseExpression(
	source: string,
	options: ParseExpressionOptions = {},
): ParseExpressionResult {
	try {
		return { ok: true, expression: parseExpression(source, options) };
	} catch (err) {
		if (err instanceof ExpressionError) return { ok: false, error: err };
		throw err;
	}
}

/** Cached parses, keyed by source. Fragments re-render far more often than they load. */
const parseCache = new Map<string, ParseExpressionResult>();

export function parseExpressionCached(source: string): ParseExpressionResult {
	const hit = parseCache.get(source);
	if (hit) return hit;
	const result = tryParseExpression(source);
	if (parseCache.size > 512) parseCache.clear();
	parseCache.set(source, result);
	return result;
}

export function isTruthy(value: ExprValue | undefined): boolean {
	if (value === null || value === undefined || value === false) return false;
	if (value === true) return true;
	if (typeof value === "number") return value !== 0 && !Number.isNaN(value);
	if (typeof value === "string") return value.length > 0;
	return true;
}

/** `str()` — the one stringification every runtime shares. `null` renders as empty. */
export function renderValue(value: ExprValue | undefined): string {
	if (value === null || value === undefined) return "";
	if (typeof value === "string") return value;
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
	if (Array.isArray(value)) return value.map((item) => renderValue(item)).join(",");
	return "[object Object]";
}

function asNumber(value: ExprValue): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function finite(value: number): ExprValue {
	return Number.isFinite(value) ? value : null;
}

function isPrimitive(value: ExprValue): boolean {
	return value === null || typeof value !== "object";
}

function strictEqual(left: ExprValue, right: ExprValue): boolean {
	if (!isPrimitive(left) || !isPrimitive(right)) return false;
	return left === right;
}

function compare(op: "<" | "<=" | ">" | ">=", left: ExprValue, right: ExprValue): boolean {
	if (typeof left === "number" && typeof right === "number") {
		if (Number.isNaN(left) || Number.isNaN(right)) return false;
		switch (op) {
			case "<": return left < right;
			case "<=": return left <= right;
			case ">": return left > right;
			case ">=": return left >= right;
		}
	}
	if (typeof left === "string" && typeof right === "string") {
		switch (op) {
			case "<": return left < right;
			case "<=": return left <= right;
			case ">": return left > right;
			case ">=": return left >= right;
		}
	}
	return false;
}

function readMember(target: ExprValue, key: string | number): ExprValue {
	if (target === null || typeof target !== "object") {
		if (typeof target === "string" && typeof key === "number") {
			const index = key < 0 ? target.length + key : key;
			return index >= 0 && index < target.length ? target[index] : null;
		}
		if (typeof target === "string" && key === "length") return target.length;
		return null;
	}
	if (Array.isArray(target)) {
		if (key === "length") return target.length;
		const index = typeof key === "number" ? (key < 0 ? target.length + key : key) : Number(key);
		if (!Number.isInteger(index) || index < 0 || index >= target.length) return null;
		return target[index] ?? null;
	}
	const name = String(key);
	if (!Object.prototype.hasOwnProperty.call(target, name)) return null;
	const value = (target as Record<string, ExprValue>)[name];
	return value === undefined ? null : value;
}

function callBuiltin(name: string, args: ExprValue[]): ExprValue {
	switch (name) {
		case "abs": { const x = asNumber(args[0]); return x === null ? null : Math.abs(x); }
		case "round": { const x = asNumber(args[0]); return x === null ? null : Math.round(x); }
		case "floor": { const x = asNumber(args[0]); return x === null ? null : Math.floor(x); }
		case "ceil": { const x = asNumber(args[0]); return x === null ? null : Math.ceil(x); }
		case "min":
		case "max": {
			const nums: number[] = [];
			for (const arg of args) {
				const n = asNumber(arg);
				if (n === null) return null;
				nums.push(n);
			}
			return name === "min" ? Math.min(...nums) : Math.max(...nums);
		}
		case "clamp": {
			const x = asNumber(args[0]);
			const lo = asNumber(args[1]);
			const hi = asNumber(args[2]);
			if (x === null || lo === null || hi === null || lo > hi) return null;
			return Math.min(Math.max(x, lo), hi);
		}
		case "fixed": {
			const x = asNumber(args[0]);
			const n = asNumber(args[1]);
			if (x === null || n === null || !Number.isInteger(n) || n < 0 || n > 20) return null;
			return x.toFixed(n);
		}
		case "upper": return typeof args[0] === "string" ? args[0].toUpperCase() : null;
		case "lower": return typeof args[0] === "string" ? args[0].toLowerCase() : null;
		case "trim": return typeof args[0] === "string" ? args[0].trim() : null;
		case "pad": {
			const s = args[0];
			const n = asNumber(args[1]);
			const ch = args.length > 2 ? args[2] : " ";
			if (typeof s !== "string" || n === null || !Number.isInteger(n) || n < 0 || n > 4096) return null;
			if (typeof ch !== "string" || ch.length === 0) return null;
			return s.length >= n ? s : ch.repeat(Math.ceil((n - s.length) / ch.length)).slice(0, n - s.length) + s;
		}
		case "slice": {
			const s = args[0];
			const a = asNumber(args[1]);
			if (typeof s !== "string" || a === null) return null;
			if (args.length > 2) {
				const b = asNumber(args[2]);
				if (b === null) return null;
				return s.slice(a, b);
			}
			return s.slice(a);
		}
		case "len": {
			const value = args[0];
			if (typeof value === "string") return value.length;
			if (Array.isArray(value)) return value.length;
			if (value !== null && typeof value === "object") return Object.keys(value).length;
			return null;
		}
		case "has": {
			const coll = args[0];
			const key = args[1];
			if (typeof coll === "string") return typeof key === "string" ? coll.includes(key) : false;
			if (Array.isArray(coll)) return coll.some((item) => strictEqual(item, key));
			if (coll !== null && typeof coll === "object") {
				return typeof key === "string" && Object.prototype.hasOwnProperty.call(coll, key);
			}
			return null;
		}
		case "join": {
			const arr = args[0];
			const sep = args.length > 1 ? args[1] : ",";
			if (!Array.isArray(arr) || typeof sep !== "string") return null;
			return arr.map((item) => renderValue(item)).join(sep);
		}
		case "at": {
			const coll = args[0];
			const i = asNumber(args[1]);
			if (i === null || !Number.isInteger(i)) return null;
			if (typeof coll === "string") {
				const index = i < 0 ? coll.length + i : i;
				return index >= 0 && index < coll.length ? coll[index] : null;
			}
			if (Array.isArray(coll)) {
				const index = i < 0 ? coll.length + i : i;
				return index >= 0 && index < coll.length ? (coll[index] ?? null) : null;
			}
			return null;
		}
		case "str": return renderValue(args[0]);
		case "num": {
			const value = args[0];
			if (typeof value === "number") return Number.isFinite(value) ? value : null;
			if (typeof value === "boolean") return value ? 1 : 0;
			if (typeof value === "string") {
				const trimmed = value.trim();
				if (trimmed === "") return null;
				const n = Number(trimmed);
				return Number.isFinite(n) ? n : null;
			}
			return null;
		}
		case "bool": return isTruthy(args[0]);
		default: return null;
	}
}

/**
 * Normalizes an arbitrary host value into the `ExprValue` domain. Anything JSON cannot
 * express — a function, a symbol, a class instance's prototype chain — is dropped, so
 * an expression can never reach a callable through a binding.
 */
export function toExprValue(value: unknown): ExprValue {
	if (value === null || value === undefined) return null;
	const type = typeof value;
	if (type === "string" || type === "boolean") return value as ExprValue;
	if (type === "number") return Number.isFinite(value as number) ? (value as number) : null;
	if (Array.isArray(value)) return value.map((item) => toExprValue(item));
	if (type === "object") {
		const result: Record<string, ExprValue> = {};
		for (const key of Object.keys(value as object)) {
			if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
			result[key] = toExprValue((value as Record<string, unknown>)[key]);
		}
		return result;
	}
	return null;
}

function evalNode(node: ExprAst, bindings: Record<string, unknown>): ExprValue {
	switch (node.t) {
		case "num": return node.v;
		case "str": return node.v;
		case "bool": return node.v;
		case "null": return null;
		case "name": {
			if (!Object.prototype.hasOwnProperty.call(bindings, node.name)) return null;
			return toExprValue(bindings[node.name]);
		}
		case "member": return readMember(evalNode(node.obj, bindings), node.name);
		case "index": {
			const target = evalNode(node.obj, bindings);
			const key = evalNode(node.index, bindings);
			if (typeof key === "number") return readMember(target, key);
			if (typeof key === "string") return readMember(target, key);
			return null;
		}
		case "unary": {
			const arg = evalNode(node.arg, bindings);
			if (node.op === "!") return !isTruthy(arg);
			const n = asNumber(arg);
			if (n === null) return null;
			return node.op === "-" ? -n : n;
		}
		case "logical": {
			const left = evalNode(node.left, bindings);
			if (node.op === "&&") return isTruthy(left) ? evalNode(node.right, bindings) : left;
			if (node.op === "||") return isTruthy(left) ? left : evalNode(node.right, bindings);
			return left === null ? evalNode(node.right, bindings) : left;
		}
		case "cond":
			return isTruthy(evalNode(node.test, bindings))
				? evalNode(node.cons, bindings)
				: evalNode(node.alt, bindings);
		case "call": {
			const args = node.args.map((arg) => evalNode(arg, bindings));
			return callBuiltin(node.name, args);
		}
		case "binary": {
			const left = evalNode(node.left, bindings);
			const right = evalNode(node.right, bindings);
			switch (node.op) {
				case "==": return strictEqual(left, right);
				case "!=": return !strictEqual(left, right);
				case "<": case "<=": case ">": case ">=": return compare(node.op, left, right);
				case "+": {
					if (typeof left === "string" || typeof right === "string") {
						if (!isPrimitive(left) || !isPrimitive(right)) return null;
						return renderValue(left) + renderValue(right);
					}
					const a = asNumber(left);
					const b = asNumber(right);
					return a === null || b === null ? null : finite(a + b);
				}
				case "-": case "*": case "/": case "%": {
					const a = asNumber(left);
					const b = asNumber(right);
					if (a === null || b === null) return null;
					if (node.op === "-") return finite(a - b);
					if (node.op === "*") return finite(a * b);
					if (b === 0) return null;
					return node.op === "/" ? finite(a / b) : finite(a % b);
				}
			}
		}
	}
}

/**
 * Evaluates a parsed expression. Total: every failure mode yields `null` rather than
 * throwing, so no evaluation can abort a render.
 */
export function evaluateAst(ast: ExprAst, bindings: Record<string, unknown>): ExprValue {
	try {
		return evalNode(ast, bindings);
	} catch {
		return null;
	}
}

/** Evaluates a source string, parsing through the shared cache. Unparseable → `null`. */
export function evaluateExpression(source: string, bindings: Record<string, unknown>): ExprValue {
	const parsed = parseExpressionCached(source);
	if (!parsed.ok) return null;
	return evaluateAst(parsed.expression.ast, bindings);
}

/** `data-if`: the expression's truth. An unparseable or failing expression is `false`. */
export function evaluateCondition(source: string, bindings: Record<string, unknown>): boolean {
	return isTruthy(evaluateExpression(source, bindings));
}
