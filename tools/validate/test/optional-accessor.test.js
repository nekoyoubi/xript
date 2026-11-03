import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateManifest, lintManifests } from "../dist/index.js";

const base = { xript: "0.10", name: "shared-host" };

describe("optional bindings and accessors in the schema", () => {
	it("accepts optional on a function, a namespace, and a member", async () => {
		const result = await validateManifest({
			...base,
			bindings: {
				share: { description: "Shares.", optional: true },
				web: { description: "Browser only.", optional: true, members: { open: { description: "Opens.", optional: true } } },
			},
		});
		assert.equal(result.valid, true, JSON.stringify(result.errors));
	});

	it("accepts get and get-set accessors, as members and at the top level", async () => {
		const result = await validateManifest({
			...base,
			bindings: {
				phase: { description: "Day phase.", accessor: "get", type: "string" },
				clock: {
					description: "Clock.",
					members: {
						now: { description: "Tick.", accessor: "get", type: "number", capability: "clock" },
						speed: { description: "Speed.", accessor: "get-set", optional: true, deprecated: "Use rate." },
					},
				},
			},
			capabilities: { clock: { description: "Clock access." } },
		});
		assert.equal(result.valid, true, JSON.stringify(result.errors));
	});

	it("rejects an unknown accessor mode", async () => {
		const result = await validateManifest({
			...base,
			bindings: { clock: { description: "Clock.", members: { now: { description: "Tick.", accessor: "set" } } } },
		});
		assert.equal(result.valid, false);
	});

	it("rejects function fields on an accessor", async () => {
		const result = await validateManifest({
			...base,
			bindings: { clock: { description: "Clock.", members: { now: { description: "Tick.", accessor: "get", params: [] } } } },
		});
		assert.equal(result.valid, false);
	});

	it("rejects a non-boolean optional", async () => {
		const result = await validateManifest({ ...base, bindings: { share: { description: "Shares.", optional: "yes" } } });
		assert.equal(result.valid, false);
	});
});

describe("accessor lint", () => {
	it("flags an accessor typed with an undeclared type", () => {
		const result = lintManifests(
			{ ...base, bindings: { clock: { description: "Clock.", members: { now: { description: "Tick.", accessor: "get", type: "Tick" } } } } },
			[],
		);
		assert.ok(result.findings.some((f) => f.code === "undeclared-type" && /accessor "clock\.now"/.test(f.message)));
	});

	it("warns that a function-typed accessor value does not cross", () => {
		const result = lintManifests(
			{ ...base, bindings: { clock: { description: "Clock.", members: { now: { description: "Tick.", accessor: "get", type: "function" } } } } },
			[],
		);
		assert.ok(result.findings.some((f) => f.code === "callback-does-not-cross" && /accessor "clock\.now"/.test(f.message)));
	});
});
