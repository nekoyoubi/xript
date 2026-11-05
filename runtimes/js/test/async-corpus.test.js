import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { initXript, initXriptAsync } from "../dist/index.js";

const corpus = JSON.parse(readFileSync(fileURLToPath(new URL("../../../spec/async-tests.json", import.meta.url)), "utf8"));

const hostBindings = {
	slow: (ms, value) => new Promise((resolve) => setTimeout(() => resolve(value), ms)),
	fail: (message) => new Promise((_, reject) => setTimeout(() => reject(new Error(message)), 1)),
	sync: () => "sync",
};

/** Spells a result the corpus way: only `undefined` needs a marker here. */
const spell = (value) => (value === undefined ? { $xript: "undefined" } : value);

describe("async corpus (asyncify sandbox)", () => {
	let xript;
	before(async () => {
		xript = await initXriptAsync();
	});

	for (const section of ["body", "promise"]) {
		for (const testCase of corpus[section]) {
			it(`${section}: ${testCase.name}`, async () => {
				const runtime = await xript.createRuntime(corpus.manifest, { hostBindings });
				try {
					assert.deepEqual(spell((await runtime.executeAsync(testCase.script)).value), testCase.expected);
				} finally {
					runtime.dispose();
				}
			});
		}
	}

	const withMod = async () => {
		const runtime = await xript.createRuntime(corpus.manifest, { hostBindings });
		runtime.loadMod(corpus.mod.manifest, { fragmentSources: { [corpus.mod.manifest.entry.script]: corpus.mod.source } });
		return runtime;
	};

	for (const testCase of corpus.exportAsync) {
		it(`exportAsync: ${testCase.name}`, async () => {
			const runtime = await withMod();
			try {
				const value = await runtime.invokeModExportAsync(corpus.mod.manifest.name, testCase.export, testCase.args);
				assert.deepEqual(spell(value), testCase.expected);
			} finally {
				runtime.dispose();
			}
		});
	}

	for (const testCase of corpus.exportSync) {
		it(`exportSync: ${testCase.name}`, async () => {
			const runtime = await withMod();
			try {
				assert.throws(() => runtime.invokeModExport(corpus.mod.manifest.name, testCase.export, testCase.args), (error) => {
					assert.ok(String(error.message).includes(testCase.error), `got ${error.message}`);
					return true;
				});
				assert.deepEqual(spell((await runtime.executeAsync(testCase.after)).value), testCase.expected);
			} finally {
				runtime.dispose();
			}
		});
	}

	for (const testCase of corpus.syncReach) {
		it(`syncReach: ${testCase.name}`, async () => {
			const runtime = await xript.createRuntime(corpus.manifest, { hostBindings });
			try {
				const message = runtime.execute(testCase.script).value;
				assert.equal(typeof message, "string");
				assert.ok(message.startsWith(testCase.error), `expected a message beginning ${testCase.error}, got ${message}`);
				assert.ok(!message.startsWith(testCase.error + testCase.error), `the prefix repeats: ${message}`);
				assert.deepEqual(spell((await runtime.executeAsync(testCase.after)).value), testCase.expected);
			} finally {
				runtime.dispose();
			}
		});
	}
});

for (const variant of ["sync", "async"]) {
	describe(`async corpus: execute refuses a promise result (${variant} sandbox)`, () => {
		let xript;
		before(async () => {
			xript = variant === "sync" ? await initXript() : await initXriptAsync();
		});

		for (const testCase of corpus.executeResult) {
			it(`executeResult: ${testCase.name}`, async () => {
				const runtime = await xript.createRuntime(corpus.manifest, { hostBindings, console: {} });
				try {
					assert.throws(() => runtime.execute(testCase.script), /executeAsync/);
					assert.equal(runtime.execute("1 + 1").value, 2);
				} finally {
					runtime.dispose();
				}
			});
		}
	});
}
