import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRuntime } from "../dist/index.js";

const corpus = JSON.parse(readFileSync(fileURLToPath(new URL("../../../spec/isolation-tests.json", import.meta.url)), "utf8"));

const hostBindings = () => ({ log: (x) => `log:${x}`, ns: { get: (x) => `get:${x}` } });

async function runCase(testCase, debug = false) {
	const logs = [];
	const runtime = await createRuntime(corpus.host, {
		hostBindings: hostBindings(),
		console: { onLog: (_severity, ...args) => logs.push(args) },
		...(debug ? { debug: { onStopped() {} } } : {}),
	});
	try {
		runtime.loadMod(corpus.a.manifest, { fragmentSources: { [corpus.a.manifest.entry.script]: corpus.a.source } });
		const probes = debug ? runtime.execute(corpus.debugCase.probes).value : null;
		if (!debug) assert.deepEqual(runtime.execute(corpus.internals).value, [], "internals visible to scripts");
		try {
			runtime.loadMod(corpus.b, { fragmentSources: { [corpus.b.entry.script]: testCase.tamper } });
		} catch {
			// a tamper that throws while loading is still a tamper; the corpus ignores the failure
		}
		runtime.invokeModExport("a", "setup", []);
		logs.length = 0;
		for (const step of corpus.steps) {
			const label = JSON.stringify(step);
			if ("fire" in step) {
				const options = "phase" in step ? { phase: step.phase, data: step.data } : { data: step.data };
				assert.deepEqual(runtime.fireHook(step.fire, options), step.expected, label);
			} else if ("fragment" in step) {
				assert.equal(runtime.fireFragmentHook(step.fragment, step.lifecycle).length, step.ops, label);
			} else if ("invoke" in step) {
				const value = runtime.invokeModExport(step.mod, step.invoke, []);
				if ("logs" in step) assert.deepEqual(logs.map((args) => args.join(" ")), step.logs, label);
				else assert.deepEqual(value, step.expected, label);
			} else if ("emit" in step) {
				assert.deepEqual(runtime.emit(step.emit, step.payload), step.expected, label);
			} else if ("execute" in step) {
				assert.deepEqual(runtime.execute(step.execute).value, step.expected, label);
			} else {
				assert.fail(`unknown step ${label}`);
			}
		}
		if (debug) {
			assert.ok(probes.length > 0, "a debug session installs probes");
			assert.deepEqual(runtime.execute(corpus.debugCase.probes).value, probes, "a probe was deleted");
			assert.deepEqual(runtime.execute(corpus.debugCase.locked).value, [], "a probe is writable or configurable");
		}
	} finally {
		runtime.dispose();
	}
}

describe("isolation corpus", () => {
	for (const testCase of corpus.cases) {
		it(testCase.name, () => runCase(testCase));
	}
	it(corpus.debugCase.name, () => runCase(corpus.debugCase, true));
});
