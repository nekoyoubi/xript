import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRuntime } from "../dist/index.js";

const hostManifest = {
	xript: "0.7",
	name: "audit-host",
	capabilities: {
		persistence: { description: "storage access" },
	},
	slots: [
		{ id: "on-save", accepts: ["application/x-xript-hook"], description: "save event" },
	],
};

function runtimeWithAudit(capabilities = []) {
	const events = [];
	const runtime = createRuntime(hostManifest, {
		hostBindings: {},
		capabilities,
		audit: (event) => events.push(event),
	});
	return { runtime, events };
}

function loadGatedMod(runtime, name = "gated-mod") {
	return runtime.loadMod(
		{
			xript: "0.7",
			name,
			version: "1.0.0",
			entry: {
				script: "mod.js",
				exports: { onSave: { description: "save handler", capability: "persistence.disk" } },
			},
			fills: { "on-save": [{ handler: "onSave" }] },
		},
		{ fragmentSources: { "mod.js": `xript.exports.register("onSave", function() { return "saved"; });` } },
	);
}

describe("audit channel — capability-denied hook fills", () => {
	it("reports a denied hook fill, naming the mod and the handler", () => {
		const { runtime, events } = runtimeWithAudit();
		loadGatedMod(runtime);

		const results = runtime.fireHook("on-save");
		assert.deepEqual(results, [undefined]);

		const denials = events.filter((event) => event.decision === "denied");
		assert.equal(denials.length, 1);
		assert.equal(denials[0].mod, "gated-mod");
		assert.equal(denials[0].binding, "onSave");
		assert.equal(denials[0].hook, "on-save");
		assert.equal(denials[0].capability, "persistence.disk");
		assert.equal(typeof denials[0].at, "number");
		runtime.dispose();
	});

	it("reports a denial once per (mod, handler, hook) no matter how often the hook fires", () => {
		const { runtime, events } = runtimeWithAudit();
		loadGatedMod(runtime);

		for (let i = 0; i < 25; i += 1) runtime.fireHook("on-save");

		assert.equal(events.filter((event) => event.decision === "denied").length, 1);
		runtime.dispose();
	});

	it("reports each denied mod separately", () => {
		const { runtime, events } = runtimeWithAudit();
		loadGatedMod(runtime, "mod-a");
		loadGatedMod(runtime, "mod-b");

		runtime.fireHook("on-save");
		runtime.fireHook("on-save");

		const denials = events.filter((event) => event.decision === "denied");
		assert.deepEqual(denials.map((event) => event.mod).sort(), ["mod-a", "mod-b"]);
		runtime.dispose();
	});

	it("stays silent when a handler throws for its own reasons", () => {
		const { runtime, events } = runtimeWithAudit();
		runtime.loadMod(
			{
				xript: "0.7",
				name: "throwing-mod",
				version: "1.0.0",
				entry: { script: "mod.js", exports: { onSave: { description: "save handler" } } },
				fills: { "on-save": [{ handler: "onSave" }] },
			},
			{
				fragmentSources: {
					"mod.js": `xript.exports.register("onSave", function() { throw new Error("mod bug"); });`,
				},
			},
		);

		const results = runtime.fireHook("on-save");
		assert.deepEqual(results, [undefined]);
		assert.equal(events.filter((event) => event.decision === "denied").length, 0);
		runtime.dispose();
	});

	it("stays silent when the granting capability subsumes the export's", () => {
		const { runtime, events } = runtimeWithAudit(["persistence"]);
		loadGatedMod(runtime);

		assert.deepEqual(runtime.fireHook("on-save"), ["saved"]);
		assert.equal(events.filter((event) => event.decision === "denied").length, 0);
		runtime.dispose();
	});
});
