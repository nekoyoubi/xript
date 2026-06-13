import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { satisfies, grantedSatisfies } from "../dist/index.js";

const corpusPath = fileURLToPath(new URL("../../../spec/capability-tests.json", import.meta.url));
const cases = JSON.parse(readFileSync(corpusPath, "utf-8"));

describe("capability corpus", () => {
	cases.forEach((testCase) => {
		it(testCase.description, () => {
			if (Array.isArray(testCase.granted)) {
				const result = grantedSatisfies(new Set(testCase.granted), testCase.require);
				assert.strictEqual(result, testCase.expected);
			} else {
				const result = satisfies(testCase.grant, testCase.require);
				assert.strictEqual(result, testCase.expected);
			}
		});
	});
});
