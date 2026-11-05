import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRuntime, HostEventsError } from "../dist/index.js";

const corpus = JSON.parse(readFileSync(fileURLToPath(new URL("../../../spec/host-events-tests.json", import.meta.url)), "utf8"));

function hostBindingsFor(manifest) {
	const supplied = {};
	for (const [name, binding] of Object.entries(manifest.bindings ?? {})) {
		if (binding.members) {
			supplied[name] = Object.fromEntries(Object.keys(binding.members).map((member) => [member, (x) => `${member}:${x}`]));
		} else {
			supplied[name] = (x) => `${name}:${x}`;
		}
	}
	return supplied;
}

async function runCase(testCase) {
	const manifest = corpus.hosts[testCase.host];
	const deprecations = [];
	const construct = () =>
		createRuntime(manifest, {
			hostBindings: hostBindingsFor(manifest),
			hostEvents: testCase.hostEvents,
			onDeprecation: (notice) => deprecations.push(notice.code),
		});

	if ("error" in testCase) {
		await assert.rejects(async () => construct(), (error) => {
			assert.ok(error instanceof HostEventsError, `expected HostEventsError, got ${error?.name}`);
			assert.ok(error.message.includes(testCase.error), error.message);
			return true;
		});
		return;
	}

	const runtime = await construct();
	try {
		assert.deepEqual(deprecations, testCase.deprecations, "deprecations at construction");
		if ("tamper" in testCase) {
			try {
				runtime.loadMod(corpus.mod, { fragmentSources: { [corpus.mod.entry.script]: testCase.tamper } });
			} catch {
				// a tamper that throws while loading is still a tamper; the corpus ignores the failure
			}
		}
		for (const step of testCase.steps) {
			const label = JSON.stringify(step);
			if ("execute" in step) {
				assert.deepEqual(runtime.execute(step.execute).value, step.expected, label);
			} else if ("host" in step) {
				const call = () => runtime[step.host](...step.args);
				if ("throws" in step) {
					assert.throws(call, (error) => error instanceof HostEventsError && error.message.includes(step.throws), label);
				} else {
					assert.deepEqual(call(), step.expected, label);
				}
			} else {
				assert.fail(`unknown step ${label}`);
			}
		}
	} finally {
		runtime.dispose();
	}
}

describe("host events corpus", () => {
	for (const testCase of corpus.cases) {
		it(testCase.name, () => runCase(testCase));
	}
});
