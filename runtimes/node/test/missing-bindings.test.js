import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRuntime } from "../dist/index.js";

describe("binding registration drift", () => {
	const host = {
		xript: "0.8",
		name: "drift-host",
		bindings: {
			solo: { description: "Standalone.", params: [] },
			fs: { description: "Filesystem.", members: { read: { description: "R." }, write: { description: "W." } } },
		},
	};
	const partial = { fs: { read: () => "data" } };
	const complete = { solo: () => "ok", fs: { read: () => "data", write: () => "done" } };

	// A declared-but-unsupplied binding installs as a stub that throws only when a mod calls it,
	// so without this the manifest and the host's wiring drift with nothing to catch them.
	it("reports every declared binding the host did not supply", () => {
		const rt = createRuntime(host, { hostBindings: partial, capabilities: [] });
		assert.deepEqual([...rt.missingBindings], ["fs.write", "solo"]);
		rt.dispose();
	});

	it("refuses to construct under strictBindings", () => {
		assert.throws(
			() => createRuntime(host, { hostBindings: partial, capabilities: [], strictBindings: true }),
			(error) => error.name === "MissingBindingsError" && error.missing.length === 2,
		);
	});

	it("is clean when the host supplies everything", () => {
		const rt = createRuntime(host, { hostBindings: complete, capabilities: [], strictBindings: true });
		assert.equal(rt.missingBindings.length, 0);
		rt.dispose();
	});
});
