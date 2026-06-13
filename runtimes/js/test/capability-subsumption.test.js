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
