import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRuntime } from "../dist/index.js";

const corpus = JSON.parse(readFileSync(fileURLToPath(new URL("../../../spec/deprecation-tests.json", import.meta.url)), "utf8"));

function hostFor(paths) {
	const bindings = {};
	for (const path of paths) {
		const parts = path.split(".");
		let target = bindings;
		for (const part of parts.slice(0, -1)) target = target[part] ??= {};
		target[parts.at(-1)] = () => path;
	}
	return bindings;
}

function notices(entry) {
	const seen = [];
	const runtime = createRuntime(entry.manifest, {
		hostBindings: hostFor(entry.provided),
		onDeprecation: (notice) => seen.push({ ...notice }),
	});
	runtime.dispose();
	return seen;
}

describe("deprecation corpus (node)", () => {
	for (const entry of corpus.cases) {
		it(entry.name, () => {
			for (let i = 0; i < (entry.runtimes ?? 1); i++) {
				assert.deepEqual(notices(entry), entry.expect);
			}
		});
	}
});

describe("deprecation channel without a handler", () => {
	it("warns once per code on console.warn", () => {
		const warned = [];
		const original = console.warn;
		console.warn = (...args) => warned.push(args.join(" "));
		try {
			createRuntime(corpus.cases[2].manifest, { hostBindings: hostFor(corpus.cases[2].provided) }).dispose();
		} finally {
			console.warn = original;
		}
		assert.equal(warned.length, 1);
		assert.match(warned[0], /^xript: host bindings replaced .* \(binding-shadows-builtin\)\. Rename the binding/);
	});

	it("keeps going when the host's handler throws", () => {
		const runtime = createRuntime(corpus.cases[0].manifest, {
			hostBindings: hostFor(corpus.cases[0].provided),
			onDeprecation: () => {
				throw new Error("boom");
			},
		});
		assert.equal(runtime.execute("typeof events.on").value, "function");
		runtime.dispose();
	});
});
