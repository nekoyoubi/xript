import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRuntime } from "../dist/index.js";

const slotHookManifest = {
	xript: "0.7",
	name: "slot-hook-app",
	capabilities: {
		persistence: { description: "save access" },
	},
	slots: [
		{
			id: "playerDamage",
			accepts: ["application/x-xript-hook"],
			description: "fired when the player takes damage",
		},
		{
			id: "save",
			accepts: ["application/x-xript-hook"],
			description: "fired during the save lifecycle",
			capability: "persistence.disk",
		},
	],
};

describe("event-typed-slot hooks — dispatch (#112)", () => {
	it("injects a hooks registration verb for an event-typed slot", () => {
		const runtime = createRuntime(slotHookManifest, { hostBindings: {} });
		runtime.execute(`
			globalThis.__seen = "";
			hooks.playerDamage(function(amount, source) {
				globalThis.__seen = amount + ":" + source;
			});
		`);
		const results = runtime.fireHook("playerDamage", { data: { amount: 25, source: "trap" } });
		assert.deepEqual(results, [undefined]);
		assert.equal(runtime.execute("globalThis.__seen").value, "25:trap");
		runtime.dispose();
	});

	it("fires multiple slot-hook handlers in registration order", () => {
		const runtime = createRuntime(slotHookManifest, { hostBindings: {} });
		runtime.execute(`
			hooks.playerDamage(function() { return 1; });
			hooks.playerDamage(function() { return 2; });
		`);
		const results = runtime.fireHook("playerDamage");
		assert.deepEqual(results, [1, 2]);
		runtime.dispose();
	});

	it("gates slot-hook registration on the slot's declared capability", () => {
		const runtime = createRuntime(slotHookManifest, { hostBindings: {} });
		assert.throws(
			() => runtime.execute(`hooks.save(function() {});`),
			/capability/i,
		);
		runtime.dispose();
	});

	it("admits a gated slot-hook when a subsuming grant is held", () => {
		const runtime = createRuntime(slotHookManifest, {
			hostBindings: {},
			capabilities: ["persistence"],
		});
		runtime.execute(`
			globalThis.__hit = 0;
			hooks.save(function() { globalThis.__hit += 1; });
		`);
		runtime.fireHook("save");
		assert.equal(runtime.execute("globalThis.__hit").value, 1);
		runtime.dispose();
	});

	it("an explicit hooks-block entry wins over a same-named slot", () => {
		const runtime = createRuntime(
			{
				...slotHookManifest,
				hooks: {
					playerDamage: { description: "explicit", phases: ["pre", "post"] },
				},
			},
			{ hostBindings: {} },
		);
		runtime.execute(`
			globalThis.__phase = "";
			hooks.playerDamage.pre(function() { globalThis.__phase = "pre"; });
		`);
		runtime.fireHook("playerDamage", { phase: "pre" });
		assert.equal(runtime.execute("globalThis.__phase").value, "pre");
		runtime.dispose();
	});
});
