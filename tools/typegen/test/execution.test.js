import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateTypes } from "../dist/index.js";

const host = {
	xript: "0.8",
	name: "intent-host",
	bindings: {
		getTick: { description: "Reads the tick.", returns: "number", execution: { duration: "instant" } },
		cached: { description: "Cache hit.", async: true, returns: "string" },
		net: {
			description: "Network.",
			members: {
				fetch: {
					description: "Fetch a remote resource.",
					async: true,
					params: [{ name: "url", type: "string" }],
					returns: "string",
					execution: { duration: "long" },
				},
			},
		},
	},
	hooks: { onSave: { description: "Fires on save.", execution: { duration: "unbounded" } } },
	slots: [{ id: "sidebar.left", accepts: ["text/html"], execution: { affinity: "pinned" } }],
};

const mod = {
	xript: "0.8",
	name: "intent-mod",
	version: "1.0.0",
	entry: {
		script: "main.js",
		exports: { crunch: { description: "Crunches.", execution: { duration: "long" } }, ping: { description: "Pings." } },
	},
};

describe("typegen — declared execution intent", () => {
	it("emits @duration and @affinity for a non-default resolved intent", () => {
		const out = generateTypes(host);
		assert.match(out, /@duration instant - completes in microseconds/);
		assert.match(out, /@duration long - may exceed the ambient execution budget/);
		assert.match(out, /@affinity pinned - reads or writes per-runtime mod state/);
	});

	it("emits no intent tags for a surface resolving to the defaults", () => {
		const out = generateTypes({ xript: "0.8", name: "plain", bindings: { f: { description: "F." } } });
		assert.equal(/@duration/.test(out), false);
		assert.equal(/@affinity/.test(out), false);
	});

	it("emits the async-shape remark on EVERY async binding, declared intent or not", () => {
		const out = generateTypes(host);
		const remarks = out.match(/@remarks `async` declares the SHAPE of the value/g) ?? [];
		assert.equal(remarks.length, 2, "one for `cached` (no intent) and one for `net.fetch` (long)");
		assert.match(out, /not the cost of the call/);
		assert.match(out, /It may not yield/);
	});

	it("emits the limits-reach remark on every long or unbounded surface", () => {
		const out = generateTypes(host);
		const remarks = out.match(/@remarks xript's execution budget bounds SCRIPT execution/g) ?? [];
		assert.equal(remarks.length, 2, "`net.fetch` is long and `onSave` is unbounded");
		assert.match(out, /no xript timeout, cancellation token, or drop-cancel will stop it/);
	});

	it("changes no emitted type on account of intent", () => {
		const withIntent = generateTypes(host);
		const stripped = JSON.parse(JSON.stringify(host, (key, value) => (key === "execution" ? undefined : value)));
		const withoutIntent = generateTypes(stripped);
		const signatures = (text) => text.split("\n").filter((line) => /^\s*(declare )?function /.test(line));
		assert.deepEqual(signatures(withIntent), signatures(withoutIntent));
	});

	it("emits no routing table without --intent", () => {
		const out = generateTypes(host);
		assert.equal(/xriptExecution/.test(out), false);
	});

	it("emits the host routing table under the thread contract banner with --intent", () => {
		const out = generateTypes(host, { intent: true });
		assert.match(out, /\/\/ Under a runtime pool, host bindings are invoked concurrently/);
		assert.match(out, /MUST be reentrant and thread-safe/);
		assert.match(out, /export declare const xriptExecution: \{/);
		assert.match(out, /readonly "bindings\/net\.fetch": \{ readonly duration: "long"; readonly affinity: "any" \};/);
		assert.match(out, /readonly "hooks\/onSave": \{ readonly duration: "unbounded"; readonly affinity: "any" \};/);
		assert.match(out, /readonly "slots\/sidebar\.left": \{ readonly duration: "brief"; readonly affinity: "pinned" \};/);
	});

	it("emits the mod routing table keyed by export name", () => {
		const out = generateTypes(mod, { intent: true });
		assert.match(out, /export declare const xriptModExecution: \{/);
		assert.match(out, /readonly "exports\/crunch": \{ readonly duration: "long"; readonly affinity: "any" \};/);
		assert.match(out, /readonly "exports\/ping": \{ readonly duration: "brief"; readonly affinity: "any" \};/);
	});

	it("includes the routing table under --ambient", () => {
		const out = generateTypes(host, { ambient: true });
		assert.match(out, /export declare const xriptExecution: \{/);
	});

	it("resolves an undeclared surface through the manifest-wide default", () => {
		const out = generateTypes(
			{ xript: "0.8", name: "defaulted", execution: { duration: "long" }, bindings: { grind: { description: "Grinds." } } },
			{ intent: true },
		);
		assert.match(out, /@duration long/);
		assert.match(out, /readonly "bindings\/grind": \{ readonly duration: "long"; readonly affinity: "any" \};/);
	});
});
