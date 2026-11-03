import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { initXript, initXriptAsync } from "../dist/index.js";

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

async function notices(factory, entry) {
	const seen = [];
	const runtime = await factory.createRuntime(entry.manifest, {
		hostBindings: hostFor(entry.provided),
		onDeprecation: (notice) => seen.push({ ...notice }),
	});
	runtime.dispose();
	return seen;
}

for (const [label, make] of [
	["sync", () => initXript()],
	["async", () => initXriptAsync()],
]) {
	describe(`deprecation corpus (js, ${label})`, async () => {
		const factory = await make();
		for (const entry of corpus.cases) {
			it(entry.name, async () => {
				for (let i = 0; i < (entry.runtimes ?? 1); i++) {
					assert.deepEqual(await notices(factory, entry), entry.expect);
				}
			});
		}
	});
}

describe("deprecation channel without a handler", () => {
	it("warns once per code on console.warn", async () => {
		const xript = await initXript();
		const warned = [];
		const original = console.warn;
		console.warn = (...args) => warned.push(args.join(" "));
		try {
			const runtime = xript.createRuntime(corpus.cases[2].manifest, { hostBindings: hostFor(corpus.cases[2].provided) });
			runtime.dispose();
		} finally {
			console.warn = original;
		}
		assert.equal(warned.length, 1);
		assert.match(warned[0], /^xript: host bindings replaced .* \(binding-shadows-builtin\)\. Rename the binding/);
	});

	it("keeps going when the host's handler throws", async () => {
		const xript = await initXript();
		const runtime = xript.createRuntime(corpus.cases[0].manifest, {
			hostBindings: hostFor(corpus.cases[0].provided),
			onDeprecation: () => {
				throw new Error("boom");
			},
		});
		assert.equal(runtime.execute("typeof events.on").value, "function");
		runtime.dispose();
	});
});
