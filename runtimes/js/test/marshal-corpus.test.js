import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { initXript, initXriptAsync } from "../dist/index.js";

const corpus = JSON.parse(
	readFileSync(fileURLToPath(new URL("../../../spec/marshal-tests.json", import.meta.url)), "utf8"),
);

const manifest = {
	xript: "0.1",
	name: "marshal-probe",
	bindings: { value: { description: "Returns the case's host value." } },
};

const script = (probe) => `(function () { var v = value(); return (${probe}); })()`;

describe("marshal corpus", () => {
	let xript;
	let xriptAsync;
	before(async () => {
		xript = await initXript();
		xriptAsync = await initXriptAsync();
	});

	for (const testCase of corpus.cases) {
		it(testCase.description, () => {
			const runtime = xript.createRuntime(manifest, {
				hostBindings: { value: () => JSON.parse(testCase.hostValue) },
			});
			try {
				assert.equal(runtime.execute(script(testCase.probe)).value, testCase.expected);
			} finally {
				runtime.dispose();
			}
		});

		it(`${testCase.description} (async sandbox)`, async () => {
			const runtime = await xriptAsync.createRuntime(manifest, {
				hostBindings: { value: () => JSON.parse(testCase.hostValue) },
			});
			try {
				const result = await runtime.execute(script(testCase.probe));
				assert.equal(result.value, testCase.expected);
			} finally {
				runtime.dispose();
			}
		});
	}
});
