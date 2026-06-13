import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRuntime, CapabilityDeniedError } from "../dist/index.js";

describe("events delivery", () => {
	it("delivers an emitted event to a subscribed handler", () => {
		const manifest = {
			xript: "0.7",
			name: "test",
			events: [{ id: "document.saved", description: "Fired after a save.", payload: "string" }],
		};
		const runtime = createRuntime(manifest, { hostBindings: {} });
		runtime.execute(`events.on("document.saved", (path) => { globalThis._saved = path; });`);
		runtime.emit("document.saved", "game.sav");
		assert.equal(runtime.execute("globalThis._saved").value, "game.sav");
	});

	it("spreads an object payload positionally per declared shape", () => {
		const manifest = {
			xript: "0.7",
			name: "test",
			events: [{ id: "selection.changed", description: "Selection changed." }],
		};
		const runtime = createRuntime(manifest, { hostBindings: {} });
		runtime.execute(`events.on("selection.changed", (a, b) => { globalThis._sum = a + b; });`);
		runtime.emit("selection.changed", { a: 3, b: 4 });
		assert.equal(runtime.execute("globalThis._sum").value, 7);
	});

	it("delivers to multiple handlers in registration order and collects results", () => {
		const manifest = {
			xript: "0.7",
			name: "test",
			events: [{ id: "ping", description: "ping" }],
		};
		const runtime = createRuntime(manifest, { hostBindings: {} });
		runtime.execute(`
			events.on("ping", () => 1);
			events.subscribe("ping", () => 2);
		`);
		const results = runtime.emit("ping");
		assert.deepEqual(results, [1, 2]);
	});

	it("swallows per-handler errors to undefined", () => {
		const manifest = {
			xript: "0.7",
			name: "test",
			events: [{ id: "ping", description: "ping" }],
		};
		const runtime = createRuntime(manifest, { hostBindings: {} });
		runtime.execute(`
			events.on("ping", () => { throw new Error("boom"); });
			events.on("ping", () => 42);
		`);
		const results = runtime.emit("ping");
		assert.deepEqual(results, [undefined, 42]);
	});

	it("emit on an undeclared event id returns no results", () => {
		const manifest = { xript: "0.7", name: "test", events: [{ id: "known", description: "x" }] };
		const runtime = createRuntime(manifest, { hostBindings: {} });
		assert.deepEqual(runtime.emit("unknown", {}), []);
	});

	it("subscribing to an undeclared event throws", () => {
		const manifest = { xript: "0.7", name: "test", events: [{ id: "known", description: "x" }] };
		const runtime = createRuntime(manifest, { hostBindings: {} });
		assert.throws(() => runtime.execute(`events.on("nope", () => {});`));
	});

	it("gates subscription on the event's declared capability", () => {
		const manifest = {
			xript: "0.7",
			name: "test",
			capabilities: { "fs.addon": { description: "fs" } },
			events: [{ id: "secret", description: "x", capability: "read:fs.addon" }],
		};
		const denied = createRuntime(manifest, { hostBindings: {}, capabilities: [] });
		assert.throws(() => denied.execute(`events.on("secret", () => {});`));

		const granted = createRuntime(manifest, { hostBindings: {}, capabilities: ["fs.addon"] });
		granted.execute(`events.on("secret", (v) => { globalThis._secret = v; });`);
		granted.emit("secret", "ok");
		assert.equal(granted.execute("globalThis._secret").value, "ok");
	});
});

describe("capability subsumption at runtime gates", () => {
	it("a broad parent grant satisfies a binding require on a child scope", () => {
		const manifest = {
			xript: "0.7",
			name: "test",
			capabilities: { run: { description: "run" } },
			bindings: {
				shell: { description: "run a command", capability: "run.command" },
			},
		};
		const runtime = createRuntime(manifest, {
			hostBindings: { shell: () => "ran" },
			capabilities: ["run"],
		});
		assert.equal(runtime.execute("shell()").value, "ran");
	});

	it("a read grant does not satisfy a write require on a binding", () => {
		const manifest = {
			xript: "0.7",
			name: "test",
			capabilities: { "fs.addon": { description: "fs" } },
			bindings: {
				write: { description: "write a file", capability: "write:fs.addon" },
			},
		};
		const runtime = createRuntime(manifest, {
			hostBindings: { write: () => "wrote" },
			capabilities: ["read:fs.addon"],
		});
		assert.throws(() => runtime.execute("write()"), CapabilityDeniedError);
	});

	it("segment-boundary discipline: a 'run' grant does not satisfy a 'runner' require", () => {
		const manifest = {
			xript: "0.7",
			name: "test",
			capabilities: { run: { description: "run" }, runner: { description: "runner" } },
			bindings: {
				start: { description: "start the runner", capability: "runner" },
			},
		};
		const runtime = createRuntime(manifest, {
			hostBindings: { start: () => "started" },
			capabilities: ["run"],
		});
		assert.throws(() => runtime.execute("start()"), CapabilityDeniedError);
	});
});
