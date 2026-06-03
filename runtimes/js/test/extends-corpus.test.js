import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ManifestValidationError, resolveExtends } from "../dist/index.js";

const corpusPath = fileURLToPath(
	new URL("../../../spec/extends-tests.json", import.meta.url),
);
const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));

const tmpDir = mkdtempSync(join(tmpdir(), "xript-extends-"));
const loader = (path) => JSON.parse(readFileSync(path, "utf8"));

describe("extends corpus", () => {
	corpus.forEach((testCase, i) => {
		it(testCase.description, () => {
			const basePath = join(tmpDir, `base-${i}.json`);
			writeFileSync(basePath, JSON.stringify(testCase.base));
			const child = { ...testCase.extender, extends: basePath };

			if (testCase.error === true) {
				assert.throws(() => resolveExtends(child, tmpDir, loader), ManifestValidationError);
				return;
			}

			const resolved = resolveExtends(child, tmpDir, loader);
			assert.deepStrictEqual(resolved, testCase.resolved);
		});
	});
});
