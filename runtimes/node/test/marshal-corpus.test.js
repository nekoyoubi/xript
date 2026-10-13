import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRuntime } from "../dist/index.js";

const corpus = JSON.parse(
	readFileSync(fileURLToPath(new URL("../../../spec/marshal-tests.json", import.meta.url)), "utf8"),
);

const manifest = {
	xript: "0.1",
	name: "marshal-probe",
	bindings: { value: { description: "Returns the case's host value." } },
};

describe("marshal corpus", () => {
	for (const testCase of corpus.cases) {
		it(testCase.description, () => {
			const runtime = createRuntime(manifest, {
				hostBindings: { value: () => JSON.parse(testCase.hostValue) },
			});
			const result = runtime.execute(`(function () { var v = value(); return (${testCase.probe}); })()`);
			assert.equal(result.value, testCase.expected);
		});
	}
});
