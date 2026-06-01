import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import {
	initXript,
	CancellationToken,
	CancellationError,
	InvokeError,
	resolveExtends,
} from "../dist/index.js";

const minimalManifest = { xript: "0.5", name: "v05-app" };

let xript;

before(async () => {
	xript = await initXript();
});

describe("cancellation", () => {
	it("immediately errors on execute after cancel", () => {
		const token = new CancellationToken();
		const runtime = xript.createRuntime(minimalManifest, { hostBindings: {}, cancellation: token });
		assert.equal(token.cancelled, false);
		token.cancel();
		assert.equal(token.cancelled, true);
		assert.throws(() => runtime.execute("1 + 1"), CancellationError);
		runtime.dispose();
	});

	it("is sticky and idempotent", () => {
		const token = new CancellationToken();
		token.cancel();
		token.cancel();
		assert.equal(token.cancelled, true);
	});

	it("interrupts an in-flight loop with a cancellation error", () => {
		const token = new CancellationToken();
		const runtime = xript.createRuntime(minimalManifest, { hostBindings: {}, cancellation: token });
		token.cancel();
		let caught;
		try {
			runtime.execute("while (true) {}");
		} catch (e) {
			caught = e;
		}
		assert.equal(caught?.name, "CancellationError");
		runtime.dispose();
	});

	it("runs normally when token is not cancelled", () => {
		const token = new CancellationToken();
		const runtime = xript.createRuntime(minimalManifest, { hostBindings: {}, cancellation: token });
		assert.equal(runtime.execute("2 + 3").value, 5);
		runtime.dispose();
	});
});

describe("capability audit", () => {
	const manifest = {
		xript: "0.5",
		name: "audit-app",
		bindings: {
			open: { description: "open something", capability: "fs" },
			ping: { description: "no capability" },
		},
		capabilities: { fs: { description: "filesystem" } },
	};

	it("emits an audit event for an allowed invocation", () => {
		const events = [];
		const runtime = xript.createRuntime(manifest, {
			hostBindings: { open: () => "opened", ping: () => "pong" },
			capabilities: ["fs"],
			audit: (e) => events.push(e),
		});
		runtime.execute("open()");
		runtime.execute("ping()");
		assert.equal(events.length, 2);
		assert.equal(events[0].binding, "open");
		assert.equal(events[0].capability, "fs");
		assert.equal(events[1].binding, "ping");
		assert.equal(events[1].capability, null);
		assert.equal(typeof events[0].at, "number");
		runtime.dispose();
	});

	it("does not emit for denied invocations", () => {
		const events = [];
		const runtime = xript.createRuntime(manifest, {
			hostBindings: { open: () => "opened", ping: () => "pong" },
			capabilities: [],
			audit: (e) => events.push(e),
		});
		runtime.execute("try { open(); } catch (e) {}");
		assert.equal(events.length, 0);
		runtime.dispose();
	});

	it("never breaks execution when the sink throws", () => {
		const runtime = xript.createRuntime(manifest, {
			hostBindings: { open: () => "opened", ping: () => "pong" },
			capabilities: ["fs"],
			audit: () => { throw new Error("sink boom"); },
		});
		assert.equal(runtime.execute("open()").value, "opened");
		runtime.dispose();
	});
});

describe("console severity", () => {
	it("routes six methods to the unified sink", () => {
		const seen = [];
		const runtime = xript.createRuntime(minimalManifest, {
			hostBindings: {},
			console: { onLog: (severity, ...args) => seen.push([severity, args[0]]) },
		});
		runtime.execute("console.trace('t'); console.debug('d'); console.info('i'); console.log('l'); console.warn('w'); console.error('e');");
		assert.deepEqual(seen, [
			["trace", "t"],
			["debug", "d"],
			["info", "i"],
			["info", "l"],
			["warn", "w"],
			["error", "e"],
		]);
		runtime.dispose();
	});

	it("falls back to legacy log/warn/error for new severities", () => {
		const logs = [];
		const runtime = xript.createRuntime(minimalManifest, {
			hostBindings: {},
			console: { log: (m) => logs.push(["log", m]), warn: (m) => logs.push(["warn", m]), error: (m) => logs.push(["error", m]) },
		});
		runtime.execute("console.debug('d'); console.info('i'); console.warn('w');");
		assert.deepEqual(logs, [["log", "d"], ["log", "i"], ["warn", "w"]]);
		runtime.dispose();
	});

	it("prefers a direct per-method handler when set", () => {
		const seen = [];
		const runtime = xript.createRuntime(minimalManifest, {
			hostBindings: {},
			console: { debug: (m) => seen.push(["debug", m]), log: (m) => seen.push(["log", m]) },
		});
		runtime.execute("console.debug('d');");
		assert.deepEqual(seen, [["debug", "d"]]);
		runtime.dispose();
	});
});

describe("sandbox hard caps", () => {
	it("clamps the timeout to the host hard cap", () => {
		const manifest = { xript: "0.5", name: "caps", limits: { timeout_ms: 60000 } };
		const runtime = xript.createRuntime(manifest, {
			hostBindings: {},
			hardLimits: { timeout_ms: 50 },
		});
		const start = Date.now();
		assert.throws(() => runtime.execute("while (true) {}"), (e) => e.name === "ExecutionLimitError");
		assert.ok(Date.now() - start < 5000);
		runtime.dispose();
	});
});

describe("nested namespace bindings", () => {
	it("resolves arbitrary-depth nested namespaces", () => {
		const manifest = {
			xript: "0.5",
			name: "nested",
			bindings: {
				app: {
					description: "root",
					members: {
						brick: {
							description: "brick ns",
							members: {
								list: { description: "list bricks" },
								meta: {
									description: "meta ns",
									members: {
										version: { description: "get version" },
									},
								},
							},
						},
					},
				},
			},
		};
		const runtime = xript.createRuntime(manifest, {
			hostBindings: {
				app: {
					brick: {
						list: () => ["a", "b"],
						meta: { version: () => "1.2.3" },
					},
				},
			},
		});
		assert.deepEqual(runtime.execute("app.brick.list()").value, ["a", "b"]);
		assert.equal(runtime.execute("app.brick.meta.version()").value, "1.2.3");
		runtime.dispose();
	});

	it("deep-freezes nested namespaces", () => {
		const manifest = {
			xript: "0.5",
			name: "frozen",
			bindings: {
				a: { description: "a", members: { b: { description: "b", members: { c: { description: "c" } } } } },
			},
		};
		const runtime = xript.createRuntime(manifest, {
			hostBindings: { a: { b: { c: () => 1 } } },
		});
		assert.equal(runtime.execute("Object.isFrozen(a.b)").value, true);
		runtime.dispose();
	});
});

describe("host-invokable exports", () => {
	const appManifest = { xript: "0.5", name: "host-app", slots: [{ id: "s", accepts: ["text/html"], multiple: true }] };

	function loadExportMod(runtime, exportsDecl, script, caps) {
		const modManifest = {
			xript: "0.5",
			name: "export-mod",
			version: "1.0.0",
			capabilities: caps,
			entry: { script: "main.js", exports: exportsDecl },
		};
		runtime.loadMod(modManifest, { fragmentSources: { "main.js": script } });
	}

	it("invokes a registered export and honors the return value", () => {
		const runtime = xript.createRuntime(appManifest, { hostBindings: {} });
		loadExportMod(
			runtime,
			{ upper: { description: "uppercase" } },
			"xript.exports.register('upper', (s) => s.toUpperCase());",
		);
		assert.equal(runtime.invokeExport("upper", ["hello"]), "HELLO");
		runtime.dispose();
	});

	it("errors on an unregistered export name", () => {
		const runtime = xript.createRuntime(appManifest, { hostBindings: {} });
		assert.throws(() => runtime.invokeExport("missing", []), (e) => e instanceof InvokeError && /not found/.test(e.message));
		runtime.dispose();
	});

	it("surfaces a throwing export as InvokeError", () => {
		const runtime = xript.createRuntime(appManifest, { hostBindings: {} });
		loadExportMod(
			runtime,
			{ boom: { description: "throws" } },
			"xript.exports.register('boom', () => { throw new Error('kaboom'); });",
		);
		assert.throws(() => runtime.invokeExport("boom", []), (e) => e instanceof InvokeError && /kaboom/.test(e.message));
		runtime.dispose();
	});

	it("gates an export behind a declared capability", () => {
		const runtime = xript.createRuntime(appManifest, { hostBindings: {}, capabilities: [] });
		loadExportMod(
			runtime,
			{ secret: { description: "needs grant", capability: "audio" } },
			"xript.exports.register('secret', () => 'ok');",
			["audio"],
		);
		assert.throws(() => runtime.invokeExport("secret", []), (e) => e.name === "CapabilityDeniedError");
		runtime.dispose();
	});

	it("invokes async exports via invokeExportAsync", async () => {
		const runtime = xript.createRuntime(appManifest, { hostBindings: {} });
		loadExportMod(
			runtime,
			{ later: { description: "async" } },
			"xript.exports.register('later', async (n) => n * 2);",
		);
		assert.equal(await runtime.invokeExportAsync("later", [21]), 42);
		runtime.dispose();
	});
});

describe("slot runtime resolver", () => {
	const appManifest = {
		xript: "0.5",
		name: "slot-app",
		slots: [
			{ id: "multi", accepts: ["text/html"], multiple: true },
			{ id: "single", accepts: ["text/html"] },
		],
	};

	function modWith(fragments) {
		return { xript: "0.5", name: `mod-${Math.random().toString(36).slice(2)}`, version: "1.0.0", fragments };
	}

	it("orders contributions by priority desc then id asc", () => {
		const runtime = xript.createRuntime(appManifest, { hostBindings: {} });
		runtime.loadMod(modWith([
			{ id: "beta", slot: "multi", format: "text/html", source: "<p>b</p>", inline: true, priority: 5 },
			{ id: "alpha", slot: "multi", format: "text/html", source: "<p>a</p>", inline: true, priority: 5 },
			{ id: "gamma", slot: "multi", format: "text/html", source: "<p>g</p>", inline: true, priority: 9 },
		]));
		const result = runtime.resolveSlot("multi");
		assert.deepEqual(result.map((c) => c.fragmentId), ["gamma", "alpha", "beta"]);
		runtime.dispose();
	});

	it("returns at most one for single-cardinality slots", () => {
		const runtime = xript.createRuntime(appManifest, { hostBindings: {} });
		runtime.loadMod(modWith([
			{ id: "low", slot: "single", format: "text/html", source: "<p>l</p>", inline: true, priority: 1 },
			{ id: "high", slot: "single", format: "text/html", source: "<p>h</p>", inline: true, priority: 10 },
		]));
		const result = runtime.resolveSlot("single");
		assert.equal(result.length, 1);
		assert.equal(result[0].fragmentId, "high");
		assert.equal(runtime.resolveSlotSingle("single").fragmentId, "high");
		runtime.dispose();
	});

	it("returns empty for an undeclared slot", () => {
		const runtime = xript.createRuntime(appManifest, { hostBindings: {} });
		assert.deepEqual(runtime.resolveSlot("ghost"), []);
		assert.equal(runtime.resolveSlotSingle("ghost"), null);
		runtime.dispose();
	});
});

describe("manifest extends merge", () => {
	const base = {
		xript: "0.5",
		name: "base",
		bindings: { baseFn: { description: "base" } },
		slots: [{ id: "base.slot", accepts: ["text/html"] }],
	};

	const loader = (path) => {
		if (path.endsWith("base.json")) return base;
		throw new Error(`unknown ${path}`);
	};

	it("merges base bindings and appends slots", () => {
		const child = {
			xript: "0.5",
			name: "child",
			extends: "./base.json",
			bindings: { childFn: { description: "child" } },
			slots: [{ id: "child.slot", accepts: ["text/html"] }],
		};
		const merged = resolveExtends(child, "/app", loader);
		assert.ok(merged.bindings.baseFn);
		assert.ok(merged.bindings.childFn);
		assert.equal(merged.name, "child");
		assert.equal(merged.slots.length, 2);
		assert.equal(merged.extends, undefined);
	});

	it("errors on a conflicting binding id", () => {
		const child = {
			xript: "0.5",
			name: "child",
			extends: "./base.json",
			bindings: { baseFn: { description: "override attempt" } },
		};
		assert.throws(() => resolveExtends(child, "/app", loader), /conflicts with extended base/);
	});

	it("detects extends cycles", () => {
		const cyclic = { xript: "0.5", name: "a", extends: "./a.json" };
		const cyclicLoader = () => cyclic;
		assert.throws(() => resolveExtends(cyclic, "/app", cyclicLoader), /circular extends/);
	});
});

describe("mod manifest family field", () => {
	const appManifest = { xript: "0.5", name: "fam-app", slots: [{ id: "s", accepts: ["text/html"], multiple: true }] };

	it("accepts a valid family and round-trips it", () => {
		const runtime = xript.createRuntime(appManifest, { hostBindings: {} });
		const mod = runtime.loadMod({ xript: "0.5", name: "acme-tools", version: "1.0.0", family: "acme" });
		assert.equal(mod.name, "acme-tools");
		runtime.dispose();
	});

	it("rejects an invalid family", () => {
		const runtime = xript.createRuntime(appManifest, { hostBindings: {} });
		assert.throws(
			() => runtime.loadMod({ xript: "0.5", name: "bad", version: "1.0.0", family: "Acme Family" }),
			/family/,
		);
		runtime.dispose();
	});
});
