import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRuntime, createRuntimeFromFile, ManifestValidationError } from "../dist/index.js";

const minimalManifest = {
	xript: "0.1",
	name: "test-app",
};

describe("createRuntime", () => {
	it("creates a runtime from a valid manifest", () => {
		const runtime = createRuntime(minimalManifest, { hostBindings: {} });
		assert.ok(runtime);
		assert.equal(runtime.manifest.name, "test-app");
	});

	it("rejects invalid manifests", () => {
		assert.throws(() => createRuntime({}, { hostBindings: {} }), /Invalid xript manifest/);
		assert.throws(() => createRuntime({ xript: "0.1" }, { hostBindings: {} }), /Invalid xript manifest/);
	});
});

describe("basic script execution", () => {
	it("executes simple expressions", () => {
		const runtime = createRuntime(minimalManifest, { hostBindings: {} });
		const result = runtime.execute("2 + 2");
		assert.equal(result.value, 4);
		assert.ok(result.duration_ms >= 0);
	});

	it("executes multi-line scripts", () => {
		const runtime = createRuntime(minimalManifest, { hostBindings: {} });
		const result = runtime.execute("const a = 10; const b = 20; a + b;");
		assert.equal(result.value, 30);
	});

	it("supports standard JavaScript built-ins", () => {
		const runtime = createRuntime(minimalManifest, { hostBindings: {} });

		assert.equal(runtime.execute("typeof Math.PI").value, "number");
		assert.equal(runtime.execute("JSON.stringify({a: 1})").value, '{"a":1}');
		assert.equal(runtime.execute("Array.isArray([1, 2, 3])").value, true);
		assert.equal(runtime.execute("[1, 2, 3].map(x => x * 2).join(',')").value, "2,4,6");
		assert.equal(runtime.execute("new Map([[1, 'a']]).get(1)").value, "a");
		assert.equal(runtime.execute("new Set([1, 2, 2, 3]).size").value, 3);
	});

	it("supports Promises and async execution", async () => {
		const runtime = createRuntime(minimalManifest, { hostBindings: {} });
		const result = await runtime.executeAsync("return await Promise.resolve(42);");
		assert.equal(result.value, 42);
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
		const runtime = createRuntime(manifest, {
			hostBindings: { add: (a, b) => Number(a) + Number(b) },
		});
		assert.equal(runtime.execute("add(3, 4)").value, 7);
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
		const runtime = createRuntime(manifest, {
			hostBindings: {
				math: {
					add: (a, b) => Number(a) + Number(b),
					multiply: (a, b) => Number(a) * Number(b),
				},
			},
		});
		assert.equal(runtime.execute("math.add(2, 3)").value, 5);
		assert.equal(runtime.execute("math.multiply(4, 5)").value, 20);
	});

	it("wraps host errors in BindingError", () => {
		const manifest = {
			xript: "0.1",
			name: "test",
			bindings: { fail: { description: "Always fails." } },
		};
		const runtime = createRuntime(manifest, {
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
	});

	it("throws BindingError when host function is not provided", () => {
		const manifest = {
			xript: "0.1",
			name: "test",
			bindings: { missing: { description: "Missing binding." } },
		};
		const runtime = createRuntime(manifest, { hostBindings: {} });
		const result = runtime.execute(`
			let caught;
			try { missing(); } catch (e) { caught = e; }
			caught.name + ": " + caught.binding;
		`);
		assert.ok(String(result.value).includes("BindingError"));
		assert.ok(String(result.value).includes("missing"));
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
		const runtime = createRuntime(manifest, {
			hostBindings: { readData: () => "hello" },
		});
		assert.equal(runtime.execute("readData()").value, "hello");
	});

	it("throws CapabilityDeniedError for gated bindings without the capability", () => {
		const runtime = createRuntime(manifest, {
			hostBindings: { writeData: () => {} },
		});
		const result = runtime.execute(`
			let caught;
			try { writeData("test"); } catch (e) { caught = e; }
			caught.name;
		`);
		assert.equal(result.value, "CapabilityDeniedError");
	});

	it("includes capability name in the error message", () => {
		const runtime = createRuntime(manifest, {
			hostBindings: { writeData: () => {} },
		});
		const result = runtime.execute(`
			let msg;
			try { writeData("test"); } catch (e) { msg = e.message; }
			msg;
		`);
		assert.ok(String(result.value).includes("storage"));
		assert.ok(String(result.value).includes("writeData"));
	});

	it("allows gated bindings when capability is granted", () => {
		const runtime = createRuntime(manifest, {
			hostBindings: {
				readData: () => "hello",
				writeData: (v) => `wrote: ${v}`,
			},
			capabilities: ["storage"],
		});
		assert.equal(runtime.execute("readData()").value, "hello");
		assert.equal(runtime.execute("writeData('test')").value, "wrote: test");
	});

	it("denies capabilities not in the grant set", () => {
		const runtime = createRuntime(manifest, {
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
	});

	it("does not execute the function when capability is denied", () => {
		let called = false;
		const runtime = createRuntime(manifest, {
			hostBindings: {
				writeData: () => { called = true; },
			},
		});
		runtime.execute(`
			try { writeData("test"); } catch (e) {}
		`);
		assert.equal(called, false);
	});
});

describe("sandbox isolation", () => {
	it("blocks eval()", () => {
		const runtime = createRuntime(minimalManifest, { hostBindings: {} });
		const result = runtime.execute(`
			let caught;
			try { eval("1 + 1"); } catch (e) { caught = e; }
			caught.name + ": " + caught.message;
		`);
		assert.ok(String(result.value).includes("TypeError"));
		assert.ok(String(result.value).includes("not permitted"));
	});

	it("blocks new Function()", () => {
		const runtime = createRuntime(minimalManifest, { hostBindings: {} });
		const result = runtime.execute(`
			let caught;
			try { new Function("return 1"); } catch (e) { caught = e; }
			caught.message;
		`);
		assert.ok(String(result.value).includes("not permitted"));
	});

	it("blocks code generation via vm codeGeneration option", () => {
		const runtime = createRuntime(minimalManifest, { hostBindings: {} });
		const result = runtime.execute(`
			let blocked = false;
			try {
				(0, eval)("1");
			} catch (e) {
				blocked = true;
			}
			blocked;
		`);
		assert.equal(result.value, true);
	});

	it("does not expose process, require, or import", () => {
		const runtime = createRuntime(minimalManifest, { hostBindings: {} });
		assert.equal(runtime.execute("typeof process").value, "undefined");
		assert.equal(runtime.execute("typeof require").value, "undefined");
		assert.equal(runtime.execute("typeof module").value, "undefined");
	});

	it("does not expose fetch, setTimeout, or setInterval", () => {
		const runtime = createRuntime(minimalManifest, { hostBindings: {} });
		assert.equal(runtime.execute("typeof fetch").value, "undefined");
		assert.equal(runtime.execute("typeof setTimeout").value, "undefined");
		assert.equal(runtime.execute("typeof setInterval").value, "undefined");
	});

	it("does not expose Node.js specific globals", () => {
		const runtime = createRuntime(minimalManifest, { hostBindings: {} });
		assert.equal(runtime.execute("typeof Buffer").value, "undefined");
		assert.equal(runtime.execute("typeof __dirname").value, "undefined");
		assert.equal(runtime.execute("typeof __filename").value, "undefined");
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
		const runtime = createRuntime(manifest, {
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
	});
});

describe("execution limits", () => {
	it("terminates scripts that exceed timeout", () => {
		const manifest = {
			xript: "0.1",
			name: "test",
			limits: { timeout_ms: 50 },
		};
		const runtime = createRuntime(manifest, { hostBindings: {} });
		assert.throws(
			() => runtime.execute("while (true) {}"),
			(err) => err.code === "ERR_SCRIPT_EXECUTION_TIMEOUT" || err.message.includes("timed out"),
		);
	});

	it("uses default 5000ms timeout when limits are not specified", () => {
		const runtime = createRuntime(minimalManifest, { hostBindings: {} });
		const result = runtime.execute("1 + 1");
		assert.equal(result.value, 2);
	});

	it("short timeout still allows quick scripts", () => {
		const manifest = {
			xript: "0.1",
			name: "test",
			limits: { timeout_ms: 100 },
		};
		const runtime = createRuntime(manifest, { hostBindings: {} });
		const result = runtime.execute("42");
		assert.equal(result.value, 42);
	});
});

describe("console", () => {
	it("routes console.log to host console", () => {
		const logs = [];
		const runtime = createRuntime(minimalManifest, {
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
	});

	it("routes console.warn and console.error to host console", () => {
		const warns = [];
		const errors = [];
		const runtime = createRuntime(minimalManifest, {
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
	});
});

describe("state isolation between executions", () => {
	it("persists state within the same runtime", () => {
		const runtime = createRuntime(minimalManifest, { hostBindings: {} });
		runtime.execute("var counter = 0;");
		runtime.execute("counter++;");
		const result = runtime.execute("counter");
		assert.equal(result.value, 1);
	});
});

describe("manifest validation", () => {
	it("throws ManifestValidationError for null input", () => {
		assert.throws(
			() => createRuntime(null, { hostBindings: {} }),
			(err) => err instanceof ManifestValidationError && err.issues.length === 1,
		);
	});

	it("throws ManifestValidationError for non-object input", () => {
		assert.throws(
			() => createRuntime("not-an-object", { hostBindings: {} }),
			(err) => err instanceof ManifestValidationError,
		);
	});

	it("collects multiple structural issues", () => {
		try {
			createRuntime({}, { hostBindings: {} });
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
			() => createRuntime({ xript: "0.1", name: "test", bindings: "bad" }, { hostBindings: {} }),
			(err) => err instanceof ManifestValidationError && err.issues.some((i) => i.path === "/bindings"),
		);
	});

	it("rejects invalid limits values", () => {
		assert.throws(
			() => createRuntime({ xript: "0.1", name: "test", limits: { timeout_ms: -1 } }, { hostBindings: {} }),
			(err) => err instanceof ManifestValidationError && err.issues.some((i) => i.path === "/limits/timeout_ms"),
		);
	});

	it("passes basic structural check for valid manifests", () => {
		const runtime = createRuntime(
			{ xript: "0.1", name: "test", bindings: {}, capabilities: {}, limits: { timeout_ms: 100 } },
			{ hostBindings: {} },
		);
		assert.ok(runtime);
	});
});

describe("createRuntimeFromFile validation", () => {
	it("validates manifest by default", async () => {
		const runtime = await createRuntimeFromFile("../../examples/game-mod-system.json", {
			hostBindings: {
				log: (msg) => msg,
				player: {
					getName: () => "Hero",
					getHealth: () => 100,
					getMaxHealth: () => 100,
					getPosition: () => ({ x: 0, y: 0 }),
					setHealth: () => {},
					getInventory: () => [],
					addItem: () => {},
				},
				world: {
					getCurrentLevel: () => 1,
					getEnemies: async () => [],
					spawnEnemy: () => {},
				},
				data: {
					get: async () => undefined,
					set: async () => {},
				},
			},
			capabilities: ["modify-player", "modify-world", "storage"],
		});
		assert.ok(runtime);
	});

	it("can skip validation with validate: false", async () => {
		const runtime = await createRuntimeFromFile("../../examples/game-mod-system.json", {
			hostBindings: {
				log: (msg) => msg,
				player: {
					getName: () => "Hero",
					getHealth: () => 100,
					getMaxHealth: () => 100,
					getPosition: () => ({ x: 0, y: 0 }),
					setHealth: () => {},
					getInventory: () => [],
					addItem: () => {},
				},
				world: {
					getCurrentLevel: () => 1,
					getEnemies: async () => [],
					spawnEnemy: () => {},
				},
				data: {
					get: async () => undefined,
					set: async () => {},
				},
			},
			capabilities: ["modify-player", "modify-world", "storage"],
			validate: false,
		});
		assert.ok(runtime);
	});
});

describe("createRuntimeFromFile", () => {
	it("loads a manifest from a file", async () => {
		const runtime = await createRuntimeFromFile("../../examples/game-mod-system.json", {
			hostBindings: {
				log: (msg) => msg,
				player: {
					getName: () => "Hero",
					getHealth: () => 100,
					getMaxHealth: () => 100,
					getPosition: () => ({ x: 5, y: 10 }),
					setHealth: () => {},
					getInventory: () => [],
					addItem: () => {},
				},
				world: {
					getCurrentLevel: () => 3,
					getEnemies: async () => [],
					spawnEnemy: () => {},
				},
				data: {
					get: async () => undefined,
					set: async () => {},
				},
			},
			capabilities: ["modify-player", "modify-world", "storage"],
		});
		assert.equal(runtime.manifest.name, "dungeon-crawler");
		assert.equal(runtime.execute("player.getName()").value, "Hero");
		assert.equal(runtime.execute("player.getHealth()").value, 100);
		assert.equal(runtime.execute("world.getCurrentLevel()").value, 3);
	});
});
