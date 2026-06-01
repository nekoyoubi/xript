import { describe, it } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {
	createRuntime,
	ImportDeniedError,
	CommonJSDetectedError,
	ModEntryError,
} from "../dist/index.js";

const hasVmModules = typeof vm.SourceTextModule === "function";
const skipModuleEval = hasVmModules ? false : "requires --experimental-vm-modules";

const appManifest = { xript: "0.5", name: "module-host", slots: [] };

function modManifest(entry, exportsMap) {
	return {
		xript: "0.5",
		name: "test-mod",
		version: "1.0.0",
		entry: { script: entry, format: "module", ...(exportsMap ? { exports: exportsMap } : {}) },
	};
}

function makeRuntime(options = {}) {
	return createRuntime(appManifest, { hostBindings: {}, ...options });
}

describe("module evaluation (node SourceTextModule)", { skip: skipModuleEval }, () => {
	it("harvests a top-level function export as invokable", async () => {
		const runtime = makeRuntime();
		await runtime.loadModAsync(modManifest("mod.js"), {
			fragmentSources: { "mod.js": "export function transcribe(x){ return x + 1; }" },
		});
		assert.equal(runtime.invokeExport("transcribe", [41]), 42);
	});

	it("runs top-level side effects exactly once", async () => {
		const logs = [];
		const runtime = makeRuntime({ console: { onLog: (_s, ...a) => logs.push(a.join(" ")) } });
		await runtime.loadModAsync(modManifest("mod.js"), {
			fragmentSources: { "mod.js": "console.log('init'); export function f(){ return 1; }" },
		});
		assert.deepEqual(logs, ["init"]);
	});

	it("ignores non-function named exports", async () => {
		const runtime = makeRuntime();
		await runtime.loadModAsync(modManifest("mod.js"), {
			fragmentSources: { "mod.js": "export const VERSION = '1.0'; export function go(){ return 'ok'; }" },
		});
		assert.equal(runtime.invokeExport("go", []), "ok");
		assert.throws(() => runtime.invokeExport("VERSION", []));
	});

	it("does not harvest the default export", async () => {
		const runtime = makeRuntime();
		await runtime.loadModAsync(modManifest("mod.js"), {
			fragmentSources: { "mod.js": "export default function(){ return 'd'; } export function named(){ return 'n'; }" },
		});
		assert.equal(runtime.invokeExport("named", []), "n");
		assert.throws(() => runtime.invokeExport("default", []));
	});

	it("permits top-level await", async () => {
		const runtime = makeRuntime();
		await runtime.loadModAsync(modManifest("mod.js"), {
			fragmentSources: { "mod.js": "const v = await Promise.resolve(7); export function get(){ return v; }" },
		});
		assert.equal(runtime.invokeExport("get", []), 7);
	});

	it("merges register() and top-level exports, register() wins on collision", async () => {
		const runtime = makeRuntime();
		await runtime.loadModAsync(modManifest("mod.js"), {
			fragmentSources: {
				"mod.js": "export function dup(){ return 'export'; } xript.exports.register('dup', function(){ return 'register'; });",
			},
		});
		assert.equal(runtime.invokeExport("dup", []), "register");
	});

	it("surfaces a top-level throw as ModEntryError", async () => {
		const runtime = makeRuntime();
		await assert.rejects(
			runtime.loadModAsync(modManifest("mod.js"), {
				fragmentSources: { "mod.js": "throw new Error('boom'); export function f(){}" },
			}),
			(e) => e instanceof ModEntryError && /boom/.test(e.message),
		);
	});

	it("gates a harvested export by capability", async () => {
		const guardedApp = {
			xript: "0.5",
			name: "guarded-host",
			capabilities: { secret: { description: "secret cap" } },
			slots: [],
		};
		const runtime = createRuntime(guardedApp, { hostBindings: {}, capabilities: [] });
		const mod = {
			xript: "0.5",
			name: "guarded-mod",
			version: "1.0.0",
			entry: { script: "mod.js", format: "module", exports: { reveal: { capability: "secret" } } },
		};
		await runtime.loadModAsync(mod, { fragmentSources: { "mod.js": "export function reveal(){ return 'x'; }" } });
		assert.throws(() => runtime.invokeExport("reveal", []), /capability/);
	});
});

describe("external import denial (node)", { skip: skipModuleEval }, () => {
	for (const spec of ["fs", "lodash", "https://evil.test/x.js", "./relative.js", "../up.js"]) {
		it(`denies import of '${spec}'`, async () => {
			const runtime = makeRuntime();
			await assert.rejects(
				runtime.loadModAsync(modManifest("mod.js"), {
					fragmentSources: { "mod.js": `import x from '${spec}'; export function f(){}` },
				}),
				(e) => e instanceof ImportDeniedError && e.specifier === spec,
			);
		});
	}

	it("denies dynamic import", async () => {
		const runtime = makeRuntime();
		await assert.rejects(
			runtime.loadModAsync(modManifest("mod.js"), {
				fragmentSources: { "mod.js": "const m = await import('fs'); export function f(){}" },
			}),
			(e) => e instanceof ImportDeniedError,
		);
	});
});

describe("CommonJS guardrail (node)", () => {
	for (const [name, code] of [
		["require()", "const fs = require('fs'); export function f(){}"],
		["module.exports", "module.exports = { f: function(){} };"],
		["exports.x", "exports.foo = function(){};"],
	]) {
		it(`rejects ${name} in module mode`, { skip: skipModuleEval }, async () => {
			const runtime = makeRuntime();
			await assert.rejects(
				runtime.loadModAsync(modManifest("mod.js"), { fragmentSources: { "mod.js": code } }),
				(e) => e instanceof CommonJSDetectedError,
			);
		});
	}

	it("rejects CommonJS in script mode (sync loadMod)", () => {
		const runtime = makeRuntime();
		const scriptMod = {
			xript: "0.5",
			name: "cjs-script",
			version: "1.0.0",
			entry: { script: "mod.js", format: "script" },
		};
		assert.throws(
			() => runtime.loadMod(scriptMod, { fragmentSources: { "mod.js": "module.exports = {};" } }),
			CommonJSDetectedError,
		);
	});
});
