#!/usr/bin/env node
/**
 * XEG differential fuzzer. Generates expressions, interpolation texts, and `data-each`
 * headers across the whole grammar, runs each through the TypeScript, Rust, and C#
 * implementations, and reports every case where parse acceptance, classification, value,
 * rendering, or truthiness differ, shrunk to a minimal reproduction.
 *
 *   npm run fuzz:xeg -- [--seed N] [--count N] [--case I] [--impls ts,rust,cs]
 *                       [--minimize N] [--no-build] [--ts-only]
 *
 * See scripts/xeg-fuzz/README.md.
 */

import { build, loadCSharp, loadRust, loadTypeScript } from "./harness.mjs";
import { generateCase } from "./generate.mjs";
import { KNOWN } from "./known.mjs";

function parseArgs(argv) {
	const options = { seed: null, count: 5000, case: null, impls: ["ts", "rust", "cs"], minimize: 8, build: true, tsOnly: false, json: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const value = () => argv[++i];
		if (arg === "--seed") options.seed = Number(value()) >>> 0;
		else if (arg === "--count") options.count = Number(value());
		else if (arg === "--case") options.case = Number(value());
		else if (arg === "--impls") options.impls = value().split(",");
		else if (arg === "--minimize") options.minimize = Number(value());
		else if (arg === "--no-build") options.build = false;
		else if (arg === "--ts-only") options.tsOnly = true;
		else if (arg === "--json") options.json = true;
		else throw new Error(`unknown option ${arg}`);
	}
	if (options.tsOnly) options.impls = ["ts"];
	if (options.seed === null) options.seed = Math.floor(Math.random() * 2 ** 32) >>> 0;
	return options;
}

/** Structural equality where `-0` and `0` agree: no XEG operation can tell them apart. */
function same(a, b) {
	if (typeof a === "number" && typeof b === "number") return a === b;
	// A Rust host cannot hold a lone surrogate, so one leaves xript-expr as U+FFFD.
	if (typeof a === "string" && typeof b === "string") return a.toWellFormed() === b.toWellFormed();
	if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return a === b;
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	const ka = Object.keys(a);
	const kb = Object.keys(b);
	if (ka.length !== kb.length) return false;
	return ka.every((key) => Object.prototype.hasOwnProperty.call(b, key) && same(a[key], b[key]));
}

const FIELDS = {
	e: ["parse", "value", "render", "truthy"],
	s: ["segments", "issues", "resolved"],
	r: ["ok", "item", "index", "source", "items"],
};

/** The fields that disagree and which implementation is the odd one out, or `null` when all agree. */
function diverge(testCase, results) {
	const names = Object.keys(results);
	const problems = [];
	for (const name of names) {
		const result = results[name];
		if (result.crash || result.harnessError) problems.push(`${name}:crash`);
	}
	if (problems.length) return problems.join(" ");
	if (names.length < 2) return null;
	const fields = FIELDS[testCase.k].filter((field) => {
		const values = names.map((name) => results[name][field]);
		const compare = field === "issues" ? values.map((v) => v > 0) : values;
		return !compare.every((v) => same(v, compare[0]));
	});
	if (!fields.length) return null;
	const key = (name, field) => (field === "issues" ? results[name][field] > 0 : results[name][field]);
	const odd = names.filter((name) => {
		const others = names.filter((other) => other !== name);
		return fields.every((field) => others.every((other) => same(key(other, field), key(others[0], field))
			&& !same(key(name, field), key(other, field))));
	});
	return `${testCase.k}:${fields.join("+")}:${odd.length === 1 ? `${odd[0]}-differs` : "split"}`;
}

/** TypeScript-only invariants, cheap enough for CI: totality and self-consistency. */
function tsInvariant(testCase, result, xeg) {
	if (result.crash) return "ts:crash";
	if (testCase.k !== "e") return null;
	const value = xeg.evaluateExpression(testCase.src, testCase.b);
	if (result.render !== xeg.renderValue(value)) return "ts:render-unstable";
	if (result.truthy !== xeg.isTruthy(value)) return "ts:truthy-mismatch";
	if (typeof value === "number" && !Number.isFinite(value)) return "ts:non-finite";
	if (result.parse === null && value !== null) return "ts:unparsed-but-valued";
	return null;
}

async function evaluateAll(impls, testCase) {
	const entries = await Promise.all(impls.map(async (impl) => [impl.name, await impl.evaluate(testCase)]));
	return Object.fromEntries(entries);
}

function* shrinkSource(text) {
	const chars = Array.from(text);
	for (let size = Math.max(1, chars.length >> 1); size >= 1; size >>= 1) {
		for (let at = 0; at + size <= chars.length; at += size) {
			yield [...chars.slice(0, at), ...chars.slice(at + size)].join("");
		}
	}
}

function* shrinkValue(value) {
	if (value === null) return;
	yield null;
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) yield [...value.slice(0, i), ...value.slice(i + 1)];
		for (let i = 0; i < value.length; i++) {
			for (const smaller of shrinkValue(value[i])) yield value.map((item, j) => (j === i ? smaller : item));
		}
	} else if (typeof value === "object") {
		for (const key of Object.keys(value)) {
			const { [key]: _, ...rest } = value;
			yield rest;
		}
	} else if (typeof value === "string" && value.length > 1) {
		for (const smaller of shrinkSource(value)) yield smaller;
	}
}

function* shrinkCase(testCase) {
	const textKey = testCase.k === "s" ? "text" : "src";
	for (const text of shrinkSource(testCase[textKey])) yield { ...testCase, [textKey]: text };
	for (const name of Object.keys(testCase.b)) {
		const { [name]: _, ...rest } = testCase.b;
		yield { ...testCase, b: rest };
	}
	for (const name of Object.keys(testCase.b)) {
		for (const smaller of shrinkValue(testCase.b[name])) yield { ...testCase, b: { ...testCase.b, [name]: smaller } };
	}
}

async function minimize(impls, testCase, signature, check) {
	let current = testCase;
	let budget = 4000;
	let progress = true;
	while (progress && budget > 0) {
		progress = false;
		for (const candidate of shrinkCase(current)) {
			if (--budget <= 0) break;
			const results = await evaluateAll(impls, candidate);
			if (check(candidate, results) === signature) {
				current = candidate;
				progress = true;
				break;
			}
		}
	}
	return current;
}

function show(value) {
	let out = "";
	for (const ch of JSON.stringify(value)) {
		out += ch.length === 1 && ch.charCodeAt(0) < 0x7f
			? ch
			: Array.from({ length: ch.length }, (_, i) => `\\u${ch.charCodeAt(i).toString(16).padStart(4, "0")}`).join("");
	}
	return out;
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.build) build(options.impls);

	const impls = [];
	let ts = null;
	if (options.impls.includes("ts")) impls.push((ts = await loadTypeScript()));
	if (options.impls.includes("rust")) impls.push(loadRust());
	if (options.impls.includes("cs")) impls.push(loadCSharp());

	const check = (testCase, results) => {
		const signature = diverge(testCase, results)
			?? (ts && options.impls.length === 1 ? tsInvariant(testCase, results.ts, ts.xeg) : null);
		if (!signature || signature.includes("crash") || signature.startsWith("known:")) return signature;
		const known = KNOWN.find((entry) => entry.applies(testCase));
		return known ? `known:${known.id}` : signature;
	};

	const indices = options.case !== null
		? [options.case]
		: Array.from({ length: options.count }, (_, i) => i);
	console.log(`xeg-fuzz: seed ${options.seed}, ${indices.length} case(s), implementations ${options.impls.join(", ")}`);

	const groups = new Map();
	const BATCH = 500;
	for (let start = 0; start < indices.length; start += BATCH) {
		const batch = indices.slice(start, start + BATCH);
		const outcomes = await Promise.all(batch.map(async (index) => {
			const testCase = generateCase(options.seed, index);
			const results = await evaluateAll(impls, testCase);
			return { index, testCase, results, signature: check(testCase, results) };
		}));
		for (const outcome of outcomes) {
			if (!outcome.signature) continue;
			if (!groups.has(outcome.signature)) groups.set(outcome.signature, []);
			groups.get(outcome.signature).push(outcome);
		}
	}

	const knownGroups = [...groups].filter(([signature]) => signature.startsWith("known:"));
	const newGroups = [...groups].filter(([signature]) => !signature.startsWith("known:"));

	for (const [signature, outcomes] of knownGroups) {
		const entry = KNOWN.find((known) => `known:${known.id}` === signature);
		console.log(`\n- ${signature}  (${outcomes.length} case(s), awaiting a decision; first: --seed ${options.seed} --case ${outcomes[0].index})\n  ${entry.summary}`);
	}

	let shown = 0;
	for (const [signature, outcomes] of newGroups) {
		console.log(`\n✖ ${signature}  (${outcomes.length} case(s); first: --seed ${options.seed} --case ${outcomes[0].index})`);
		if (shown++ >= options.minimize) continue;
		const minimal = await minimize(impls, outcomes[0].testCase, signature, check);
		const results = await evaluateAll(impls, minimal);
		console.log(`  case: ${show(minimal)}`);
		for (const [name, result] of Object.entries(results)) console.log(`  ${name.padEnd(4)}: ${show(result)}`);
	}

	for (const impl of impls) impl.close();
	const total = newGroups.reduce((sum, [, list]) => sum + list.length, 0);
	console.log(total === 0
		? `\nxeg-fuzz: clean (${indices.length} case(s), seed ${options.seed})`
		: `\nxeg-fuzz: ${total} divergent case(s) in ${newGroups.length} group(s), seed ${options.seed}`);
	process.exitCode = total === 0 ? 0 : 1;
}

main().catch((error) => {
	console.error(error);
	process.exit(2);
});
