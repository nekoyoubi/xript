import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRuntime, withCaller } from "../dist/index.js";

const corpus = JSON.parse(readFileSync(fileURLToPath(new URL("../../../spec/event-bus-tests.json", import.meta.url)), "utf8"));

const normalize = (value) => (value === undefined ? null : JSON.parse(JSON.stringify(value)));

function callerBindings(names = []) {
	const bindings = {};
	for (const name of names) {
		const parts = name.split(".");
		let target = bindings;
		for (const part of parts.slice(0, -1)) target = target[part] ??= {};
		target[parts.at(-1)] = withCaller((info, ...args) => ({ modId: info.modId, binding: info.binding, args }));
	}
	return bindings;
}

function modManifest(name) {
	return { xript: "0.10", name, version: "1.0.0", entry: "main.js" };
}

async function runCase(testCase) {
	const runtime = createRuntime({ ...corpus.base, ...testCase.host }, {
		hostBindings: callerBindings(testCase.callerBindings),
		capabilities: testCase.grants ?? [],
	});
	try {
		runtime.execute(corpus.prelude);
		runtime.execute(testCase.script);
		for (const mod of testCase.mods ?? []) {
			runtime.loadMod(modManifest(mod.name), { fragmentSources: { "main.js": corpus.trampoline + (mod.source ?? "") } });
		}
		for (const [index, step] of testCase.steps.entries()) {
			const label = `step ${index}: ${JSON.stringify(step).slice(0, 120)}`;
			if ("call" in step) {
				const actual = step.as === null
					? runtime.execute(`${step.call}.apply(null, ${JSON.stringify(step.args ?? [])})`).value
					: runtime.invokeModExport(step.as, "call", [step.call, step.args ?? []]);
				assert.deepEqual(normalize(actual), step.expect, label);
			} else if ("emit" in step) {
				const actual = "payload" in step ? runtime.emit(step.emit, step.payload) : runtime.emit(step.emit);
				assert.deepEqual(normalize(actual), step.expect, label);
			} else if ("cancelOwned" in step) {
				assert.equal(runtime.cancelOwned(step.cancelOwned), step.expect, label);
			} else if ("declare" in step) {
				if (step.throws) assert.throws(() => runtime.declareEvent(step.declare), label);
				else assert.deepEqual(normalize(runtime.declareEvent(step.declare)), step.expect, label);
			} else {
				assert.fail(`unknown step kind: ${label}`);
			}
			await runtime.executeAsync("undefined");
		}
	} finally {
		runtime.dispose();
	}
}

describe("event bus corpus (node)", () => {
	for (const testCase of corpus.cases) {
		it(testCase.name, () => runCase(testCase));
	}
});
