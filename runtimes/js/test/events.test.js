import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { initXript } from "../dist/index.js";

let xript;

before(async () => {
	xript = await initXript();
});

const eventManifest = {
	xript: "0.7",
	name: "events-app",
	capabilities: {
		"world": { description: "world access" },
	},
	events: [
		{ id: "document.saved", description: "fired after a save", payload: { name: { type: "string" } } },
		{ id: "tick", description: "fired each frame" },
		{ id: "world.changed", description: "world mutation", capability: "world.terrain" },
	],
};

describe("events seam — subscription and delivery", () => {
	it("delivers an emitted event to a subscribed handler", () => {
		const runtime = xript.createRuntime(eventManifest, { hostBindings: {} });
		runtime.execute(`
			globalThis.__seen = [];
			events.on("document.saved", function(name) { globalThis.__seen.push(name); });
		`);
		const results = runtime.emit("document.saved", { name: "draft.md" });
		assert.deepEqual(results, [undefined]);
		const seen = runtime.execute("globalThis.__seen").value;
		assert.deepEqual(seen, ["draft.md"]);
		runtime.dispose();
	});

	it("collects handler return values in registration order", () => {
		const runtime = xript.createRuntime(eventManifest, { hostBindings: {} });
		runtime.execute(`
			events.on("tick", function() { return 1; });
			events.subscribe("tick", function() { return 2; });
		`);
		const results = runtime.emit("tick");
		assert.deepEqual(results, [1, 2]);
		runtime.dispose();
	});

	it("swallows per-handler errors to undefined", () => {
		const runtime = xript.createRuntime(eventManifest, { hostBindings: {} });
		runtime.execute(`
			events.on("tick", function() { throw new Error("boom"); });
			events.on("tick", function() { return "ok"; });
		`);
		const results = runtime.emit("tick");
		assert.deepEqual(results, [undefined, "ok"]);
		runtime.dispose();
	});

	it("emitting an undeclared event delivers to no one", () => {
		const runtime = xript.createRuntime(eventManifest, { hostBindings: {} });
		const results = runtime.emit("not.declared", {});
		assert.deepEqual(results, []);
		runtime.dispose();
	});

	it("subscribing to an undeclared event throws", () => {
		const runtime = xript.createRuntime(eventManifest, { hostBindings: {} });
		assert.throws(() => runtime.execute(`events.on("not.declared", function() {});`));
		runtime.dispose();
	});

	it("gates subscription on the event's declared capability", () => {
		const runtime = xript.createRuntime(eventManifest, { hostBindings: {} });
		assert.throws(
			() => runtime.execute(`events.on("world.changed", function() {});`),
			/capability/i,
		);
		runtime.dispose();
	});

	it("admits a gated subscription when a subsuming grant is held", () => {
		const runtime = xript.createRuntime(eventManifest, {
			hostBindings: {},
			capabilities: ["world"],
		});
		runtime.execute(`
			globalThis.__hit = 0;
			events.on("world.changed", function() { globalThis.__hit += 1; });
		`);
		runtime.emit("world.changed", {});
		assert.equal(runtime.execute("globalThis.__hit").value, 1);
		runtime.dispose();
	});
});
