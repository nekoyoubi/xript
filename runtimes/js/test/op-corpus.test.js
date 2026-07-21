import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveFormatProfile } from "@xriptjs/sanitize";
import { finalizeOps } from "../dist/index.js";

const corpusPath = fileURLToPath(
	new URL("../../../spec/fragment-op-tests.json", import.meta.url),
);
const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));

describe("fragment op corpus", () => {
	corpus.forEach((testCase) => {
		it(testCase.description, () => {
			const profile = resolveFormatProfile(testCase.format, testCase.formats ?? null, testCase.vocabularies ?? null);
			assert.ok(profile, `format "${testCase.format}" did not resolve`);

			const diagnostics = [];
			const ops = finalizeOps(
				structuredClone(testCase.ops),
				profile,
				(diagnostic) => diagnostics.push(diagnostic),
			);

			assert.deepEqual(JSON.parse(JSON.stringify(ops)), testCase.expected.ops, "ops");
			assert.deepEqual(diagnostics, testCase.expected.diagnostics, "diagnostics");
		});
	});
});
