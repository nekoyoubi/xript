import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRuntime } from "../dist/index.js";

const asyncManifest = {
	xript: "0.1",
	name: "async-binding-app",
	bindings: {
		fetchThing: { async: true, params: [], returns: "object" },
	},
};

describe("async bindings on the node sandbox", () => {
	it("hands the script a real promise rather than flattening it to {}", async () => {
		const runtime = createRuntime(asyncManifest, {
			hostBindings: { fetchThing: async () => ({ ok: true }) },
		});

		const result = runtime.execute("fetchThing()");
		assert.equal(typeof result.value.then, "function");
		assert.deepEqual(await result.value, { ok: true });
		runtime.dispose();
	});

	it("awaits the value under executeAsync", async () => {
		const runtime = createRuntime(asyncManifest, {
			hostBindings: { fetchThing: async () => ({ ok: true }) },
		});

		const result = await runtime.executeAsync("return await fetchThing();");
		assert.deepEqual(result.value, { ok: true });
		runtime.dispose();
	});

	it("hands back a real promise even when async: true is omitted", async () => {
		const runtime = createRuntime(
			{ xript: "0.1", name: "undeclared", bindings: { fetchThing: { params: [], returns: "object" } } },
			{ hostBindings: { fetchThing: () => Promise.resolve({ ok: true }) } },
		);

		const result = runtime.execute("fetchThing()");
		assert.equal(typeof result.value.then, "function");
		assert.deepEqual(await result.value, { ok: true });
		runtime.dispose();
	});
});
