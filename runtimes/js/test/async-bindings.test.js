import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { initXript, initXriptAsync } from "../dist/index.js";

const asyncManifest = {
	xript: "0.1",
	name: "async-binding-app",
	bindings: {
		fetchThing: { async: true, params: [], returns: "object" },
	},
};

const undeclaredManifest = {
	xript: "0.1",
	name: "undeclared-async-app",
	bindings: {
		fetchThing: { params: [], returns: "object" },
	},
};

const namespacedManifest = {
	xript: "0.1",
	name: "namespaced-async-app",
	bindings: {
		net: {
			members: {
				fetchThing: { async: true, params: [], returns: "object" },
				ping: { params: [], returns: "string" },
			},
		},
	},
};

let syncXript;
let asyncXript;

before(async () => {
	syncXript = await initXript();
	asyncXript = await initXriptAsync();
});

describe("async bindings on the synchronous sandbox", () => {
	it("throws a BindingError instead of marshalling an unawaited promise to {}", () => {
		const runtime = syncXript.createRuntime(asyncManifest, {
			hostBindings: { fetchThing: async () => ({ ok: true }) },
			console: { warn: () => {} },
		});

		assert.throws(
			() => runtime.execute("fetchThing()"),
			(e) => {
				assert.match(e.message, /fetchThing/);
				assert.match(e.message, /initXriptAsync|createSandboxAsync/);
				return true;
			},
		);

		runtime.dispose();
	});

	it("boots without error when an async binding is declared but never called", () => {
		const runtime = syncXript.createRuntime(asyncManifest, {
			hostBindings: { fetchThing: async () => ({ ok: true }) },
			console: { warn: () => {} },
		});

		assert.equal(runtime.execute("1 + 1").value, 2);
		runtime.dispose();
	});

	it("refuses async namespace members while leaving sync siblings callable", () => {
		const runtime = syncXript.createRuntime(namespacedManifest, {
			hostBindings: { net: { fetchThing: async () => ({ ok: true }), ping: () => "pong" } },
			console: { warn: () => {} },
		});

		assert.equal(runtime.execute("net.ping()").value, "pong");
		assert.throws(() => runtime.execute("net.fetchThing()"), /net\.fetchThing/);
		runtime.dispose();
	});

	it("warns once at construction naming every async binding", () => {
		const warnings = [];
		const runtime = syncXript.createRuntime(namespacedManifest, {
			hostBindings: { net: { fetchThing: async () => ({}), ping: () => "pong" } },
			console: { warn: (...args) => warnings.push(args.join(" ")) },
		});

		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /net\.fetchThing\(\)/);
		assert.doesNotMatch(warnings[0], /net\.ping/);
		assert.match(warnings[0], /initXriptAsync/);
		runtime.dispose();
	});

	it("does not warn when no binding declares async", () => {
		const warnings = [];
		const runtime = syncXript.createRuntime(undeclaredManifest, {
			hostBindings: { fetchThing: () => ({ ok: true }) },
			console: { warn: (...args) => warnings.push(args.join(" ")) },
		});

		assert.equal(warnings.length, 0);
		runtime.dispose();
	});
});

describe("undeclared promise returns", () => {
	it("throws instead of producing {} when a host function returns a promise without async: true", () => {
		const runtime = syncXript.createRuntime(undeclaredManifest, {
			hostBindings: { fetchThing: () => Promise.resolve({ ok: true }) },
		});

		assert.throws(
			() => runtime.execute("fetchThing()"),
			(e) => {
				assert.match(e.message, /fetchThing/);
				assert.match(e.message, /promise/i);
				return true;
			},
		);

		runtime.dispose();
	});

	it("throws for a thenable nested inside a returned object", () => {
		const runtime = syncXript.createRuntime(undeclaredManifest, {
			hostBindings: { fetchThing: () => ({ inner: { then: () => {} } }) },
		});

		assert.throws(() => runtime.execute("fetchThing()"), /fetchThing/);
		runtime.dispose();
	});

	it("still marshals ordinary objects that merely have a non-function then property", () => {
		const runtime = syncXript.createRuntime(undeclaredManifest, {
			hostBindings: { fetchThing: () => ({ then: "later", ok: true }) },
		});

		assert.deepEqual(runtime.execute("fetchThing()").value, { then: "later", ok: true });
		runtime.dispose();
	});
});

describe("async bindings on the asynchronous sandbox", () => {
	it("still resolves the awaited value", async () => {
		const runtime = await asyncXript.createRuntime(asyncManifest, {
			hostBindings: { fetchThing: async () => ({ ok: true }) },
		});

		const result = await runtime.executeAsync("return await fetchThing();");
		assert.deepEqual(result.value, { ok: true });
		runtime.dispose();
	});
});
