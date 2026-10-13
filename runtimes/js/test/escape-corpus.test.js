import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { initXript, initXriptAsync } from "../dist/index.js";

const corpus = JSON.parse(
	readFileSync(fileURLToPath(new URL("../../../spec/escape-tests.json", import.meta.url)), "utf8"),
);

function at(payload, path) {
	let current = payload;
	for (const step of path) current = current?.[step];
	return current;
}

const hostBindings = {
	probe: {
		data: () => ({ list: [1, { k: "v" }] }),
		fail: () => {
			throw new Error("host failure");
		},
		call: (path, callArgs, ...payload) => at(payload, path)(...callArgs),
	},
};

async function run(factory, entry) {
	const runtime = await factory.createRuntime(corpus.manifest, { hostBindings });
	try {
		return runtime.execute(corpus.template.replace("EXPR", entry.expr)).value;
	} finally {
		runtime.dispose();
	}
}

describe("escape corpus", () => {
	let sync;
	let async;

	before(async () => {
		sync = await initXript();
		async = await initXriptAsync();
	});

	it("carries cases", () => {
		assert.ok(corpus.cases.length > 0);
	});

	for (const entry of corpus.cases) {
		it(`sync: ${entry.name}`, async () => assert.equal(await run(sync, entry), "blocked"));
		it(`async sandbox: ${entry.name}`, async () => assert.equal(await run(async, entry), "blocked"));
	}
});
