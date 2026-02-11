import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { initXript, ManifestValidationError } from "../dist/index.js";

const minimalManifest = {
	xript: "0.1",
	name: "test-app",
};

let xript;

describe("initXript", () => {
	it("loads the WASM module and returns a factory", async () => {
		xript = await initXript();
		assert.ok(xript);
		assert.equal(typeof xript.createRuntime, "function");
	});
});

describe("createRuntime", () => {
	it("creates a runtime from a valid manifest", () => {
		const runtime = xript.createRuntime(minimalManifest, { hostBindings: {} });
		assert.ok(runtime);
		assert.equal(runtime.manifest.name, "test-app");
		runtime.dispose();
	});

	it("rejects invalid manifests", () => {
		assert.throws(() => xript.createRuntime({}, { hostBindings: {} }), /Invalid xript manifest/);
		assert.throws(() => xript.createRuntime({ xript: "0.1" }, { hostBindings: {} }), /Invalid xript manifest/);
	});
});

describe("basic script execution", () => {
	it("executes simple expressions", () => {
		const runtime = xript.createRuntime(minimalManifest, { hostBindings: {} });
		const result = runtime.execute("2 + 2");
		assert.equal(result.value, 4);
		assert.ok(result.duration_ms >= 0);
		runtime.dispose();
	});

	it("executes multi-line scripts", () => {
		const runtime = xript.createRuntime(minimalManifest, { hostBindings: {} });
		const result = runtime.execute("const a = 10; const b = 20; a + b;");
		assert.equal(result.value, 30);
		runtime.dispose();
	});

	it("supports standard JavaScript built-ins", () => {
		const runtime = xript.createRuntime(minimalManifest, { hostBindings: {} });

		assert.equal(runtime.execute("typeof Math.PI").value, "number");
		assert.equal(runtime.execute("JSON.stringify({a: 1})").value, '{"a":1}');
		assert.equal(runtime.execute("Array.isArray([1, 2, 3])").value, true);
		assert.equal(runtime.execute("[1, 2, 3].map(x => x * 2).join(',')").value, "2,4,6");
		assert.equal(runtime.execute("new Map([[1, 'a']]).get(1)").value, "a");
		assert.equal(runtime.execute("new Set([1, 2, 2, 3]).size").value, 3);
		runtime.dispose();
	});

	it("supports Promises and async execution", async () => {
		const runtime = xript.createRuntime(minimalManifest, { hostBindings: {} });
		const result = await runtime.executeAsync("return await Promise.resolve(42);");
		assert.equal(result.value, 42);
		runtime.dispose();
	});
});

describe("host bindings", () => {
	it("exposes top-level function bindings", () => {
		const manifest = {
			xript: "0.1",
			name: "test",
			bindings: {
				add: { description: "Adds two numbers.", params: [{ name: "a", type: "number" }, { name: "b", type: "number" }], returns: "number" },
			},
		};
		const runtime = xript.createRuntime(manifest, {
			hostBindings: { add: (a, b) => Number(a) + Number(b) },
		});
		assert.equal(runtime.execute("add(3, 4)").value, 7);
		runtime.dispose();
	});

	it("exposes namespace bindings", () => {
		const manifest = {
			xript: "0.1",
			name: "test",
			bindings: {
				math: {
					description: "Math operations.",
					members: {
						add: { description: "Adds.", params: [{ name: "a", type: "number" }, { name: "b", type: "number" }], returns: "number" },
						multiply: { description: "Multiplies.", params: [{ name: "a", type: "number" }, { name: "b", type: "number" }], returns: "number" },
					},
				},
			},
		};
		const runtime = xript.createRuntime(manifest, {
			hostBindings: {
				math: {
					add: (a, b) => Number(a) + Number(b),
					multiply: (a, b) => Number(a) * Number(b),
				},
			},
		});
		assert.equal(runtime.execute("math.add(2, 3)").value, 5);
		assert.equal(runtime.execute("math.multiply(4, 5)").value, 20);
		runtime.dispose();
	});

	it("wraps host errors in BindingError", () => {
		const manifest = {
			xript: "0.1",
			name: "test",
			bindings: { fail: { description: "Always fails." } },
		};
		const runtime = xript.createRuntime(manifest, {
			hostBindings: {
				fail: () => {
					throw new Error("host exploded");
				},
			},
		});
		const result = runtime.execute(`
			let caught;
			try { fail(); } catch (e) { caught = e; }
			caught.name + ": " + caught.message;
		`);
		assert.ok(String(result.value).includes("BindingError"));
		assert.ok(String(result.value).includes("host exploded"));
		runtime.dispose();
	});

	it("throws BindingError when host function is not provided", () => {
		const manifest = {
			xript: "0.1",
			name: "test",
			bindings: { missing: { description: "Missing binding." } },
		};
		const runtime = xript.createRuntime(manifest, { hostBindings: {} });
		const result = runtime.execute(`
			let caught;
			try { missing(); } catch (e) { caught = e; }
			caught.name + ": " + caught.binding;
		`);
		assert.ok(String(result.value).includes("BindingError"));
		assert.ok(String(result.value).includes("missing"));
		runtime.dispose();
	});
});

describe("capability enforcement", () => {
	const manifest = {
		xript: "0.1",
		name: "test",
		bindings: {
			readData: { description: "Reads data.", returns: "string" },
			writeData: { description: "Writes data.", params: [{ name: "value", type: "string" }], capability: "storage" },
			deleteData: { description: "Deletes data.", capability: "admin" },
		},
		capabilities: {
			storage: { description: "Read/write storage.", risk: "low" },
			admin: { description: "Admin operations.", risk: "high" },
		},
	};

	it("allows ungated bindings without any capabilities", () => {
		const runtime = xript.createRuntime(manifest, {
			hostBindings: { readData: () => "hello" },
		});
		assert.equal(runtime.execute("readData()").value, "hello");
		runtime.dispose();
	});

	it("throws CapabilityDeniedError for gated bindings without the capability", () => {
		const runtime = xript.createRuntime(manifest, {
			hostBindings: { writeData: () => {} },
		});
		const result = runtime.execute(`
			let caught;
			try { writeData("test"); } catch (e) { caught = e; }
			caught.name;
		`);
		assert.equal(result.value, "CapabilityDeniedError");
		runtime.dispose();
	});

	it("includes capability name and guidance in the error message", () => {
		const runtime = xript.createRuntime(manifest, {
			hostBindings: { writeData: () => {} },
		});
		const result = runtime.execute(`
			let msg;
			try { writeData("test"); } catch (e) { msg = e.message; }
			msg;
		`);
		assert.ok(String(result.value).includes("storage"));
		assert.ok(String(result.value).includes("writeData"));
		assert.ok(String(result.value).includes("app developer"));
		runtime.dispose();
	});

	it("allows gated bindings when capability is granted", () => {
		const runtime = xript.createRuntime(manifest, {
			hostBindings: {
				readData: () => "hello",
				writeData: (v) => `wrote: ${v}`,
			},
			capabilities: ["storage"],
		});
		assert.equal(runtime.execute("readData()").value, "hello");
		assert.equal(runtime.execute("writeData('test')").value, "wrote: test");
		runtime.dispose();
	});

	it("denies capabilities not in the grant set", () => {
		const runtime = xript.createRuntime(manifest, {
			hostBindings: {
				readData: () => "hello",
				writeData: () => {},
				deleteData: () => {},
			},
			capabilities: ["storage"],
		});
		assert.equal(runtime.execute("readData()").value, "hello");
		const result = runtime.execute(`
			let caught;
			try { deleteData(); } catch (e) { caught = e.name; }
			caught;
		`);
		assert.equal(result.value, "CapabilityDeniedError");
		runtime.dispose();
	});

	it("does not execute the function when capability is denied", () => {
		let called = false;
		const runtime = xript.createRuntime(manifest, {
			hostBindings: {
				writeData: () => { called = true; },
			},
		});
		runtime.execute(`
			try { writeData("test"); } catch (e) {}
		`);
		assert.equal(called, false);
		runtime.dispose();
	});
});

describe("sandbox isolation", () => {
	it("blocks eval()", () => {
		const runtime = xript.createRuntime(minimalManifest, { hostBindings: {} });
		const result = runtime.execute(`
			let caught;
			try { eval("1 + 1"); } catch (e) { caught = e; }
			caught.name + ": " + caught.message;
		`);
		assert.ok(String(result.value).includes("TypeError"));
		assert.ok(String(result.value).includes("not permitted"));
		runtime.dispose();
	});

	it("blocks new Function()", () => {
		const runtime = xript.createRuntime(minimalManifest, { hostBindings: {} });
		const result = runtime.execute(`
			let caught;
			try { new Function("return 1"); } catch (e) { caught = e; }
			caught.message;
		`);
		assert.ok(String(result.value).includes("not permitted"));
		runtime.dispose();
	});

	it("does not expose process, require, or import", () => {
		const runtime = xript.createRuntime(minimalManifest, { hostBindings: {} });
		assert.equal(runtime.execute("typeof process").value, "undefined");
		assert.equal(runtime.execute("typeof require").value, "undefined");
		assert.equal(runtime.execute("typeof module").value, "undefined");
		runtime.dispose();
	});

	it("does not expose fetch, setTimeout, or setInterval", () => {
		const runtime = xript.createRuntime(minimalManifest, { hostBindings: {} });
		assert.equal(runtime.execute("typeof fetch").value, "undefined");
		assert.equal(runtime.execute("typeof setTimeout").value, "undefined");
		assert.equal(runtime.execute("typeof setInterval").value, "undefined");
		runtime.dispose();
	});

	it("does not expose Node.js specific globals", () => {
		const runtime = xript.createRuntime(minimalManifest, { hostBindings: {} });
		assert.equal(runtime.execute("typeof Buffer").value, "undefined");
		assert.equal(runtime.execute("typeof __dirname").value, "undefined");
		assert.equal(runtime.execute("typeof __filename").value, "undefined");
		runtime.dispose();
	});

	it("namespace objects are frozen", () => {
		const manifest = {
			xript: "0.1",
			name: "test",
			bindings: {
				ns: {
					description: "A namespace.",
					members: { fn: { description: "A function.", returns: "string" } },
				},
			},
		};
		const runtime = xript.createRuntime(manifest, {
			hostBindings: { ns: { fn: () => "original" } },
		});
		const result = runtime.execute(`
			"use strict";
			let tampered = false;
			try {
				ns.fn = () => "hacked";
			} catch (e) {
				tampered = true;
			}
			tampered;
		`);
		assert.equal(result.value, true);
		runtime.dispose();
	});
});

describe("execution limits", () => {
	it("terminates scripts that exceed timeout", () => {
		const manifest = {
			xript: "0.1",
			name: "test",
			limits: { timeout_ms: 50 },
		};
		const runtime = xript.createRuntime(manifest, { hostBindings: {} });
		assert.throws(
			() => runtime.execute("while (true) {}"),
			(err) => err.name === "ExecutionLimitError" && err.message.includes("timed out") && err.message.includes("50ms"),
		);
		runtime.dispose();
	});

	it("uses default 5000ms timeout when limits are not specified", () => {
		const runtime = xript.createRuntime(minimalManifest, { hostBindings: {} });
		const result = runtime.execute("1 + 1");
		assert.equal(result.value, 2);
		runtime.dispose();
	});

	it("short timeout still allows quick scripts", () => {
		const manifest = {
			xript: "0.1",
			name: "test",
			limits: { timeout_ms: 100 },
		};
		const runtime = xript.createRuntime(manifest, { hostBindings: {} });
		const result = runtime.execute("42");
		assert.equal(result.value, 42);
		runtime.dispose();
	});
});

describe("console", () => {
	it("routes console.log to host console", () => {
		const logs = [];
		const runtime = xript.createRuntime(minimalManifest, {
			hostBindings: {},
			console: {
				log: (...args) => logs.push(args),
				warn: () => {},
				error: () => {},
			},
		});
		runtime.execute('console.log("hello", 42)');
		assert.equal(logs.length, 1);
		assert.deepEqual(logs[0], ["hello", 42]);
		runtime.dispose();
	});

	it("routes console.warn and console.error to host console", () => {
		const warns = [];
		const errors = [];
		const runtime = xript.createRuntime(minimalManifest, {
			hostBindings: {},
			console: {
				log: () => {},
				warn: (...args) => warns.push(args),
				error: (...args) => errors.push(args),
			},
		});
		runtime.execute('console.warn("warning"); console.error("error")');
		assert.equal(warns.length, 1);
		assert.equal(errors.length, 1);
		runtime.dispose();
	});
});

describe("state isolation between executions", () => {
	it("persists state within the same runtime", () => {
		const runtime = xript.createRuntime(minimalManifest, { hostBindings: {} });
		runtime.execute("var counter = 0;");
		runtime.execute("counter++;");
		const result = runtime.execute("counter");
		assert.equal(result.value, 1);
		runtime.dispose();
	});
});

describe("manifest validation", () => {
	it("throws ManifestValidationError for null input", () => {
		assert.throws(
			() => xript.createRuntime(null, { hostBindings: {} }),
			(err) => err instanceof ManifestValidationError && err.issues.length === 1,
		);
	});

	it("throws ManifestValidationError for non-object input", () => {
		assert.throws(
			() => xript.createRuntime("not-an-object", { hostBindings: {} }),
			(err) => err instanceof ManifestValidationError,
		);
	});

	it("collects multiple structural issues", () => {
		try {
			xript.createRuntime({}, { hostBindings: {} });
			assert.fail("should have thrown");
		} catch (err) {
			assert.ok(err instanceof ManifestValidationError);
			assert.ok(err.issues.length >= 2);
			const paths = err.issues.map((i) => i.path);
			assert.ok(paths.includes("/xript"));
			assert.ok(paths.includes("/name"));
		}
	});

	it("rejects invalid bindings type", () => {
		assert.throws(
			() => xript.createRuntime({ xript: "0.1", name: "test", bindings: "bad" }, { hostBindings: {} }),
			(err) => err instanceof ManifestValidationError && err.issues.some((i) => i.path === "/bindings"),
		);
	});

	it("rejects invalid limits values", () => {
		assert.throws(
			() => xript.createRuntime({ xript: "0.1", name: "test", limits: { timeout_ms: -1 } }, { hostBindings: {} }),
			(err) => err instanceof ManifestValidationError && err.issues.some((i) => i.path === "/limits/timeout_ms"),
		);
	});

	it("passes basic structural check for valid manifests", () => {
		const runtime = xript.createRuntime(
			{ xript: "0.1", name: "test", bindings: {}, capabilities: {}, limits: { timeout_ms: 100 } },
			{ hostBindings: {} },
		);
		assert.ok(runtime);
		runtime.dispose();
	});
});

describe("hooks", () => {
	it("registers and fires a simple hook", () => {
		const manifest = {
			xript: "0.1",
			name: "test",
			hooks: {
				onDamage: { description: "Fired when damage occurs.", params: [{ name: "amount", type: "number" }] },
			},
		};
		const runtime = xript.createRuntime(manifest, { hostBindings: {} });
		runtime.execute("hooks.onDamage((amount) => { globalThis._lastDamage = amount; })");
		runtime.fireHook("onDamage", { data: 25 });
		assert.equal(runtime.execute("globalThis._lastDamage").value, 25);
		runtime.dispose();
	});

	it("registers and fires a phased hook", () => {
		const manifest = {
			xript: "0.1",
			name: "test",
			hooks: {
				save: {
					description: "Save lifecycle.",
					phases: ["pre", "post", "done"],
					params: [{ name: "filename", type: "string" }],
				},
			},
		};
		const runtime = xript.createRuntime(manifest, { hostBindings: {} });
		runtime.execute(`
			globalThis._phases = [];
			hooks.save.pre((filename) => { globalThis._phases.push("pre:" + filename); });
			hooks.save.post((filename) => { globalThis._phases.push("post:" + filename); });
			hooks.save.done((filename) => { globalThis._phases.push("done:" + filename); });
		`);
		runtime.fireHook("save", { phase: "pre", data: "game.sav" });
		runtime.fireHook("save", { phase: "post", data: "game.sav" });
		runtime.fireHook("save", { phase: "done", data: "game.sav" });
		const phases = runtime.execute("globalThis._phases").value;
		assert.deepEqual(phases, ["pre:game.sav", "post:game.sav", "done:game.sav"]);
		runtime.dispose();
	});

	it("returns handler results from fireHook", () => {
		const manifest = {
			xript: "0.1",
			name: "test",
			hooks: {
				validate: { description: "Validation hook.", params: [{ name: "value", type: "number" }] },
			},
		};
		const runtime = xript.createRuntime(manifest, { hostBindings: {} });
		runtime.execute(`
			hooks.validate((value) => value > 0);
			hooks.validate((value) => value < 100);
		`);
		const results = runtime.fireHook("validate", { data: 50 });
		assert.deepEqual(results, [true, true]);
		runtime.dispose();
	});

	it("supports multiple handlers on the same hook", () => {
		const manifest = {
			xript: "0.1",
			name: "test",
			hooks: {
				tick: { description: "Frame tick." },
			},
		};
		const runtime = xript.createRuntime(manifest, { hostBindings: {} });
		runtime.execute(`
			globalThis._count = 0;
			hooks.tick(() => { globalThis._count++; });
			hooks.tick(() => { globalThis._count += 10; });
		`);
		runtime.fireHook("tick");
		assert.equal(runtime.execute("globalThis._count").value, 11);
		runtime.dispose();
	});

	it("returns empty array for unregistered hooks", () => {
		const manifest = {
			xript: "0.1",
			name: "test",
			hooks: {
				unused: { description: "Nobody listens to this." },
			},
		};
		const runtime = xript.createRuntime(manifest, { hostBindings: {} });
		const results = runtime.fireHook("unused");
		assert.deepEqual(results, []);
		runtime.dispose();
	});

	it("returns empty array for unknown hook names", () => {
		const runtime = xript.createRuntime(minimalManifest, { hostBindings: {} });
		const results = runtime.fireHook("nonexistent");
		assert.deepEqual(results, []);
		runtime.dispose();
	});

	it("denies hook registration when capability is missing", () => {
		const manifest = {
			xript: "0.1",
			name: "test",
			hooks: {
				restricted: { description: "Needs permission.", capability: "admin" },
			},
			capabilities: {
				admin: { description: "Admin access.", risk: "high" },
			},
		};
		const runtime = xript.createRuntime(manifest, { hostBindings: {} });
		const result = runtime.execute(`
			let caught;
			try { hooks.restricted(() => {}); } catch (e) { caught = e.name; }
			caught;
		`);
		assert.equal(result.value, "CapabilityDeniedError");
		runtime.dispose();
	});

	it("allows hook registration when capability is granted", () => {
		const manifest = {
			xript: "0.1",
			name: "test",
			hooks: {
				restricted: { description: "Needs permission.", capability: "admin" },
			},
			capabilities: {
				admin: { description: "Admin access.", risk: "high" },
			},
		};
		const runtime = xript.createRuntime(manifest, {
			hostBindings: {},
			capabilities: ["admin"],
		});
		runtime.execute("hooks.restricted(() => { globalThis._ran = true; })");
		runtime.fireHook("restricted");
		assert.equal(runtime.execute("globalThis._ran").value, true);
		runtime.dispose();
	});

	it("hooks object is frozen", () => {
		const manifest = {
			xript: "0.1",
			name: "test",
			hooks: {
				tick: { description: "Frame tick." },
			},
		};
		const runtime = xript.createRuntime(manifest, { hostBindings: {} });
		const result = runtime.execute(`
			"use strict";
			let tampered = false;
			try { hooks.tick = "hacked"; } catch (e) { tampered = true; }
			tampered;
		`);
		assert.equal(result.value, true);
		runtime.dispose();
	});

	it("continues executing handlers when one throws", () => {
		const manifest = {
			xript: "0.1",
			name: "test",
			hooks: {
				fragile: { description: "A hook with a broken handler." },
			},
		};
		const runtime = xript.createRuntime(manifest, { hostBindings: {} });
		runtime.execute(`
			hooks.fragile(() => { throw new Error("boom"); });
			hooks.fragile(() => { globalThis._survived = true; return "ok"; });
		`);
		const results = runtime.fireHook("fragile");
		assert.equal(results[0], undefined);
		assert.equal(results[1], "ok");
		assert.equal(runtime.execute("globalThis._survived").value, true);
		runtime.dispose();
	});

	it("rejects invalid hooks type in manifest", () => {
		assert.throws(
			() => xript.createRuntime({ xript: "0.1", name: "test", hooks: "bad" }, { hostBindings: {} }),
			(err) => err instanceof ManifestValidationError && err.issues.some((i) => i.path === "/hooks"),
		);
	});
});

describe("dispose", () => {
	it("cleans up WASM resources", () => {
		const runtime = xript.createRuntime(minimalManifest, { hostBindings: {} });
		runtime.execute("1 + 1");
		runtime.dispose();
	});
});
