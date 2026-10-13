import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRuntime, AmbiguousExportError, CapabilityDeniedError } from "../dist/index.js";

const hostManifest = {
	xript: "0.7",
	name: "export-scoping-host",
	capabilities: {
		"fs.write": { description: "write files" },
	},
	slots: [
		{ id: "on-tick", accepts: ["application/x-xript-hook"], description: "tick event" },
		{ id: "transcriber", accepts: ["application/x-xript-role"], description: "transcription provider" },
	],
};

function makeRuntime(capabilities = []) {
	return createRuntime(hostManifest, { hostBindings: {}, capabilities });
}

function captureThrow(fn) {
	try {
		const value = fn();
		assert.fail(`expected a throw, got ${JSON.stringify(value)}`);
	} catch (error) {
		if (error instanceof assert.AssertionError) throw error;
		return error;
	}
}

const GATED_MOD = {
	xript: "0.7",
	name: "mod-a",
	version: "1.0.0",
	entry: {
		format: "script",
		script: "a.js",
		exports: { doThing: { description: "does a gated thing", capability: "fs.write" } },
	},
};

const GATED_SOURCE = `xript.exports.register("doThing", function() { return "A-SECRET-RAN"; });`;

describe("export scoping — a later mod cannot weaken an earlier mod's gate", () => {
	it("denies the gated export when the capability is not granted", () => {
		const runtime = makeRuntime();
		runtime.loadMod(GATED_MOD, { fragmentSources: { "a.js": GATED_SOURCE } });
		assert.throws(() => runtime.invokeExport("doThing", []), CapabilityDeniedError);
		runtime.dispose();
	});

	it("a capability-less redeclaration of the same name does not strip the gate", () => {
		const runtime = makeRuntime();
		runtime.loadMod(GATED_MOD, { fragmentSources: { "a.js": GATED_SOURCE } });

		runtime.loadMod({
			xript: "0.7",
			name: "mod-b",
			version: "1.0.0",
			entry: { format: "script", script: "b.js", exports: { doThing: { description: "no capability at all" } } },
		}, { fragmentSources: { "b.js": "" } });

		const error = captureThrow(() => runtime.invokeExport("doThing", []));
		assert.ok(
			error instanceof AmbiguousExportError || error instanceof CapabilityDeniedError,
			`expected the gate to hold, got ${error.name}: ${error.message}`,
		);
		assert.notEqual(error.message, "A-SECRET-RAN");
		runtime.dispose();
	});

	it("a later mod redefining the name cannot hijack the earlier mod's export", () => {
		const runtime = makeRuntime(["fs.write"]);
		runtime.loadMod(GATED_MOD, { fragmentSources: { "a.js": GATED_SOURCE } });
		runtime.loadMod(
			{
				xript: "0.7",
				name: "mod-c",
				version: "1.0.0",
				entry: { format: "script", script: "c.js", exports: { doThing: { description: "hijack" } } },
			},
			{ fragmentSources: { "c.js": `xript.exports.register("doThing", function() { return "C-HIJACKED"; });` } },
		);

		assert.equal(runtime.invokeModExport("mod-a", "doThing", []), "A-SECRET-RAN");
		assert.equal(runtime.invokeModExport("mod-c", "doThing", []), "C-HIJACKED");
		runtime.dispose();
	});

	it("a bare invoke of a name two mods own reports both mods", () => {
		const runtime = makeRuntime(["fs.write"]);
		runtime.loadMod(GATED_MOD, { fragmentSources: { "a.js": GATED_SOURCE } });
		runtime.loadMod(
			{
				xript: "0.7",
				name: "mod-c",
				version: "1.0.0",
				entry: { format: "script", script: "c.js", exports: { doThing: { description: "hijack" } } },
			},
			{ fragmentSources: { "c.js": `xript.exports.register("doThing", function() { return "C-HIJACKED"; });` } },
		);

		const error = captureThrow(() => runtime.invokeExport("doThing", []));
		assert.ok(error instanceof AmbiguousExportError, `expected AmbiguousExportError, got ${error.name}`);
		assert.deepEqual(error.mods, ["mod-a", "mod-c"]);
		assert.match(error.message, /mod-a/);
		assert.match(error.message, /mod-c/);
		runtime.dispose();
	});
});

describe("export scoping — hook fills resolve inside the declaring mod", () => {
	it("a capability-less mod cannot fire another mod's gated export through a hook fill", () => {
		const runtime = makeRuntime();
		runtime.loadMod(GATED_MOD, { fragmentSources: { "a.js": GATED_SOURCE } });

		runtime.loadMod({
			xript: "0.7",
			name: "mod-parasite",
			version: "1.0.0",
			fills: { "on-tick": [{ handler: "doThing" }] },
		});

		const results = runtime.fireHook("on-tick", { data: {} });
		assert.ok(!results.includes("A-SECRET-RAN"), `hook fill reached another mod's export: ${JSON.stringify(results)}`);
		runtime.dispose();
	});

	it("a mod's own hook fill still fires, gated by its own capability", () => {
		const granted = makeRuntime(["fs.write"]);
		granted.loadMod(
			{
				...GATED_MOD,
				fills: { "on-tick": [{ handler: "doThing" }] },
			},
			{ fragmentSources: { "a.js": GATED_SOURCE } },
		);
		assert.deepEqual(granted.fireHook("on-tick", { data: {} }), ["A-SECRET-RAN"]);
		granted.dispose();

		const denied = makeRuntime();
		denied.loadMod(
			{
				...GATED_MOD,
				fills: { "on-tick": [{ handler: "doThing" }] },
			},
			{ fragmentSources: { "a.js": GATED_SOURCE } },
		);
		assert.deepEqual(denied.fireHook("on-tick", { data: {} }), [undefined]);
		denied.dispose();
	});
});

describe("export scoping — two role providers coexist on one name", () => {
	it("resolves each provider's own transcribe", () => {
		const runtime = makeRuntime();
		runtime.loadMod(
			{
				xript: "0.7",
				name: "fast-transcriber",
				version: "1.0.0",
				entry: { format: "script", script: "fast.js", exports: { transcribe: { description: "fast" } } },
				fills: { transcriber: [{ fns: { transcribe: "transcribe" } }] },
			},
			{ fragmentSources: { "fast.js": `xript.exports.register("transcribe", function() { return "fast"; });` } },
		);
		runtime.loadMod(
			{
				xript: "0.7",
				name: "good-transcriber",
				version: "1.0.0",
				entry: { format: "script", script: "good.js", exports: { transcribe: { description: "good" } } },
				fills: { transcriber: [{ fns: { transcribe: "transcribe" } }] },
			},
			{ fragmentSources: { "good.js": `xript.exports.register("transcribe", function() { return "good"; });` } },
		);

		const providers = runtime.resolveRoleAll("transcriber");
		assert.equal(providers.length, 2);
		const results = providers.map((p) => runtime.invokeModExport(p.addon, p.fns.transcribe, []));
		assert.deepEqual(results, ["fast", "good"]);
		runtime.dispose();
	});
});

describe("export scoping — host-level and single-mod invocation are unchanged", () => {
	it("a host execute() registration stays invokable by bare name", () => {
		const runtime = makeRuntime();
		runtime.execute(`xript.exports.register("hostSide", function(n) { return n * 2; });`);
		assert.equal(runtime.invokeExport("hostSide", [21]), 42);
		runtime.dispose();
	});

	it("a lone mod's export stays invokable by bare name", () => {
		const runtime = makeRuntime(["fs.write"]);
		runtime.loadMod(GATED_MOD, { fragmentSources: { "a.js": GATED_SOURCE } });
		assert.equal(runtime.invokeExport("doThing", []), "A-SECRET-RAN");
		runtime.dispose();
	});
});
