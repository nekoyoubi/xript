import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRuntime } from "../dist/index.js";

const corpus = JSON.parse(
	readFileSync(fileURLToPath(new URL("../../../spec/names-as-data-tests.json", import.meta.url)), "utf8"),
);

const TOKEN = "$NAME";

function placeData(value, name) {
	if (value === TOKEN) return name;
	if (Array.isArray(value)) return value.map((item) => placeData(item, name));
	if (value === null || typeof value !== "object") return value;
	const out = {};
	for (const [key, item] of Object.entries(value)) {
		Object.defineProperty(out, key === TOKEN ? name : key, {
			value: placeData(item, name),
			writable: true,
			enumerable: true,
			configurable: true,
		});
	}
	return out;
}

const placeSource = (source, name) => source.split(TOKEN).join(JSON.stringify(name));

function hostBindings(paths) {
	const root = {};
	for (const path of paths ?? []) {
		let node = root;
		for (const segment of path.slice(0, -1)) {
			if (!Object.prototype.hasOwnProperty.call(node, segment)) {
				Object.defineProperty(node, segment, { value: {}, writable: true, enumerable: true, configurable: true });
			}
			node = node[segment];
		}
		Object.defineProperty(node, path[path.length - 1], { value: () => "ok", writable: true, enumerable: true, configurable: true });
	}
	return root;
}

async function runCase(testCase, name) {
	const runtime = await createRuntime(placeData(testCase.manifest, name), {
		hostBindings: hostBindings(placeData(testCase.provide, name)),
	});
	try {
		if (testCase.mod) {
			const manifest = placeData(testCase.mod.manifest, name);
			runtime.loadMod(manifest, { fragmentSources: { [manifest.entry.script]: placeSource(testCase.mod.source, name) } });
		}
		if (testCase.setup) runtime.execute(placeSource(testCase.setup, name));
		for (const step of testCase.steps.map((raw) => placeData(raw, name))) {
			if ("execute" in step) {
				const value = runtime.execute(placeSource(step.execute, name)).value;
				if ("includes" in step) {
					assert.equal(typeof value, "string", `expected a message, got ${JSON.stringify(value)}`);
					for (const part of step.includes) assert.ok(value.includes(part), `${JSON.stringify(value)} lacks ${JSON.stringify(part)}`);
				} else {
					assert.deepEqual(value, step.expected);
				}
			} else if ("fire" in step) {
				const options = "phase" in step ? { phase: step.phase, data: step.data } : { data: step.data };
				assert.deepEqual(runtime.fireHook(step.fire, options), step.expected);
			} else if ("fragment" in step) {
				assert.equal(runtime.fireFragmentHook(step.fragment, step.lifecycle).length, step.ops);
			} else if ("invoke" in step) {
				const value = "mod" in step ? runtime.invokeModExport(step.mod, step.invoke, []) : runtime.invokeExport(step.invoke, []);
				assert.deepEqual(value, step.expected);
			} else {
				assert.fail(`unknown step ${JSON.stringify(step)}`);
			}
		}
		assert.equal(runtime.execute("typeof globalThis.ran").value, "undefined", "a name ran as script");
	} finally {
		runtime.dispose();
	}
}

describe("names as data corpus", () => {
	for (const testCase of corpus.cases) {
		for (const { label, value } of corpus.names) {
			it(`${testCase.name}: ${label}`, () => runCase(testCase, value));
		}
	}

	it("executeAsync runs source ending in a line comment", async () => {
		const runtime = await createRuntime({ xript: "0.10", name: "names-probe" }, {});
		try {
			assert.equal((await runtime.executeAsync("return 1 // trailing note")).value, 1);
		} finally {
			runtime.dispose();
		}
	});
});
