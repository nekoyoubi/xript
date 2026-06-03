import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const corpusPath = resolve(__dirname, "../../../spec/extends-tests.json");

const { resolveExtends, ManifestResolutionError } = await import("../dist/index.js");

const corpus = JSON.parse(await readFile(corpusPath, "utf-8"));

describe("extends shared corpus against @xriptjs/validate resolver", () => {
	let tmpDir;

	before(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "xript-extends-corpus-"));
	});

	after(async () => {
		if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
	});

	corpus.forEach((testCase, i) => {
		const isError = testCase.error === true;
		const label = `case ${i}: ${testCase.description}`;

		it(label, async () => {
			const basePath = join(tmpDir, `base-${i}.json`);
			await writeFile(basePath, JSON.stringify(testCase.base), "utf-8");

			const child = { ...testCase.extender, extends: basePath };

			if (isError) {
				await assert.rejects(
					() => resolveExtends(child, tmpDir),
					ManifestResolutionError,
				);
				return;
			}

			const result = await resolveExtends(child, tmpDir);
			assert.deepStrictEqual(result, testCase.resolved);
		});
	});
});
