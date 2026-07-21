import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRuntime } from "../dist/index.js";

/**
 * Two command slots that disagree with the manifest budget in opposite
 * directions: one carries its own, one says nothing and inherits.
 */
function host(manifestTimeoutMs, slotTimeoutMs) {
	return {
		xript: "0.8",
		name: "limits-host",
		limits: { timeout_ms: manifestTimeoutMs },
		slots: [
			{
				id: "bounded.commands",
				accepts: ["application/x-xript-command"],
				description: "fills here run under the slot's own budget",
				multiple: true,
				limits: { timeout_ms: slotTimeoutMs },
			},
			{
				id: "inherited.commands",
				accepts: ["application/x-xript-command"],
				description: "fills here inherit the manifest budget",
				multiple: true,
			},
		],
	};
}

const SPINNER = {
	xript: "0.8",
	name: "spinner",
	version: "1.0.0",
	entry: {
		format: "script",
		script: "main.js",
		exports: {
			spin: { description: "burns wall clock" },
			quick: { description: "returns at once" },
		},
	},
	fills: {
		"bounded.commands": [
			{ id: "bounded.spin", title: "Spin", handler: "spin" },
			{ id: "bounded.quick", title: "Quick", handler: "quick" },
		],
		"inherited.commands": [{ id: "inherited.spin", title: "Spin", handler: "spin" }],
	},
};

// `spin` outlasts every budget under test, so whether it returns is decided
// entirely by the deadline in force.
const SPINNER_SOURCE = `
xript.exports.register("spin", function () {
	var end = Date.now() + 3000;
	while (Date.now() < end) {}
	return "finished";
});
xript.exports.register("quick", function () { return "quick"; });
`;

function makeRuntime(manifestTimeoutMs, slotTimeoutMs, hardTimeoutMs) {
	const options = { hostBindings: {}, capabilities: [] };
	if (hardTimeoutMs !== undefined) options.hardLimits = { timeout_ms: hardTimeoutMs };
	const runtime = createRuntime(host(manifestTimeoutMs, slotTimeoutMs), options);
	runtime.loadMod(SPINNER, { fragmentSources: { "main.js": SPINNER_SOURCE } });
	return runtime;
}

function invoke(runtime, reference) {
	const command = runtime.resolveCommand(reference);
	assert.ok(command, `command ${reference} resolves`);
	return runtime.invokeCommand(command, null);
}

describe("per-slot execution limits", () => {
	it("lets a slot tighten below the manifest budget", () => {
		const runtime = makeRuntime(10_000, 50);
		assert.throws(
			() => invoke(runtime, "bounded.spin"),
			(error) => error.limit === "timeout_ms",
			"the slot's 50ms budget should have stopped a 3s spin",
		);
		runtime.dispose();
	});

	it("lets a slot widen past the manifest budget", () => {
		const runtime = makeRuntime(50, 10_000);
		assert.equal(
			invoke(runtime, "bounded.spin"),
			"finished",
			"the slot's 10s budget should have let a 3s spin finish",
		);
		runtime.dispose();
	});

	it("leaves a slot without limits on the manifest budget", () => {
		const runtime = makeRuntime(50, 10_000);
		assert.throws(
			() => invoke(runtime, "inherited.spin"),
			(error) => error.limit === "timeout_ms",
			"a slot declaring no limits must not pick up a neighbouring slot's",
		);
		runtime.dispose();
	});

	it("clamps a widening slot to the embedder's hard ceiling", () => {
		const runtime = makeRuntime(50, 10_000, 100);
		assert.throws(
			() => invoke(runtime, "bounded.spin"),
			(error) => error.limit === "timeout_ms",
			"a manifest must not buy itself more budget than the embedder allowed",
		);
		runtime.dispose();
	});

	it("does not disturb a call that fits inside a tightened slot", () => {
		const runtime = makeRuntime(10_000, 50);
		assert.equal(invoke(runtime, "bounded.quick"), "quick");
		runtime.dispose();
	});
});
