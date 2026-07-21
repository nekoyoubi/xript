import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { initXript } from "../dist/index.js";

let xript;

before(async () => {
	xript = await initXript();
});

function makeManifest(capability) {
	return {
		xript: "0.7",
		name: "subsumption-app",
		bindings: {
			danger: { description: "gated binding", capability },
		},
		capabilities: {
			"run": { description: "run scope" },
			"run.command": { description: "run command scope" },
		},
	};
}

function callsCleanly(runtime) {
	const value = runtime.execute(`
		try { danger(); "ok"; } catch (e) { e.name; }
	`).value;
	return value;
}

describe("capability subsumption at the binding gate", () => {
	it("a parent-scope grant subsumes a child-scope requirement", () => {
		const runtime = xript.createRuntime(makeManifest("run.command"), {
			hostBindings: { danger: () => "called" },
			capabilities: ["run"],
		});
		assert.equal(callsCleanly(runtime), "ok");
		runtime.dispose();
	});

	it("a child-scope grant does NOT subsume a parent-scope requirement", () => {
		const runtime = xript.createRuntime(makeManifest("run"), {
			hostBindings: { danger: () => "called" },
			capabilities: ["run.command"],
		});
		assert.equal(callsCleanly(runtime), "CapabilityDeniedError");
		runtime.dispose();
	});

	it("a write grant satisfies a read requirement on the same scope", () => {
		const runtime = xript.createRuntime(makeManifest("read:run.command"), {
			hostBindings: { danger: () => "called" },
			capabilities: ["write:run.command"],
		});
		assert.equal(callsCleanly(runtime), "ok");
		runtime.dispose();
	});

	it("a read grant does NOT satisfy a write requirement", () => {
		const runtime = xript.createRuntime(makeManifest("write:run.command"), {
			hostBindings: { danger: () => "called" },
			capabilities: ["read:run.command"],
		});
		assert.equal(callsCleanly(runtime), "CapabilityDeniedError");
		runtime.dispose();
	});

	it("segment-boundary discipline: 'run' grant does not cover a 'runner' requirement", () => {
		const runtime = xript.createRuntime(makeManifest("runner"), {
			hostBindings: { danger: () => "called" },
			capabilities: ["run"],
		});
		assert.equal(callsCleanly(runtime), "CapabilityDeniedError");
		runtime.dispose();
	});
});

// The fragment/slot gate is where a mod's *contribution* is admitted, and it is the gate the
// capability hierarchy has to reach for a dotted scope to mean anything on a fill. Only the
// binding gate had subsumption coverage; this pins the fill side of both axes.
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
		const runtime = xript.createRuntime(host, { hostBindings: {}, capabilities: granted });
		try {
			runtime.loadMod(mod, { fragmentSources: { "panel.html": "<p>hi</p>" } });
			return true;
		} catch {
			return false;
		} finally {
			runtime.dispose();
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
