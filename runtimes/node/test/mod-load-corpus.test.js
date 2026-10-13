import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import {
	createRuntime,
	ModEntryError,
	MissingEntryScriptError,
	ModuleUnsupportedError,
	createModInstance,
	looksLikeMarkup,
	modEntryScripts,
	modEntryExports,
	modEntryFormat,
} from "../dist/index.js";

const skipModuleEval = typeof vm.SourceTextModule === "function" ? false : "requires --experimental-vm-modules";

const corpusPath = fileURLToPath(new URL("../../../spec/mod-load-tests.json", import.meta.url));
const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));

const ERROR_TYPES = {
	"missing-entry-script": MissingEntryScriptError,
	"entry-failed": ModEntryError,
};


function runtimeFor(testCase, extra = {}) {
	return createRuntime(corpus.host, {
		hostBindings: {},
		entryErrors: testCase.entryErrors,
		...extra,
	});
}

function assertDiagnostics(actual, expected, modName) {
	assert.equal(actual.length, expected.length, JSON.stringify(actual, null, 2));
	expected.forEach((want, index) => {
		const got = actual[index];
		assert.equal(got.mod, modName);
		assert.equal(typeof got.message, "string");
		for (const [key, value] of Object.entries(want)) {
			assert.equal(got[key], value, `diagnostic ${index} field ${key}: ${JSON.stringify(got)}`);
		}
	});
}

describe("mod load corpus (node)", () => {
	for (const testCase of corpus.cases) {
		it(testCase.name, () => {
			const seen = [];
			const runtime = runtimeFor(testCase, { onModDiagnostic: (d) => seen.push(d) });
			try {
				if (testCase.error) {
					const ErrorType = ERROR_TYPES[testCase.error];
					assert.throws(
						() => runtime.loadMod(testCase.mod, { fragmentSources: testCase.sources }),
						(err) => {
							assert.ok(err instanceof ErrorType, `expected ${ErrorType.name}, got ${err?.name}: ${err?.message}`);
							for (const needle of testCase.mentions ?? []) {
								assert.ok(err.message.includes(needle), `"${err.message}" should mention "${needle}"`);
							}
							return true;
						},
					);
					return;
				}

				const mod = runtime.loadMod(testCase.mod, { fragmentSources: testCase.sources });
				assertDiagnostics(mod.diagnostics, testCase.diagnostics, testCase.mod.name);
				assert.deepEqual(seen, mod.diagnostics);

				if (testCase.bindingField) {
					const { fragmentId, binding, field, value } = testCase.bindingField;
					const fragment = mod.fragments.find((f) => f.id === fragmentId);
					const declared = fragment.declaration.bindings.find((b) => b.name === binding);
					assert.equal(declared[field], value);
				}
			} finally {
				runtime.dispose();
			}
		});
	}
});

describe("entry error policy (node)", () => {
	it("defaults to throw and still sends the failure to onModDiagnostic", () => {
		const seen = [];
		const runtime = createRuntime(corpus.host, { hostBindings: {}, onModDiagnostic: (d) => seen.push(d) });
		assert.throws(
			() => runtime.loadMod({ xript: "0.9", name: "mod-a", version: "1.0.0", entry: "main.js" }),
			MissingEntryScriptError,
		);
		assert.deepEqual(seen.map((d) => d.code), ["missing-entry-script"]);
		runtime.dispose();
	});

	it("does not run any entry script when one of them is missing", () => {
		const runtime = createRuntime(corpus.host, { hostBindings: {}, entryErrors: "report" });
		runtime.loadMod(
			{ xript: "0.9", name: "mod-a", version: "1.0.0", entry: ["a.js", "b.js"] },
			{ fragmentSources: { "a.js": "globalThis.ranA = true;" } },
		);
		assert.equal(runtime.execute("typeof globalThis.ranA").value, "undefined");
		runtime.dispose();
	});

	it("keeps a typed entry error's type", () => {
		const runtime = createRuntime(corpus.host, { hostBindings: {}, hardLimits: { timeout_ms: 50 } });
		assert.throws(
			() => runtime.loadMod(
				{ xript: "0.9", name: "mod-a", version: "1.0.0", entry: "main.js" },
				{ fragmentSources: { "main.js": "while (true) {}" } },
			),
			(err) => err.name === "ExecutionLimitError",
		);
		runtime.dispose();
	});

	it("registers a mod whose entry failed under the report policy", () => {
		const runtime = createRuntime(corpus.host, { hostBindings: {}, entryErrors: "report" });
		runtime.loadMod(
			{
				xript: "0.9",
				name: "mod-a",
				version: "1.0.0",
				entry: "main.js",
				fills: { panel: [{ format: "text/html", source: "<p>still here</p>", inline: true }] },
			},
			{ fragmentSources: { "main.js": "throw new Error('boom');" } },
		);
		assert.equal(runtime.resolveSlot("panel").length, 1);
		runtime.dispose();
	});

	it("a throwing onModDiagnostic listener does not change the outcome", () => {
		const runtime = createRuntime(corpus.host, {
			hostBindings: {},
			onModDiagnostic: () => { throw new Error("listener broke"); },
		});
		const mod = runtime.loadMod({
			xript: "0.9",
			name: "mod-a",
			version: "1.0.0",
			fills: { panel: [{ format: "text/html", source: "<p>x</p>" }] },
		});
		assert.equal(mod.diagnostics.length, 1);
		runtime.dispose();
	});

	it("a module entry that throws under the report policy loads with a diagnostic", { skip: skipModuleEval }, async () => {
		const runtime = createRuntime(corpus.host, { hostBindings: {}, entryErrors: "report" });
		const mod = await runtime.loadModAsync(
			{ xript: "0.9", name: "mod-a", version: "1.0.0", entry: { script: "main.js", format: "module" } },
			{ fragmentSources: { "main.js": "throw new Error('boom'); export function f() {}" } },
		);
		assert.deepEqual(mod.diagnostics.map((d) => d.code), ["entry-failed"]);
		assert.match(mod.diagnostics[0].message, /boom/);
		runtime.dispose();
	});

	it("a module entry naming an unsupplied script rejects", async () => {
		const runtime = createRuntime(corpus.host, { hostBindings: {} });
		await assert.rejects(
			runtime.loadModAsync({ xript: "0.9", name: "mod-a", version: "1.0.0", entry: { script: "main.js", format: "module" } }),
			MissingEntryScriptError,
		);
		runtime.dispose();
	});

	it("a module entry through the sync loadMod is still a host configuration error", () => {
		const runtime = createRuntime(corpus.host, { hostBindings: {}, entryErrors: "report" });
		assert.throws(
			() => runtime.loadMod(
				{ xript: "0.9", name: "mod-a", version: "1.0.0", entry: { script: "main.js", format: "module" } },
				{ fragmentSources: { "main.js": "export function f() {}" } },
			),
			ModuleUnsupportedError,
		);
		runtime.dispose();
	});
});

describe("mod entry rule exports (node)", () => {
	it("modEntryScripts reads every entry form", () => {
		assert.deepEqual(modEntryScripts(undefined), []);
		assert.deepEqual(modEntryScripts("main.js"), ["main.js"]);
		assert.deepEqual(modEntryScripts(["a.js", "b.js"]), ["a.js", "b.js"]);
		assert.deepEqual(modEntryScripts({ script: "main.js", format: "module" }), ["main.js"]);
	});

	it("modEntryFormat is module only for the object form that says so", () => {
		assert.equal(modEntryFormat("main.js"), "script");
		assert.equal(modEntryFormat({ script: "main.js" }), "script");
		assert.equal(modEntryFormat({ script: "main.js", format: "module" }), "module");
	});

	it("modEntryExports reads declared exports from the object form only", () => {
		assert.deepEqual(modEntryExports("main.js"), {});
		assert.deepEqual(modEntryExports({ script: "m.js", exports: { go: { capability: "x" } } }), { go: { capability: "x" } });
	});

	it("looksLikeMarkup separates content from file names", () => {
		assert.equal(looksLikeMarkup("<p>x</p>"), true);
		assert.equal(looksLikeMarkup("  [\"p\", {}]"), true);
		assert.equal(looksLikeMarkup("panel.html"), false);
		assert.equal(looksLikeMarkup("[not json"), false);
	});

	it("createModInstance reports fragment findings without a runtime", () => {
		const mod = createModInstance(
			{
				xript: "0.9",
				name: "mod-a",
				version: "1.0.0",
				fragments: [{ id: "card", slot: "panel", format: "text/html", source: "<p>x</p>" }],
			},
			{},
		);
		assert.deepEqual(mod.diagnostics.map((d) => d.code), ["markup-source-not-inline"]);
	});
});
