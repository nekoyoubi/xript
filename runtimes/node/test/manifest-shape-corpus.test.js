import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRuntime, ManifestValidationError } from "../dist/index.js";

const corpus = JSON.parse(
	readFileSync(fileURLToPath(new URL("../../../spec/manifest-shape-tests.json", import.meta.url)), "utf8"),
);

describe("manifest shape corpus", () => {
	it("carries cases", () => {
		assert.ok(corpus.cases.length > 0);
	});

	for (const entry of corpus.cases) {
		it(entry.name, () => {
			if (entry.valid) {
				createRuntime(entry.manifest, { hostBindings: {}, capabilities: [] }).dispose();
				return;
			}
			assert.throws(
				() => createRuntime(entry.manifest, { hostBindings: {}, capabilities: [] }),
				(error) => {
					assert.ok(error instanceof ManifestValidationError);
					assert.deepEqual(error.issues, entry.issues);
					return true;
				},
			);
		});
	}
});

describe("variadic parameters at call time", () => {
	it("passes every argument through to a binding whose last parameter is variadic", () => {
		const received = [];
		const runtime = createRuntime(
			{
				xript: "0.9",
				name: "probe",
				bindings: {
					log: {
						description: "Logs.",
						params: [
							{ name: "level", type: "string" },
							{ name: "parts", type: "string", variadic: true },
						],
					},
				},
			},
			{ hostBindings: { log: (...args) => received.push(args) }, capabilities: [] },
		);
		try {
			runtime.execute('log("info", "a", "b", "c")');
			assert.deepEqual(received, [["info", "a", "b", "c"]]);
		} finally {
			runtime.dispose();
		}
	});
});
