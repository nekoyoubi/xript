import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRuntime } from "../dist/index.js";

const corpus = JSON.parse(
	readFileSync(fileURLToPath(new URL("../../../spec/console-tests.json", import.meta.url)), "utf8"),
);

const MARKER = "$xript";

/** Spells what the console handler received the way the corpus does; anything but plain data is spelled as a mismatch. */
function encode(value, ancestors = []) {
	if (value === undefined) return { [MARKER]: "undefined" };
	if (typeof value === "number") {
		if (Number.isNaN(value)) return { [MARKER]: "NaN" };
		if (value === Infinity) return { [MARKER]: "Infinity" };
		if (value === -Infinity) return { [MARKER]: "-Infinity" };
		if (Object.is(value, -0)) return { [MARKER]: "-0" };
		return value;
	}
	if (typeof value === "bigint") return { [MARKER]: "bigint", value: String(value) };
	if (typeof value === "symbol") {
		return value.description === undefined ? { [MARKER]: "symbol" } : { [MARKER]: "symbol", description: value.description };
	}
	if (typeof value === "string") {
		return value.isWellFormed() ? value : { [MARKER]: "string", units: Array.from({ length: value.length }, (_, i) => value.charCodeAt(i)) };
	}
	if (typeof value === "function") return { $host: "function" };
	if (value === null || typeof value !== "object") return value;
	const proto = Object.getPrototypeOf(value);
	if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) return { $host: Object.prototype.toString.call(value) };
	const at = ancestors.lastIndexOf(value);
	if (at !== -1) return { [MARKER]: "cycle", up: ancestors.length - at };
	ancestors.push(value);
	try {
		if (Array.isArray(value)) return Array.from({ length: value.length }, (_, i) => encode(value[i], ancestors));
		const out = {};
		for (const key of Object.keys(value)) {
			Object.defineProperty(out, key, { value: encode(value[key], ancestors), writable: true, enumerable: true, configurable: true });
		}
		return out;
	} finally {
		ancestors.pop();
	}
}

function isMatcher(expected) {
	return expected !== null && typeof expected === "object" && !Array.isArray(expected) && Object.hasOwn(expected, "$expect");
}

/** Compares an encoded value to its expectation at every depth, key order included, honouring `$expect` matchers. */
function check(actual, expected, path) {
	if (isMatcher(expected)) {
		assert.equal(typeof actual, "string", `${path}: expected a string, got ${JSON.stringify(actual)}`);
		if (expected.prefix !== undefined) assert.ok(actual.startsWith(expected.prefix), `${path}: ${JSON.stringify(actual)} does not start with ${JSON.stringify(expected.prefix)}`);
		if (expected.suffix !== undefined) assert.ok(actual.endsWith(expected.suffix), `${path}: ${JSON.stringify(actual)} does not end with ${JSON.stringify(expected.suffix)}`);
		return;
	}
	if (expected === null || typeof expected !== "object") {
		assert.deepEqual(actual, expected, path);
		return;
	}
	assert.equal(Array.isArray(actual), Array.isArray(expected), `${path}: ${JSON.stringify(actual)} vs ${JSON.stringify(expected)}`);
	assert.ok(actual !== null && typeof actual === "object", `${path}: expected an object, got ${JSON.stringify(actual)}`);
	const present = Object.keys(expected).filter((key) => Object.hasOwn(actual, key) || !(isMatcher(expected[key]) && expected[key].optional === true));
	assert.deepEqual(Object.keys(actual), present, `${path}: keys`);
	for (const key of present) check(actual[key], expected[key], `${path}.${key}`);
}

describe("console corpus", () => {
	for (const testCase of corpus.cases) {
		it(testCase.name, () => {
			const logs = [];
			const runtime = createRuntime(corpus.manifest, {
				hostBindings: {},
				console: { onLog: (severity, ...args) => logs.push({ severity, args }) },
			});
			try {
				assert.equal(runtime.execute(testCase.script).value, corpus.sentinel);
			} finally {
				runtime.dispose();
			}
			assert.equal(logs.length, testCase.logs.length, "console call count");
			testCase.logs.forEach((expected, index) => {
				assert.equal(logs[index].severity, expected.severity, `logs[${index}].severity`);
				check(logs[index].args.map((arg) => encode(arg)), expected.args, `logs[${index}].args`);
			});
		});
	}
});

describe("console reading under an execution limit", () => {
	it("a getter that exhausts the budget still ends the script", () => {
		const runtime = createRuntime({ ...corpus.manifest, limits: { timeout_ms: 50 } }, { hostBindings: {}, console: { onLog: () => {} } });
		try {
			assert.throws(() => runtime.execute("console.log({ get spin() { for (;;) {} } }); 'continued'"), (e) => e.name === "ExecutionLimitError");
			assert.equal(runtime.execute("console.log('after'); 1 + 1").value, 2);
		} finally {
			runtime.dispose();
		}
	});
});
