import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRuntime } from "../dist/index.js";

const corpus = JSON.parse(readFileSync(fileURLToPath(new URL("../../../spec/async-tests.json", import.meta.url)), "utf8"));

const hostBindings = {
	slow: (ms, value) => new Promise((resolve) => setTimeout(() => resolve(value), ms)),
	fail: (message) => new Promise((_, reject) => setTimeout(() => reject(new Error(message)), 1)),
	sync: () => "sync",
};

/** Spells a result the corpus way: only `undefined` needs a marker here. */
const spell = (value) => (value === undefined ? { $xript: "undefined" } : value);

describe("async corpus", () => {
	for (const testCase of corpus.exportAsync) {
		it(`exportAsync: ${testCase.name}`, async () => {
			const runtime = createRuntime(corpus.manifest, { hostBindings });
			try {
				runtime.loadMod(corpus.mod.manifest, { fragmentSources: { [corpus.mod.manifest.entry.script]: corpus.mod.source } });
				const value = await runtime.invokeModExportAsync(corpus.mod.manifest.name, testCase.export, testCase.args);
				assert.deepEqual(spell(value), testCase.expected);
			} finally {
				runtime.dispose();
			}
		});
	}

	for (const section of ["body", "promise"]) {
		for (const testCase of corpus[section]) {
			it(`${section}: ${testCase.name}`, async () => {
				const runtime = createRuntime(corpus.manifest, { hostBindings });
				try {
					assert.deepEqual(spell((await runtime.executeAsync(testCase.script)).value), testCase.expected);
				} finally {
					runtime.dispose();
				}
			});
		}
	}
});
