import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRuntime } from "../dist/index.js";

// The fragment/slot gate is where a mod's *contribution* is admitted, and it is the gate the
// capability hierarchy has to reach for a dotted scope to mean anything on a fill.
describe("capability subsumption at the fragment slot gate", () => {
	const host = {
		xript: "0.8",
		name: "slot-gate-app",
		capabilities: { ui: { description: "UI surface." }, "ui.sidebar": { description: "The sidebar." } },
		slots: [{ id: "sidebar", accepts: ["text/html"], description: "Sidebar.", capability: "write:ui.sidebar" }],
	};
	const mod = {
		xript: "0.8",
		name: "panel-mod",
		version: "1.0.0",
		capabilities: ["write:ui.sidebar"],
		fills: { sidebar: [{ id: "panel", format: "text/html", source: "panel.html" }] },
	};

	function admits(granted) {
		const runtime = createRuntime(host, { hostBindings: {}, capabilities: granted });
		try {
			runtime.loadMod(mod, { fragmentSources: { "panel.html": "<p>hi</p>" } });
			return true;
		} catch {
			return false;
		}
	}

	it("admits a fill when a parent-scope grant subsumes the slot's gate", () => {
		assert.equal(admits(["write:ui"]), true);
	});

	it("admits a fill on an exact-scope grant", () => {
		assert.equal(admits(["write:ui.sidebar"]), true);
	});

	it("refuses a read grant against a write gate", () => {
		assert.equal(admits(["read:ui"]), false);
	});

	it("refuses an unrelated scope that merely shares a prefix of characters", () => {
		assert.equal(admits(["write:uiother"]), false);
	});
});
