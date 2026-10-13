/**
 * `data-each`: repeat in fragment templates.
 *
 * A node carrying `data-each="item in items"` (or `"(item, i) in items"`) is a template:
 * the bind pass replaces it with one copy per element of the XEG expression on the right
 * of `in`, and renders the template itself nowhere. Inside a copy, the item name, the
 * optional index name, and `$index` are in scope for every expression the copy carries.
 *
 * Everything here is total. A header that does not parse, an expression that fails, and
 * a value that is not an array all render zero copies; nothing throws.
 */

import {
	parseExpressionCached,
	evaluateAst,
	type ExprValue,
	type ParsedExpression,
} from "./expr.js";

/** The implicit index name, in scope inside every copy. */
export const REPEAT_INDEX_NAME = "$index";

/**
 * The most copies one render may produce across every `data-each` in a fragment. Nested
 * repeats multiply, so without a ceiling a template's render cost would grow with the
 * host's data raised to the nesting depth.
 */
export const MAX_REPEAT_COPIES = 10000;

const RESERVED_BINDER_NAMES = new Set(["true", "false", "null", "in"]);

export interface RepeatHeader {
	/** The name each element binds to inside a copy. */
	item: string;
	/** The optional explicit index name. `$index` is bound regardless. */
	index: string | null;
	/** The XEG source on the right of `in`. */
	source: string;
	expression: ParsedExpression;
}

export type RepeatHeaderResult =
	| { ok: true; header: RepeatHeader }
	| { ok: false; message: string };

function isWhitespace(ch: string | undefined): boolean {
	return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\v";
}

function isIdentStart(ch: string | undefined): boolean {
	return ch !== undefined && /[A-Za-z_$]/.test(ch);
}

function isIdentPart(ch: string | undefined): boolean {
	return ch !== undefined && /[A-Za-z0-9_$]/.test(ch);
}

/**
 * Parses a `data-each` header: `item in expr` or `(item, index) in expr`.
 *
 * The binder names follow XEG's identifier rule. `in` must be followed by whitespace, and
 * everything after it must be a member of the grammar.
 */
export function parseRepeatHeader(source: string): RepeatHeaderResult {
	let i = 0;
	const skip = () => {
		while (isWhitespace(source[i])) i++;
	};
	const ident = (): string | null => {
		if (!isIdentStart(source[i])) return null;
		const start = i;
		i++;
		while (isIdentPart(source[i])) i++;
		return source.slice(start, i);
	};

	skip();
	let item: string | null;
	let index: string | null = null;

	if (source[i] === "(") {
		i++;
		skip();
		item = ident();
		if (item === null) return { ok: false, message: "expected an item name after '('" };
		skip();
		if (source[i] === ",") {
			i++;
			skip();
			index = ident();
			if (index === null) return { ok: false, message: "expected an index name after ','" };
			skip();
		}
		if (source[i] !== ")") return { ok: false, message: "expected ')' to close the binder list" };
		i++;
		skip();
	} else {
		item = ident();
		if (item === null) return { ok: false, message: "expected 'item in expression' or '(item, index) in expression'" };
		if (!isWhitespace(source[i])) return { ok: false, message: "expected whitespace before 'in'" };
		skip();
	}

	if (source.slice(i, i + 2) !== "in" || !isWhitespace(source[i + 2])) {
		return { ok: false, message: "expected 'in' followed by an expression" };
	}
	i += 2;

	for (const name of index === null ? [item] : [item, index]) {
		if (RESERVED_BINDER_NAMES.has(name)) return { ok: false, message: `'${name}' cannot name a repeat binding` };
	}
	if (index !== null && index === item) {
		return { ok: false, message: `the item and index cannot share the name '${item}'` };
	}

	let end = source.length;
	while (end > i && isWhitespace(source[end - 1])) end--;
	skip();
	const rest = source.slice(i, end);
	if (rest === "") return { ok: false, message: "expected an expression after 'in'" };
	const parsed = parseExpressionCached(rest);
	if (!parsed.ok) return { ok: false, message: parsed.error.message };
	return { ok: true, header: { item, index, source: rest, expression: parsed.expression } };
}

const headerCache = new Map<string, RepeatHeaderResult>();

/** Cached header parses, keyed by source. */
export function parseRepeatHeaderCached(source: string): RepeatHeaderResult {
	const hit = headerCache.get(source);
	if (hit) return hit;
	const result = parseRepeatHeader(source);
	if (headerCache.size > 512) headerCache.clear();
	headerCache.set(source, result);
	return result;
}

/**
 * The elements a header repeats over. A failing expression and a non-array value are
 * both an empty list: a repeat renders zero copies rather than aborting the render.
 */
export function evaluateRepeatItems(header: RepeatHeader, bindings: Record<string, unknown>): ExprValue[] {
	const value = evaluateAst(header.expression.ast, bindings);
	return Array.isArray(value) ? value : [];
}

/**
 * The bindings a copy evaluates against: the enclosing scope, with `$index`, the item
 * name, and the index name layered on top. Inner names shadow outer ones.
 */
export function repeatScope(
	bindings: Record<string, unknown>,
	header: RepeatHeader,
	item: ExprValue,
	index: number,
): Record<string, unknown> {
	const scope: Record<string, unknown> = { ...bindings };
	scope[REPEAT_INDEX_NAME] = index;
	scope[header.item] = item;
	if (header.index !== null) scope[header.index] = index;
	return scope;
}

/** A repeat's identity in a key: a string or a finite number. */
export type RepeatKey = string | number;

/**
 * How a repeat's copies are identified across updates.
 *
 * - `keyed`: every copy has a distinct `data-key`; updates patch by key
 * - `index`: `data-key` was present but produced a duplicate or invalid key, so copies
 *   fall back to their position
 * - `replace`: no `data-key`; updates replace the repeated range
 */
export type RepeatMode = "keyed" | "index" | "replace";

export type RepeatPatchOp =
	| { op: "remove"; key: RepeatKey; from: number }
	| { op: "insert"; key: RepeatKey; to: number }
	| { op: "reuse"; key: RepeatKey; from: number; to: number }
	| { op: "move"; key: RepeatKey; from: number; to: number };

/** Identifies a repeat across renders: its template's source path and the keys of the copies enclosing it. */
export interface RepeatSite {
	template: number[];
	within: RepeatKey[];
}

/** One `data-each` expansion in a bound tree. */
export interface FragmentRepeat {
	site: RepeatSite;
	/** Child-index path of the copies' parent in the bound tree; `[]` is the root. */
	path: number[];
	/** Index of the first copy among the parent's children. */
	start: number;
	count: number;
	/** The `data-each` source, verbatim. */
	expression: string;
	/** The `data-key` source, or `null` when the template has none. */
	key: string | null;
	mode: RepeatMode;
	keys: RepeatKey[];
	/** How to turn the previous render of this site into this one. */
	patch: RepeatPatchOp[];
}

export type RepeatKeyProblem = "invalid-key" | "duplicate-key";

export interface RepeatKeyResolution {
	mode: RepeatMode;
	keys: RepeatKey[];
	problem: RepeatKeyProblem | null;
}

function keyToken(key: RepeatKey): string {
	return typeof key === "number" ? `n:${key === 0 ? 0 : key}` : `s:${key}`;
}

function indexKeys(count: number): RepeatKey[] {
	return Array.from({ length: count }, (_, i) => i);
}

/**
 * Resolves a repeat's keys from each copy's evaluated `data-key`. A key must be a string
 * or a finite number. One invalid or duplicated key drops the whole repeat to index
 * keying, because a key set with a hole in it cannot say which copy is which.
 */
export function resolveRepeatKeys(keyValues: ExprValue[] | null): RepeatKeyResolution {
	if (keyValues === null) return { mode: "replace", keys: [], problem: null };
	const count = keyValues.length;
	const seen = new Set<string>();
	let duplicate = false;
	for (const value of keyValues) {
		if (typeof value !== "string" && !(typeof value === "number" && Number.isFinite(value))) {
			return { mode: "index", keys: indexKeys(count), problem: "invalid-key" };
		}
		const token = keyToken(value);
		if (seen.has(token)) duplicate = true;
		seen.add(token);
	}
	if (duplicate) return { mode: "index", keys: indexKeys(count), problem: "duplicate-key" };
	return { mode: "keyed", keys: keyValues as RepeatKey[], problem: null };
}

/** Index keys for a repeat with no `data-key`. */
export function replaceKeys(count: number): RepeatKey[] {
	return indexKeys(count);
}

/**
 * The indices of `sequence` that form its longest strictly increasing subsequence, by the
 * patience method: binary search for the leftmost tail not less than the value, then walk
 * predecessors back from the last tail. Every runtime runs this exact procedure, so a
 * sequence with more than one longest subsequence resolves the same way everywhere.
 */
export function longestIncreasingSubsequence(sequence: readonly number[]): number[] {
	const tails: number[] = [];
	const predecessors: number[] = new Array(sequence.length).fill(-1);
	for (let i = 0; i < sequence.length; i++) {
		const value = sequence[i];
		let lo = 0;
		let hi = tails.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (sequence[tails[mid]] < value) lo = mid + 1;
			else hi = mid;
		}
		predecessors[i] = lo > 0 ? tails[lo - 1] : -1;
		tails[lo] = i;
	}
	const result: number[] = new Array(tails.length);
	let cursor = tails.length > 0 ? tails[tails.length - 1] : -1;
	for (let k = tails.length - 1; k >= 0; k--) {
		result[k] = cursor;
		cursor = predecessors[cursor];
	}
	return result;
}

/**
 * Computes how a host turns the previous render of a repeat into the next one.
 *
 * With no previous render every copy is an insert. When either render is `replace`, or
 * the mode changed, the previous copies are all removed and the next ones all inserted:
 * nothing about identity carries over. Otherwise copies match by key. Removes come
 * first, in previous order; then every next copy in order is an `insert`, a `reuse`
 * (kept, and already in relative order), or a `move` (kept, but relocated). The kept
 * copies marked `reuse` are the longest run already in order, so a single removal or
 * insertion moves nothing.
 */
export function diffRepeat(
	previous: { mode: RepeatMode; keys: readonly RepeatKey[] } | null,
	next: { mode: RepeatMode; keys: readonly RepeatKey[] },
): RepeatPatchOp[] {
	const ops: RepeatPatchOp[] = [];
	if (previous === null) {
		next.keys.forEach((key, to) => ops.push({ op: "insert", key, to }));
		return ops;
	}
	if (next.mode === "replace" || previous.mode !== next.mode) {
		previous.keys.forEach((key, from) => ops.push({ op: "remove", key, from }));
		next.keys.forEach((key, to) => ops.push({ op: "insert", key, to }));
		return ops;
	}

	const previousIndex = new Map<string, number>();
	previous.keys.forEach((key, from) => previousIndex.set(keyToken(key), from));
	const nextTokens = new Set(next.keys.map(keyToken));

	previous.keys.forEach((key, from) => {
		if (!nextTokens.has(keyToken(key))) ops.push({ op: "remove", key, from });
	});

	const keptPositions: number[] = [];
	const keptFrom: number[] = [];
	next.keys.forEach((key, to) => {
		const from = previousIndex.get(keyToken(key));
		if (from !== undefined) {
			keptPositions.push(to);
			keptFrom.push(from);
		}
	});
	const stable = new Set(longestIncreasingSubsequence(keptFrom).map((i) => keptPositions[i]));

	next.keys.forEach((key, to) => {
		const from = previousIndex.get(keyToken(key));
		if (from === undefined) ops.push({ op: "insert", key, to });
		else ops.push({ op: stable.has(to) ? "reuse" : "move", key, from, to });
	});
	return ops;
}

/** A stable string for a site, for keying per-instance repeat state. */
export function repeatSiteId(site: RepeatSite): string {
	return JSON.stringify([site.template, site.within.map(keyToken)]);
}
