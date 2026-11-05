import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRuntime } from "../dist/index.js";

const manifest = {
	xript: "0.10",
	name: "identity-probe",
	bindings: {
		give: { description: "Returns the function it received." },
		nest: { description: "Returns the function it received inside a value." },
		pass: { description: "Calls fn with g, top-level and nested." },
		stash: { description: "Keeps the function it received." },
		stale: { description: "Returns the function stash kept." },
		later: { description: "Resolves to the function it received.", async: true },
		outer: { description: "Calls the function it received, keeping it while it runs." },
		running: { description: "Returns the function outer is running." },
		elsewhere: { description: "Runs a script in another runtime that asks for this call's function." },
		foreign: { description: "Returns the function another runtime's call is holding." },
	},
};

function hostFor(state) {
	let kept;
	let current;
	return {
		give: (fn) => fn,
		nest: (fn) => ({ list: [fn], inner: { fn } }),
		pass: (fn, g) => fn(g, { deep: [g] }),
		stash: (fn) => {
			kept = fn;
		},
		stale: () => kept,
		later: async (fn) => fn,
		outer: (fn) => {
			current = fn;
			return fn();
		},
		running: () => current,
		elsewhere: (fn) => {
			state.held = fn;
			return state.other.execute("typeof foreign()").value;
		},
		foreign: () => state.held,
	};
}

const SCRIPT = `(function () {
	var f = function () { return 1; };
	var g = function () { return 2; };
	var r = nest(f);
	stash(f);
	var o = function () { return running() === o; };
	return [
		give(f) === f,
		r.list[0] === f,
		r.inner.fn === f,
		pass(function (x, o) { return x === g && o.deep[0] === g; }, g),
		typeof stale(),
		outer(o),
		elsewhere(f),
	].join('|');
})()`;

describe("a callback handed back during its call", () => {
	it("arrives as the script's own function while its call runs, and as undefined after it or in another runtime", async () => {
		const state = {};
		const runtime = createRuntime(manifest, { hostBindings: hostFor(state) });
		state.other = createRuntime(manifest, { hostBindings: hostFor(state) });
		try {
			assert.equal(runtime.execute(SCRIPT).value, "true|true|true|true|undefined|true|undefined");
			const result = await runtime.executeAsync("var f = function () {}; return (await later(f)) === f;");
			assert.equal(result.value, true);
		} finally {
			runtime.dispose();
			state.other.dispose();
		}
	});
});
