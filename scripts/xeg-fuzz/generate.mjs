/**
 * Case generation for the XEG differential fuzzer. Every case is a pure function of
 * `(seed, index)`, so a single failing case reproduces from its id alone.
 */

const cp = (...points) => String.fromCodePoint(...points);

/** Characters whose handling differs between naive whitespace, case, and length rules. */
const ODD = {
	nbsp: cp(0xa0),
	bom: cp(0xfeff),
	nel: cp(0x85),
	lsep: cp(0x2028),
	psep: cp(0x2029),
	ogham: cp(0x1680),
	enQuad: cp(0x2000),
	nnbsp: cp(0x202f),
	ideo: cp(0x3000),
	zwsp: cp(0x200b),
	vt: cp(0x0b),
	ff: cp(0x0c),
	fs: cp(0x1c),
	emoji: cp(0x1f600),
	family: cp(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467),
	clef: cp(0x1d11e),
	eszett: cp(0xdf),
	dotI: cp(0x130),
	finalSigma: cp(0x3a3),
	ligature: cp(0xfb01),
	combining: "e" + cp(0x301),
	georgian: cp(0x10d0),
	cherokee: cp(0x13a0),
	deseret: cp(0x10428),
	adlam: cp(0x1e922),
	privateUse: cp(0xe000),
	astralCap: cp(0x10400),
	iota: cp(0x345),
	arabicDigit: cp(0x663),
};

/** A small, fast, seedable PRNG (mulberry32). */
export function rng(seed) {
	let state = seed >>> 0;
	const next = () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	const api = {
		next,
		int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
		chance: (p) => next() < p,
		pick: (list) => list[Math.floor(next() * list.length)],
		weighted(entries) {
			const total = entries.reduce((sum, [weight]) => sum + weight, 0);
			let roll = next() * total;
			for (const [weight, value] of entries) {
				roll -= weight;
				if (roll < 0) return value;
			}
			return entries[entries.length - 1][1];
		},
	};
	return api;
}

/** Mixes a run seed and a case index into an independent per-case seed. */
export function caseSeed(seed, index) {
	const fmix = (value) => {
		let h = value >>> 0;
		h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
		h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
		return (h ^ (h >>> 16)) >>> 0;
	};
	return fmix(fmix(seed) + Math.imul(index, 0x9e3779b1));
}

const BINDING_NAMES = ["a", "b", "c", "hp", "name", "items", "obj", "s", "n", "x", "_u", "$v", "length", "grid", "m", "__proto__", "constructor"];
const UNDECLARED = ["ghost", "nope", "Undefined", "NaN", "Infinity", "self", "window"];
const RESERVED = ["undefined", "this", "new", "typeof", "in", "function", "eval", "globalThis", "void"];

const BUILTINS = {
	abs: [1, 1], round: [1, 1], floor: [1, 1], ceil: [1, 1], min: [1, 6], max: [1, 6],
	clamp: [3, 3], fixed: [2, 2], upper: [1, 1], lower: [1, 1], trim: [1, 1], pad: [2, 3],
	slice: [2, 3], len: [1, 1], has: [2, 2], join: [1, 2], at: [2, 2], str: [1, 1], num: [1, 1], bool: [1, 1],
};
const BUILTIN_NAMES = Object.keys(BUILTINS);

const NUMBER_VALUES = [
	0, 1, -1, 2, 3, 7, 10, 35, 100, 255, 256, 4096, 4097, 0.5, -0.5, 1.5, -1.5, 2.5, -2.5,
	0.1, 0.2, 0.3, 1.005, 1.45, 0.125, 1e21, 1e20, 999999999999999900000, 1e-6, 1e-7, 1.5e-7,
	123456789.123, 5e-324, 1.7976931348623157e308, -1.7976931348623157e308, 9007199254740993,
	4503599627370495.5, 0.49999999999999994, 1e300, -1e300, 12345678901234567890, 2 ** 53,
	-(2 ** 63), 2 ** 63, 3.14159, 1 / 3, 2 / 3, 100 / 3, 0.000001, 0.0000001, 20, 21, -20,
];

const STRING_VALUES = [
	"", " ", "a", "abc", "Hero", "hello world", "42", " 42 ", "-7", "+5", "1e3", "1.5e3", "0x10",
	"0b1", "1_000", ".5", "5.", "-.5", "+.5", "5.e3", "1e", "e5", "Infinity", "-Infinity", "NaN",
	"length", "0", "1", "-1", "01", "1.0", " 1", "1 ", "", "true", "null", "{{ a }}", "<b>x</b>",
	"\\{{", "C:\\Users", "a\nb", "\t", ODD.nbsp + "x" + ODD.nbsp, ODD.bom + "y" + ODD.bom,
	ODD.nel + "z" + ODD.nel, ODD.lsep, ODD.psep + "p", ODD.ogham + "o", ODD.enQuad, ODD.nnbsp,
	ODD.ideo + "i", ODD.zwsp + "w", ODD.vt + "v", ODD.ff, ODD.fs + "f", ODD.emoji, "a" + ODD.emoji + "b",
	ODD.family, ODD.clef + ODD.clef, "stra" + ODD.eszett + "e", ODD.dotI, "OD" + ODD.finalSigma,
	ODD.finalSigma, ODD.ligature, ODD.combining, ODD.georgian, ODD.cherokee, ODD.deseret, ODD.adlam,
	ODD.privateUse, ODD.astralCap, "x" + ODD.iota, ODD.arabicDigit + ODD.arabicDigit, "ǅ", "ŉ", "ΐ",
	"ﬀ", "ẞ", "i̇", "Σa", "aΣ", "aΣb", "AΣ.", "ΣΣ", "a" + cp(0x345) + "Σ",
];

const OBJECT_KEYS = [
	"a", "b", "name", "length", "0", "1", "-1", "1.5", "1e+21", "", "constructor", "__proto__",
	"prototype", "toString", "hasOwnProperty", "valueOf", ODD.emoji, "id", "stats", "x y",
];

function randomCodePoint(r) {
	return r.weighted([
		[6, r.int(0x20, 0x7e)],
		[3, r.int(0xa0, 0x2fff)],
		[1, r.int(0x3000, 0xd7ff)],
		[1, r.int(0xe000, 0xfffd)],
		[2, r.int(0x10000, 0x1ffff)],
		[1, r.int(0x20000, 0x10ffff)],
	]);
}

function randomString(r) {
	if (r.chance(0.55)) return r.pick(STRING_VALUES);
	const length = r.int(0, 8);
	let out = "";
	for (let i = 0; i < length; i++) {
		out += r.chance(0.25) ? r.pick(STRING_VALUES).slice(0, 3) : String.fromCodePoint(randomCodePoint(r));
	}
	return out.replace(/[\uD800-\uDFFF]/g, (ch, at, all) => {
		const code = ch.charCodeAt(0);
		const paired = code < 0xdc00
			? at + 1 < all.length && /[\uDC00-\uDFFF]/.test(all[at + 1])
			: at > 0 && /[\uD800-\uDBFF]/.test(all[at - 1]);
		return paired ? ch : "?";
	});
}

function randomNumber(r) {
	return r.weighted([
		[5, () => r.pick(NUMBER_VALUES)],
		[3, () => r.int(-20, 120)],
		[2, () => Number((r.next() * 200 - 100).toFixed(r.int(0, 4)))],
		[1, () => (r.next() - 0.5) * 10 ** r.int(-12, 25)],
		[1, () => {
			const buffer = new DataView(new ArrayBuffer(8));
			buffer.setUint32(0, Math.floor(r.next() * 2 ** 32));
			buffer.setUint32(4, Math.floor(r.next() * 2 ** 32));
			const value = buffer.getFloat64(0);
			return Number.isFinite(value) ? value : 0;
		}],
	])();
}

/** A JSON-safe host value: finite numbers only, no lone surrogates. */
export function randomValue(r, depth = 0) {
	const kind = r.weighted([
		[2, "null"], [2, "bool"], [6, "number"], [6, "string"],
		[depth < 3 ? 3 : 0, "array"], [depth < 3 ? 3 : 0, "object"],
	]);
	switch (kind) {
		case "null": return null;
		case "bool": return r.chance(0.5);
		case "number": return randomNumber(r);
		case "string": return randomString(r);
		case "array": return Array.from({ length: r.int(0, 5) }, () => randomValue(r, depth + 1));
		default: {
			const object = {};
			const count = r.int(0, 5);
			for (let i = 0; i < count; i++) {
				Object.defineProperty(object, r.pick(OBJECT_KEYS), {
					value: randomValue(r, depth + 1), enumerable: true, writable: true, configurable: true,
				});
			}
			return object;
		}
	}
}

export function randomBindings(r) {
	const bindings = {};
	for (const name of BINDING_NAMES) {
		if (!r.chance(0.6)) continue;
		Object.defineProperty(bindings, name, { value: randomValue(r), enumerable: true, writable: true, configurable: true });
	}
	return bindings;
}

const SPACES = [" ", " ", " ", "  ", "\t", "\n", "\r\n", ODD.vt, ODD.ff, ODD.nbsp, ODD.bom, ODD.nel, ODD.lsep, ODD.ideo];

function space(r) {
	if (r.chance(0.6)) return r.chance(0.5) ? "" : " ";
	return r.pick(SPACES);
}

const NUMBER_LITERALS = [
	"0", "1", "2", "3", "7", "10", "35", "100", "0.5", ".5", "5.", "1.", "2.5", "1e3", "1E3", "1e+3",
	"1e-3", "1.5e-7", "1e21", "1e999", "1e-999", "007", "0x10", "0b1", "0o7", "1_0", "1e", "1e+",
	"9007199254740993", "123456789012345678901234567890", "5e-324", "1.7976931348623157e308",
	"1.7976931348623159e308", "0.1", "0.30000000000000004", "1.005", "4096", "4097", "20", "21",
	"1.e5", "5.e3", ".5e1", "..5", "1..2", "0.0", "00", "1e21", "999999999999999999999",
];

const STRING_PIECES = [
	"a", "b", "Hero", " ", "x y", "0", "1", "-1", "length", "\\n", "\\t", "\\r", "\\b", "\\f", "\\0",
	"\\v", "\\x41", "\\u0041", "\\u00e9", "\\u00DF", "\\uD83D\\uDE00", "\\uD83D", "\\uDE00", "\\uDE00\\uD83D",
	"\\u{41}", "\\u12", "\\u 041", "\\u+041", "\\uGGGG", "\\\\", "\\'", '\\"', "\\a", "\\1", "\\\n",
	ODD.emoji, ODD.nbsp, ODD.lsep, ODD.bom, "\t", "\n", "\r", ODD.eszett, ODD.finalSigma, ODD.dotI,
	ODD.ligature, "{{", "}}", "#", "`", "${x}", "42", " 7 ", "1e3", "0x1",
];

function stringLiteral(r) {
	const quote = r.chance(0.5) ? "'" : '"';
	let body = "";
	const count = r.int(0, 4);
	for (let i = 0; i < count; i++) {
		const piece = r.chance(0.7) ? r.pick(STRING_PIECES) : randomString(r);
		body += piece === quote ? `\\${quote}` : piece;
	}
	if (!r.chance(0.97)) return quote + body;
	return quote + body.split(quote).join(r.chance(0.95) ? `\\${quote}` : quote) + quote;
}

function identifier(r, names) {
	return r.weighted([
		[12, () => r.pick(names.length ? names : BINDING_NAMES)],
		[2, () => r.pick(UNDECLARED)],
		[1, () => r.pick(RESERVED)],
		[2, () => "$index"],
	])();
}

const BINARY = [
	"+", "-", "*", "/", "%", "==", "!=", "===", "!==", "<", "<=", ">", ">=", "&&", "||", "??",
];

const MEMBER_NAMES = ["length", "a", "b", "name", "id", "stats", "constructor", "__proto__", "prototype", "toString", "x", "null", "true", "in", "$", "_"];

const INDEX_KEYS = [
	"0", "1", "2", "-1", "-2", "-0", "1.5", "-1.5", "0.5", "1e300", "-1e300", "9007199254740993", "1e21",
	"'0'", "'1'", "'-1'", "'01'", "' 1'", "'1.0'", "''", "'length'", "'a'", "'name'", "'+1'", "'1e0'",
	"'0x1'", "'1.5'", "'constructor'", "'__proto__'", "true", "null", "1/0", "-(0)",
];

function maybeParen(r, text, p = 0.35) {
	return r.chance(p) ? `(${space(r)}${text}${space(r)})` : text;
}

/** A source drawn from the whole production, unparenthesised often enough to exercise precedence. */
export function expression(r, names, depth = 0) {
	const leaf = depth > 4 || r.chance(depth * 0.18);
	const choice = leaf
		? r.weighted([[5, "num"], [4, "str"], [2, "kw"], [10, "name"]])
		: r.weighted([
			[3, "num"], [3, "str"], [1, "kw"], [6, "name"], [4, "unary"], [10, "binary"], [3, "ternary"],
			[4, "member"], [5, "index"], [9, "call"], [2, "paren"],
		]);
	const sub = () => expression(r, names, depth + 1);
	const s = () => space(r);

	switch (choice) {
		case "num": return r.chance(0.85) ? r.pick(NUMBER_LITERALS) : String(randomNumber(r));
		case "str": return stringLiteral(r);
		case "kw": return r.pick(["true", "false", "null"]);
		case "name": return identifier(r, names);
		case "unary": {
			const chain = Array.from({ length: r.int(1, 3) }, () => r.pick(["!", "-", "+"]) + s()).join("");
			return chain + maybeParen(r, sub());
		}
		case "binary": return `${maybeParen(r, sub())}${s()}${r.pick(BINARY)}${s()}${maybeParen(r, sub())}`;
		case "ternary": return `${maybeParen(r, sub())}${s()}?${s()}${maybeParen(r, sub())}${s()}:${s()}${maybeParen(r, sub())}`;
		case "member": return `${maybeParen(r, sub(), 0.5)}${s()}.${s()}${r.pick(MEMBER_NAMES)}`;
		case "index": {
			const key = r.chance(0.6) ? r.pick(INDEX_KEYS) : sub();
			return `${maybeParen(r, sub(), 0.5)}${s()}[${s()}${key}${s()}]`;
		}
		case "call": {
			const name = r.weighted([[20, () => r.pick(BUILTIN_NAMES)], [1, () => r.pick(["foo", "hp", "toString", "Math"])]])();
			const [min, max] = Object.hasOwn(BUILTINS, name) ? BUILTINS[name] : [1, 1];
			const arity = r.chance(0.9) ? r.int(min, max) : r.int(0, max + 2);
			const args = Array.from({ length: arity }, sub);
			return `${name}${r.chance(0.1) ? " " : ""}(${s()}${args.join(`${s()},${s()}`)}${s()})`;
		}
		default: return `(${s()}${sub()}${s()})`;
	}
}

const MUTATION_ALPHABET = [
	"(", ")", "[", "]", ".", "?", ":", ",", "'", '"', "\\", "=", "!", "&", "|", "{", "}", "#", "`",
	"0", "5", "e", "E", "x", "a", "?.", ".5", "u", "-", "+", "*", "/", "%", "<", ">", ";", "@", " ",
	ODD.nbsp, ODD.bom, ODD.lsep, ODD.nel, ODD.emoji, "\n", "\t", "in ", "??", "===", "=>", "++", "--",
];

/** A malformed neighbour of `source`: a few random edits at code-point boundaries. */
export function mutate(r, source) {
	let chars = Array.from(source);
	const edits = r.int(1, 3);
	for (let e = 0; e < edits; e++) {
		const at = r.int(0, chars.length);
		const op = r.int(0, 3);
		if (op === 0 && chars.length) chars.splice(Math.min(at, chars.length - 1), 1);
		else if (op === 1) chars.splice(at, 0, r.pick(MUTATION_ALPHABET));
		else if (op === 2 && chars.length) chars[Math.min(at, chars.length - 1)] = r.pick(MUTATION_ALPHABET);
		else {
			const from = r.int(0, chars.length);
			const to = Math.min(chars.length, from + r.int(1, 6));
			chars.splice(at, 0, ...chars.slice(from, to));
		}
	}
	return chars.join("");
}

/** Sources aimed at the node cap and at nesting depth. */
function deep(r, names) {
	const n = r.pick([10, 60, 63, 64, 65, 100, 127, 128, 129, 200, 254, 255, 256, 257, 300, 1000, 5000]);
	const id = () => r.pick(names.length ? names : ["a"]);
	return r.pick([
		() => `${"(".repeat(n)}1${")".repeat(n)}`,
		() => `${"(".repeat(n)}${id()}${")".repeat(n)}`,
		() => `${"-".repeat(n)}1`,
		() => `${"!".repeat(n)}${id()}`,
		() => `${"- ".repeat(n)}1`,
		() => Array.from({ length: Math.ceil(n / 2) + 1 }, () => "1").join("+"),
		() => Array.from({ length: n }, () => id()).join(" && "),
		() => `${id()}${"[0]".repeat(n)}`,
		() => `${id()}${".a".repeat(n)}`,
		() => `${"abs(".repeat(n)}1${")".repeat(n)}`,
		() => `${`${id()}[`.repeat(n)}0${"]".repeat(n)}`,
		() => `${"1 ? ".repeat(n)}2${" : 3".repeat(n)}`,
		() => `${"0 ? 1 : ".repeat(n)}2`,
		() => `min(${Array.from({ length: n }, (_, i) => String(i)).join(",")})`,
		() => `${"(".repeat(n)}`,
		() => `${"[".repeat(n)}`,
		() => `'${"a".repeat(n * 10)}'`,
	])();
}

const TEXT_PIECES = [
	"Health: ", " ", "/", "{", "}", "{{", "}}", "{{{", "}}}", "\\{{", "\\", "\\\\{{", "{{#if x}}", "{{/if}}",
	"\\n", "C:\\Users", "{ {", "} }", "{{}}", "{{ }}", "{{ {{ a }} }}", ODD.emoji, ODD.nbsp, "\n",
];

export function segmentText(r, names) {
	let text = "";
	const count = r.int(1, 6);
	for (let i = 0; i < count; i++) {
		text += r.weighted([
			[4, () => r.pick(TEXT_PIECES)],
			[4, () => `{{${space(r)}${expression(r, names, 2)}${space(r)}}}`],
			[1, () => `{{${space(r)}${mutate(r, expression(r, names, 3))}${space(r)}}}`],
			[2, () => randomString(r)],
		])();
	}
	return text;
}

const BINDERS = ["__proto__", "constructor", "item", "x", "i", "a", "$index", "_k", "true", "null", "in", "items", "hp", "inn", "in2"];

export function repeatHeader(r, names) {
	const ws = () => (r.chance(0.8) ? " " : r.pick([...SPACES, "", "  "]));
	const binder = () => r.pick(BINDERS);
	const expr = () => (r.chance(0.7) ? identifier(r, names) : expression(r, names, 2));
	const form = r.weighted([
		[6, () => `${binder()}${ws()}in${ws()}${expr()}`],
		[4, () => `(${ws()}${binder()}${ws()},${ws()}${binder()}${ws()})${ws()}in${ws()}${expr()}`],
		[2, () => `(${binder()})${ws()}in${ws()}${expr()}`],
		[1, () => `${ws()}${binder()} in ${expr()}${ws()}`],
		[1, () => `${binder()}in ${expr()}`],
		[1, () => `${binder()} in`],
		[1, () => `(${binder()}, ) in ${expr()}`],
	])();
	return r.chance(0.15) ? mutate(r, form) : form;
}

/** The case at `index` of the run seeded `seed`. */
export function generateCase(seed, index) {
	const r = rng(caseSeed(seed, index));
	const b = randomBindings(r);
	const names = Object.keys(b);
	const kind = r.weighted([[80, "e"], [12, "s"], [8, "r"]]);
	if (kind === "s") return { k: "s", text: segmentText(r, names), b };
	if (kind === "r") return { k: "r", src: repeatHeader(r, names), b };
	const src = r.weighted([
		[70, () => expression(r, names)],
		[22, () => mutate(r, expression(r, names))],
		[4, () => deep(r, names)],
		[4, () => r.pick(["", " ", ODD.nbsp, "\t\n", ODD.bom, "()", "a b", "1 2", "a.", ".", "?:", "a ?", "'"])],
	])();
	return { k: "e", src, b };
}
