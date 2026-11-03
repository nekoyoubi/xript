import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRuntime } from "../dist/index.js";

const corpus = JSON.parse(
	readFileSync(fileURLToPath(new URL("../../../spec/accessor-tests.json", import.meta.url)), "utf8"),
);

function asJson(value) {
	return JSON.parse(JSON.stringify(value));
}

function createProbe() {
	const state = { reads: 0, writes: [], speed: 1 };
	const clock = {
		now: { get: () => ++state.reads },
		speed: {
			get: () => state.speed,
			set: (value) => {
				state.writes.push(asJson(value));
				state.speed = value;
			},
		},
		broken: {
			get: () => {
				throw new Error("clock offline");
			},
		},
		jammed: {
			get: () => 0,
			set: () => {
				throw new Error("rejected value");
			},
		},
		locked: { get: () => "secret" },
	};
	return { state, hostBindings: { clock, phase: { get: () => "day" } } };
}

function runCase(entry) {
	const { state, hostBindings } = createProbe();
	const runtime = createRuntime(corpus.manifest, { hostBindings, capabilities: corpus.capabilities });
	try {
		const expect = entry.expect;
		if (expect.limit) {
			assert.throws(() => runtime.execute(entry.script), (e) => e.name === "ExecutionLimitError");
			return;
		}
		if (expect.error) {
			assert.throws(
				() => runtime.execute(entry.script),
				(e) => expect.error.every((part) => e.message.includes(part)),
			);
		} else {
			assert.deepEqual(asJson(runtime.execute(entry.script).value), expect.result);
		}
		if (expect.reads !== undefined) assert.equal(state.reads, expect.reads);
		if (expect.writes !== undefined) assert.deepEqual(state.writes, expect.writes);
	} finally {
		runtime.dispose();
	}
}

describe("accessor corpus", () => {
	it("carries cases", () => {
		assert.ok(corpus.cases.length > 0);
	});

	it("reports the omitted non-optional accessor as missing", () => {
		const { hostBindings } = createProbe();
		const runtime = createRuntime(corpus.manifest, { hostBindings, capabilities: corpus.capabilities });
		assert.deepEqual([...runtime.missingBindings], corpus.missingBindings);
		runtime.dispose();
	});

	for (const entry of corpus.cases) {
		it(entry.name, () => runCase(entry));
	}
});

describe("accessor host shapes", () => {
	const manifest = {
		xript: "0.10",
		name: "accessor-shapes",
		bindings: {
			ns: {
				description: "Accessors supplied as native getters.",
				members: {
					value: { description: "Read and written live.", accessor: "get-set" },
				},
			},
		},
	};

	it("reads a native getter and setter on the host namespace", () => {
		let stored = 3;
		const ns = {
			get value() {
				return stored;
			},
			set value(next) {
				stored = next;
			},
		};
		const runtime = createRuntime(manifest, { hostBindings: { ns } });
		assert.equal(runtime.execute("ns.value = ns.value * 2; ns.value").value, 6);
		assert.equal(stored, 6);
		runtime.dispose();
	});

	it("audits each access as a binding call", () => {
		const events = [];
		const runtime = createRuntime(manifest, {
			hostBindings: { ns: { value: { get: () => 1, set: () => {} } } },
			audit: (event) => events.push(event.binding),
		});
		runtime.execute("ns.value; ns.value = 2;");
		assert.deepEqual(events, ["ns.value", "ns.value"]);
		runtime.dispose();
	});

	it("treats a get-set declaration with no host setter as missing", () => {
		const runtime = createRuntime(manifest, { hostBindings: { ns: { value: { get: () => 1 } } } });
		assert.deepEqual([...runtime.missingBindings], ["ns.value"]);
		assert.throws(() => runtime.execute("ns.value"), (e) => e.message.includes("ns.value"));
		runtime.dispose();
	});
});
