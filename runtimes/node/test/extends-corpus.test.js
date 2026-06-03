import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveExtends, ManifestResolutionError } from "../../../tools/validate/dist/index.js";

const corpusPath = fileURLToPath(new URL("../../../spec/extends-tests.json", import.meta.url));
const cases = JSON.parse(readFileSync(corpusPath, "utf-8"));

describe("extends corpus", () => {
	let tmpDir;

	before(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "xript-extends-node-"));
	});

	after(async () => {
		if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
	});

	cases.forEach((testCase, i) => {
		it(testCase.description, async () => {
			const basePath = join(tmpDir, `base-${i}.json`);
			await writeFile(basePath, JSON.stringify(testCase.base), "utf-8");
			const child = { ...testCase.extender, extends: basePath };

			if (testCase.error === true) {
				await assert.rejects(() => resolveExtends(child, tmpDir), ManifestResolutionError);
			} else {
				const resolved = await resolveExtends(child, tmpDir);
				assert.deepStrictEqual(resolved, testCase.resolved);
			}
		});
	});
});
