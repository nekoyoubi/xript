import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { initXript, initXriptAsync } from "../dist/index.js";

const corpus = JSON.parse(
	readFileSync(fileURLToPath(new URL("../../../spec/optional-binding-tests.json", import.meta.url)), "utf8"),
);

function buildHost() {
	const host = {};
	for (const [path, { returns }] of Object.entries(corpus.provided)) {
		const segments = path.split(".");
		const name = segments.pop();
		let container = host;
		for (const segment of segments) container = container[segment] ??= {};
		container[name] = path === "echo" ? (value) => value : () => returns;
	}
	return host;
}

async function runCase(factory, entry) {
	const runtime = await factory.createRuntime(corpus.manifest, {
		hostBindings: buildHost(),
		capabilities: corpus.capabilities,
	});
	try {
		if (entry.expect.error) {
			assert.throws(
				() => runtime.execute(entry.script),
				(e) => entry.expect.error.every((part) => e.message.includes(part)),
			);
		} else {
			assert.deepEqual(runtime.execute(entry.script).value, entry.expect.result);
		}
	} finally {
		runtime.dispose();
	}
}

describe("optional binding corpus", () => {
	let sync;
	let async;

	before(async () => {
		sync = await initXript();
		async = await initXriptAsync();
	});

	it("carries cases", () => {
		assert.ok(corpus.cases.length > 0);
	});

	it("reports only the non-optional omission as missing", () => {
		const runtime = sync.createRuntime(corpus.manifest, { hostBindings: buildHost(), capabilities: corpus.capabilities });
		assert.deepEqual([...runtime.missingBindings], corpus.missingBindings);
		runtime.dispose();
	});

	it("refuses strict construction naming exactly the non-optional omission", () => {
		assert.throws(
			() => sync.createRuntime(corpus.manifest, { hostBindings: buildHost(), capabilities: corpus.capabilities, strictBindings: true }),
			(e) => e.name === "MissingBindingsError" && JSON.stringify(e.missing) === JSON.stringify(corpus.missingBindings),
		);
	});

	it("constructs strictly once only optional bindings are omitted", () => {
		const host = buildHost();
		host.legacy = () => "late";
		const runtime = sync.createRuntime(corpus.manifest, { hostBindings: host, capabilities: corpus.capabilities, strictBindings: true });
		assert.equal(runtime.missingBindings.length, 0);
		runtime.dispose();
	});

	for (const entry of corpus.cases) {
		it(`sync: ${entry.name}`, () => runCase(sync, entry));
		it(`async sandbox: ${entry.name}`, () => runCase(async, entry));
	}
});

function buildEagerHost() {
	const { provided, providedValues } = corpus.eagerValue;
	const host = {};
	const place = (path, value) => {
		const segments = path.split(".");
		const name = segments.pop();
		let container = host;
		for (const segment of segments) container = container[segment] ??= {};
		container[name] = value;
	};
	for (const [path, { returns }] of Object.entries(provided)) place(path, () => returns);
	for (const [path, value] of Object.entries(providedValues)) place(path, value);
	return host;
}

describe("optional binding corpus: an eager value for a function binding", () => {
	for (const [label, make] of [["sync", () => initXript()], ["async", () => initXriptAsync()]]) {
		it(`${label}: is missing, and xript.has agrees`, async () => {
			const factory = await make();
			const runtime = await factory.createRuntime(corpus.eagerValue.manifest, { hostBindings: buildEagerHost() });
			try {
				assert.deepEqual([...runtime.missingBindings], corpus.eagerValue.missingBindings);
				assert.deepEqual(runtime.execute(corpus.eagerValue.script).value, corpus.eagerValue.expect.result);
			} finally {
				runtime.dispose();
			}
		});
	}
});
