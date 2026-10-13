import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRuntime } from "../dist/index.js";

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

const blocked = (expr) => corpus.template.replace("EXPR", expr);

describe("escape corpus", () => {
	it("carries cases", () => {
		assert.ok(corpus.cases.length > 0);
	});

	for (const entry of corpus.cases) {
		it(entry.name, () => {
			const runtime = createRuntime(corpus.manifest, { hostBindings });
			try {
				assert.equal(runtime.execute(blocked(entry.expr)).value, "blocked");
			} finally {
				runtime.dispose();
			}
		});
	}
});

describe("host values are re-created in the sandbox realm", () => {
	const manifest = {
		xript: "0.8",
		name: "realm-host",
		bindings: {
			fetchThing: { description: "Async data.", async: true },
			hostFn: { description: "Returns a host function." },
			rich: { description: "Returns rich host values." },
		},
		hooks: { onSave: { description: "Fires with host data." } },
		events: [{ id: "tick", description: "Carries a host payload." }],
	};
	const bindings = {
		fetchThing: async () => ({ ok: [1] }),
		hostFn: () => (n) => ({ doubled: n * 2 }),
		rich: () => ({
			when: new Date(0),
			map: new Map([["k", { v: 1 }]]),
			set: new Set([1]),
			bytes: new Uint8Array([1, 2]),
			pattern: /a+/g,
			error: new TypeError("inner"),
		}),
	};
	const runtime = () => createRuntime(manifest, { hostBindings: bindings });

	it("an async binding's promise and its value", async () => {
		const rt = runtime();
		try {
			const { value } = await rt.executeAsync(
				`var p = fetchThing(); var v = await p; return [${blocked("p.constructor.constructor")}, ${blocked("v.ok.constructor.constructor")}];`,
			);
			assert.deepEqual(value, ["blocked", "blocked"]);
		} finally {
			rt.dispose();
		}
	});

	it("a host function a binding returned, and what it returns", () => {
		const rt = runtime();
		try {
			const { value } = rt.execute(
				`[${blocked("hostFn().constructor")}, ${blocked("hostFn()(2).constructor.constructor")}, hostFn()(2).doubled]`,
			);
			assert.deepEqual(value, ["blocked", "blocked", 4]);
		} finally {
			rt.dispose();
		}
	});

	it("dates, maps, sets, typed arrays, regexps, and errors keep working in the sandbox realm", () => {
		const rt = runtime();
		try {
			const { value } = rt.execute(`(function () {
				var r = rich();
				var checks = [
					r.when.getTime() === 0,
					r.map.get("k").v === 1,
					r.set.has(1),
					r.bytes[1] === 2,
					r.pattern.test("aa"),
					r.error instanceof TypeError && r.error.message === "inner",
				];
				return checks.concat([
					${blocked("r.when.constructor.constructor")},
					${blocked("r.map.constructor.constructor")},
					${blocked("r.map.get('k').constructor.constructor")},
					${blocked("r.bytes.constructor.constructor")},
					${blocked("r.error.constructor.constructor")},
				]);
			})()`);
			assert.deepEqual(value, [true, true, true, true, true, true, "blocked", "blocked", "blocked", "blocked", "blocked"]);
		} finally {
			rt.dispose();
		}
	});

	it("hook data and event payloads", () => {
		const rt = runtime();
		try {
			rt.execute(`
				hooks.onSave(function (doc) { globalThis.fromHook = ${blocked("doc.constructor.constructor")}; });
				events.on("tick", function (payload) { globalThis.fromEvent = ${blocked("payload.constructor.constructor")}; });
			`);
			rt.fireHook("onSave", { data: { doc: { title: "t" } } });
			rt.emit("tick", { payload: { n: 1 } });
			assert.deepEqual(rt.execute("[fromHook, fromEvent]").value, ["blocked", "blocked"]);
		} finally {
			rt.dispose();
		}
	});

	it("the API globals and the errors they throw", () => {
		const rt = runtime();
		try {
			const { value } = rt.execute(`[
				${blocked("hooks.onSave.constructor")},
				${blocked("events.on.constructor")},
				${blocked("xript.exports.register.constructor")},
				${blocked("(function () { try { events.on('nope', function () {}); } catch (e) { return e; } })().constructor.constructor")},
				${blocked("BindingError")},
			]`);
			assert.deepEqual(value, ["blocked", "blocked", "blocked", "blocked", "blocked"]);
		} finally {
			rt.dispose();
		}
	});

	it("fragment bindings and the fragment op proxy", () => {
		const rt = runtime();
		try {
			rt.execute(`hooks.fragment.mount("panel", function (data, fragment) {
				globalThis.fromFragment = [${blocked("data.constructor.constructor")}, ${blocked("fragment.setText.constructor")}];
				fragment.setText("#t", "ok");
			});`);
			const ops = rt.fireFragmentHook("panel", "mount", { count: 1 });
			assert.equal(ops.length, 1);
			assert.deepEqual(rt.execute("fromFragment").value, ["blocked", "blocked"]);
		} finally {
			rt.dispose();
		}
	});

	it("export arguments the host passes", () => {
		const rt = runtime();
		try {
			rt.execute(`xript.exports.register("probe", function (arg) { return ${blocked("arg.constructor.constructor")}; });`);
			assert.equal(rt.invokeExport("probe", [{ host: true }]), "blocked");
		} finally {
			rt.dispose();
		}
	});

	it("script errors still surface to the host as the host's error classes", async () => {
		const { BindingError } = await import("../dist/index.js");
		const rt = runtime();
		try {
			assert.throws(() => rt.execute("events.on('nope', function () {})"), (e) => e instanceof BindingError);
		} finally {
			rt.dispose();
		}
	});
});
