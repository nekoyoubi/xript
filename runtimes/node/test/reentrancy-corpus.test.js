import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRuntime, withCaller } from "../dist/index.js";

const corpus = JSON.parse(readFileSync(fileURLToPath(new URL("../../../spec/reentrancy-tests.json", import.meta.url)), "utf8"));

const normalize = (value) => (value === undefined ? null : JSON.parse(JSON.stringify(value)));

function reentrantHost(runtimeRef, kept, started) {
	const entries = {
		execute: (code) => runtimeRef.current.execute(code).value,
		executeAsync: (code) => {
			started.push(runtimeRef.current.executeAsync(code));
			return null;
		},
		invokeExport: ([name, args]) => runtimeRef.current.invokeExport(name, args),
		invokeModExport: ([name, args]) => runtimeRef.current.invokeModExport(corpus.mod.manifest.name, name, args),
		fireHook: ([hook, data]) => runtimeRef.current.fireHook(hook, { data }),
		emit: ([event, payload]) => runtimeRef.current.emit(event, payload),
	};
	return {
		enter: (entry, arg) => entries[entry](arg),
		keep: (fn) => {
			kept.push(fn.retain());
			return kept.length - 1;
		},
		callKept: (index, arg) => kept[index].call(arg),
		who: withCaller((info) => ({ modId: info.modId ?? null, binding: info.binding })),
	};
}

async function runCase(testCase) {
	const runtimeRef = { current: null };
	const kept = [];
	const started = [];
	runtimeRef.current = createRuntime(corpus.manifest, {
		hostBindings: reentrantHost(runtimeRef, kept, started),
		capabilities: [],
		budgetHandlers: true,
	});
	const runtime = runtimeRef.current;
	try {
		runtime.loadMod(corpus.mod.manifest, { fragmentSources: { [corpus.mod.manifest.entry.script]: corpus.mod.source } });
		runtime.execute(corpus.setup);
		const scriptValue = runtime.execute(testCase.script).value;
		const actual = testCase.kept ? kept[testCase.kept.index].call(...testCase.kept.args) : scriptValue;
		assert.deepEqual(normalize(actual), testCase.expected);
		const settled = await Promise.all(started);
		assert.deepEqual(settled.map((result) => normalize(result.value)), testCase.settled ?? []);
		assert.equal(runtime.execute("'usable'").value, "usable");
	} finally {
		runtime.dispose();
	}
}

describe("re-entrancy corpus", () => {
	for (const testCase of corpus.cases) {
		it(testCase.name, () => runCase(testCase));
	}
});
