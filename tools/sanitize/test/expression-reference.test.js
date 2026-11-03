import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
	BUILTINS,
	BUILTIN_NAMES,
	EXPRESSION_REFERENCE,
	REPEAT_INDEX_NAME,
	builtinArity,
	evaluateExpression,
	parseExpression,
} from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const specDir = resolve(__dirname, "../../../spec");
const spec = JSON.parse(await readFile(resolve(specDir, "expression-reference.json"), "utf-8"));
const corpus = JSON.parse(await readFile(resolve(specDir, "expression-tests.json"), "utf-8"));
const prose = await readFile(resolve(specDir, "expressions.md"), "utf-8");

const examples = [
	...EXPRESSION_REFERENCE.builtins.flatMap((b) => b.examples.map((e, i) => ({ id: `builtin ${b.name} #${i + 1}`, ...e }))),
	...EXPRESSION_REFERENCE.operators.flatMap((o) => o.examples.map((e, i) => ({ id: `operator ${o.name} #${i + 1}`, ...e }))),
];

describe("expression reference: the shipped copy", () => {
	it("is the spec file, unaltered", () => {
		assert.deepEqual(EXPRESSION_REFERENCE, spec);
	});

	it("is frozen all the way down", () => {
		assert.ok(Object.isFrozen(EXPRESSION_REFERENCE));
		assert.ok(Object.isFrozen(EXPRESSION_REFERENCE.builtins[0].params));
		assert.throws(() => {
			EXPRESSION_REFERENCE.builtins[0].summary = "changed";
		});
	});
});

describe("expression reference: the builtin table is derived from it", () => {
	it("names every builtin, in reference order", () => {
		assert.deepEqual(BUILTIN_NAMES, spec.builtins.map((b) => b.name));
	});

	it("takes each arity from the signature", () => {
		for (const builtin of spec.builtins) {
			assert.deepEqual(BUILTINS[builtin.name], builtinArity(builtin), builtin.name);
		}
		assert.deepEqual(BUILTINS.min, [1, Infinity]);
		assert.deepEqual(BUILTINS.pad, [2, 3]);
		assert.deepEqual(BUILTINS.clamp, [3, 3]);
	});

	it("parses a call at each end of the signature and rejects one past it", () => {
		for (const builtin of spec.builtins) {
			const [min, max] = builtinArity(builtin);
			const call = (n) => `${builtin.name}(${Array.from({ length: n }, () => "1").join(", ")})`;
			assert.doesNotThrow(() => parseExpression(call(min)), builtin.name);
			if (Number.isFinite(max)) {
				assert.doesNotThrow(() => parseExpression(call(max)), builtin.name);
				assert.throws(() => parseExpression(call(max + 1)), builtin.name);
			}
			if (min > 0) assert.throws(() => parseExpression(call(min - 1)), builtin.name);
		}
	});

	it("puts optional and variadic parameters only at the tail", () => {
		for (const builtin of spec.builtins) {
			let seenOptional = false;
			builtin.params.forEach((param, i) => {
				if (param.optional) seenOptional = true;
				else assert.ok(!seenOptional, `${builtin.name}: required ${param.name} follows an optional one`);
				if (param.variadic) assert.equal(i, builtin.params.length - 1, `${builtin.name}: variadic ${param.name} is not last`);
			});
		}
	});
});

describe("expression reference: it agrees with the rest of the spec", () => {
	it("lists the same builtins as the prose table", () => {
		const section = prose.slice(prose.indexOf("## Builtins"), prose.indexOf("## Semantics"));
		const table = section.slice(0, section.indexOf("Extensible only"));
		const named = new Set([...table.matchAll(/`([a-z]+)[(`]/g)].map((m) => m[1]));
		assert.deepEqual([...named].sort(), spec.builtins.map((b) => b.name).sort());
	});

	it("documents the repeat index name the runtime binds", () => {
		assert.ok(spec.scopeNames.some((s) => s.name === REPEAT_INDEX_NAME));
	});

	it("orders operator precedence the way the parser binds", () => {
		const level = (symbol, form) => spec.operators.find((o) => o.symbol === symbol && o.form === form).precedence;
		assert.ok(level("*", "binary") > level("+", "binary"));
		assert.ok(level("??", "binary") < level("||", "binary"));
		assert.ok(level("-", "prefix") > level("*", "binary"));
		assert.equal(evaluateExpression("1 + 2 * 3", {}), 7);
		assert.equal(evaluateExpression("null ?? 1 || 2", {}), 1);
		assert.equal(evaluateExpression("true ? 1 : false ? 2 : 3", {}), 1);
		assert.equal(evaluateExpression("-2 * 3", {}), -6);
		const levels = spec.operators.map((o) => o.precedence);
		assert.deepEqual(levels, [...levels].sort((a, b) => a - b), "operators are listed loosest-binding first");
	});
});

describe("expression reference: every example is a conformance case", () => {
	for (const example of examples) {
		it(`${example.id}: ${example.expression}`, () => {
			const bindings = example.bindings ?? corpus.defaultBindings;
			assert.deepEqual(evaluateExpression(example.expression, bindings), example.expect);
		});
	}
});
