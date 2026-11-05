import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRuntime } from "../dist/index.js";

const corpus = JSON.parse(readFileSync(fileURLToPath(new URL("../../../spec/binding-error-tests.json", import.meta.url)), "utf8"));

const hostBindings = {
	boom: () => {
		throw new Error("boom");
	},
	prefixed: () => {
		throw new Error("prefixed(): already");
	},
	gated: () => 1,
	takesFn: () => 1,
	deep: () => 1,
	nested: {
		inner: () => {
			throw new Error("inner fail");
		},
	},
	later: async () => {
		throw new Error("nope");
	},
};

function assertShape(actual, expected) {
	if (Array.isArray(expected) || typeof expected !== "object" || expected === null) {
		assert.deepEqual(actual, expected);
		return;
	}
	assert.equal(typeof actual, "object", `expected a thrown error, got ${JSON.stringify(actual)}`);
	for (const [field, want] of Object.entries(expected)) {
		if (field === "messageStartsWith") assert.ok(actual.message.startsWith(want), `message ${JSON.stringify(actual.message)}`);
		else assert.deepEqual(actual[field], want, `${field} in ${JSON.stringify(actual)}`);
	}
}

describe("binding error corpus", () => {
	for (const testCase of corpus.cases) {
		it(testCase.name, async () => {
			const runtime = createRuntime(corpus.manifest, { hostBindings });
			try {
				runtime.execute(corpus.setup);
				const result = testCase.async ? await runtime.executeAsync(testCase.script) : runtime.execute(testCase.script);
				assertShape(result.value, testCase.expected);
			} finally {
				runtime.dispose();
			}
		});
	}
});
