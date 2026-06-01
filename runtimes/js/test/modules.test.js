import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	initXript,
	initXriptAsync,
	ModuleUnsupportedError,
	ImportDeniedError,
	CommonJSDetectedError,
	ModEntryError,
} from "../dist/index.js";

const appManifest = {
	xript: "0.5",
	name: "module-host",
	slots: [],
};

function modManifest(entry, exportsMap) {
	return {
		xript: "0.5",
		name: "test-mod",
		version: "1.0.0",
		entry: { script: entry, format: "module", ...(exportsMap ? { exports: exportsMap } : {}) },
	};
}

async function makeAsyncRuntime(options = {}) {
	const factory = await initXriptAsync();
	return factory.createRuntime(appManifest, { hostBindings: {}, ...options });
}

describe("module evaluation (js async sandbox)", () => {
	it("harvests a top-level function export as invokable", async () => {
		const runtime = await makeAsyncRuntime();
		await runtime.loadModAsync(modManifest("mod.js"), {
			fragmentSources: { "mod.js": "export function transcribe(x){ return x + 1; }" },
		});
		assert.equal(runtime.invokeExport("transcribe", [41]), 42);
		runtime.dispose();
	});

	it("runs top-level side effects exactly once", async () => {
		const logs = [];
		const runtime = await makeAsyncRuntime({ console: { onLog: (_s, ...a) => logs.push(a.join(" ")) } });
		await runtime.loadModAsync(modManifest("mod.js"), {
			fragmentSources: { "mod.js": "console.log('init'); export function f(){ return 1; }" },
		});
		assert.deepEqual(logs, ["init"]);
		runtime.dispose();
	});

	it("ignores non-function named exports", async () => {
		const runtime = await makeAsyncRuntime();
		await runtime.loadModAsync(modManifest("mod.js"), {
			fragmentSources: { "mod.js": "export const VERSION = '1.0'; export function go(){ return 'ok'; }" },
		});
		assert.equal(runtime.invokeExport("go", []), "ok");
		assert.throws(() => runtime.invokeExport("VERSION", []));
		runtime.dispose();
	});

	it("does not harvest the default export", async () => {
		const runtime = await makeAsyncRuntime();
		await runtime.loadModAsync(modManifest("mod.js"), {
			fragmentSources: { "mod.js": "export default function(){ return 'd'; } export function named(){ return 'n'; }" },
		});
		assert.equal(runtime.invokeExport("named", []), "n");
		assert.throws(() => runtime.invokeExport("default", []));
		runtime.dispose();
	});

	it("permits top-level await", async () => {
		const runtime = await makeAsyncRuntime();
		await runtime.loadModAsync(modManifest("mod.js"), {
			fragmentSources: { "mod.js": "const v = await Promise.resolve(7); export function get(){ return v; }" },
		});
		assert.equal(runtime.invokeExport("get", []), 7);
		runtime.dispose();
	});

	it("merges register() and top-level exports, register() wins on collision", async () => {
		const runtime = await makeAsyncRuntime();
		await runtime.loadModAsync(modManifest("mod.js"), {
			fragmentSources: {
				"mod.js": "export function dup(){ return 'export'; } xript.exports.register('dup', function(){ return 'register'; });",
			},
		});
		assert.equal(runtime.invokeExport("dup", []), "register");
		runtime.dispose();
	});

	it("surfaces a top-level throw as ModEntryError", async () => {
		const runtime = await makeAsyncRuntime();
		await assert.rejects(
			runtime.loadModAsync(modManifest("mod.js"), {
				fragmentSources: { "mod.js": "throw new Error('boom'); export function f(){}" },
			}),
			(e) => e instanceof ModEntryError && /boom/.test(e.message),
		);
		runtime.dispose();
	});
});

describe("external import denial (js)", () => {
	for (const spec of ["fs", "lodash", "https://evil.test/x.js", "./relative.js", "../up.js"]) {
		it(`denies import of '${spec}'`, async () => {
			const runtime = await makeAsyncRuntime();
			await assert.rejects(
				runtime.loadModAsync(modManifest("mod.js"), {
					fragmentSources: { "mod.js": `import x from '${spec}'; export function f(){}` },
				}),
				(e) => e instanceof ImportDeniedError && e.specifier === spec,
			);
			runtime.dispose();
		});
	}

	it("denies dynamic import", async () => {
		const runtime = await makeAsyncRuntime();
		await assert.rejects(
			runtime.loadModAsync(modManifest("mod.js"), {
				fragmentSources: { "mod.js": "const m = await import('fs'); export function f(){}" },
			}),
			(e) => e instanceof ImportDeniedError,
		);
		runtime.dispose();
	});
});

describe("CommonJS guardrail (js)", () => {
	for (const [name, code] of [
		["require()", "const fs = require('fs'); export function f(){}"],
		["module.exports", "module.exports = { f: function(){} };"],
		["exports.x", "exports.foo = function(){};"],
	]) {
		it(`rejects ${name} in module mode`, async () => {
			const runtime = await makeAsyncRuntime();
			await assert.rejects(
				runtime.loadModAsync(modManifest("mod.js"), { fragmentSources: { "mod.js": code } }),
				(e) => e instanceof CommonJSDetectedError,
			);
			runtime.dispose();
		});
	}

	it("rejects CommonJS in script mode too", async () => {
		const runtime = await makeAsyncRuntime();
		const scriptMod = {
			xript: "0.5",
			name: "cjs-script",
			version: "1.0.0",
			entry: { script: "mod.js", format: "script" },
		};
		await assert.rejects(
			runtime.loadModAsync(scriptMod, { fragmentSources: { "mod.js": "module.exports = {};" } }),
			(e) => e instanceof CommonJSDetectedError,
		);
		runtime.dispose();
	});
});

describe("module mode requires the async sandbox (js sync)", () => {
	it("loadMod rejects a module-format entry with ModuleUnsupportedError", async () => {
		const factory = await initXript();
		const runtime = factory.createRuntime(appManifest, { hostBindings: {} });
		assert.throws(
			() => runtime.loadMod(modManifest("mod.js"), { fragmentSources: { "mod.js": "export function f(){}" } }),
			ModuleUnsupportedError,
		);
		runtime.dispose();
	});

	it("loadModAsync on the sync sandbox also rejects module mode", async () => {
		const factory = await initXript();
		const runtime = factory.createRuntime(appManifest, { hostBindings: {} });
		await assert.rejects(
			runtime.loadModAsync(modManifest("mod.js"), { fragmentSources: { "mod.js": "export function f(){}" } }),
			ModuleUnsupportedError,
		);
		runtime.dispose();
	});
});

describe("export capability gating (module origin, js)", () => {
	it("gates a harvested export by entry.exports[name].capability", async () => {
		const guardedApp = {
			xript: "0.5",
			name: "guarded-host",
			capabilities: { secret: { description: "secret cap" } },
			slots: [],
		};
		const factory = await initXriptAsync();
		const runtime = await factory.createRuntime(guardedApp, { hostBindings: {}, capabilities: [] });
		const mod = {
			xript: "0.5",
			name: "guarded-mod",
			version: "1.0.0",
			entry: { script: "mod.js", format: "module", exports: { reveal: { capability: "secret" } } },
		};
		await runtime.loadModAsync(mod, { fragmentSources: { "mod.js": "export function reveal(){ return 'x'; }" } });
		assert.throws(() => runtime.invokeExport("reveal", []), /capability/);
		runtime.dispose();
	});
});
