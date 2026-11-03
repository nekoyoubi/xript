import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRuntime } from "../dist/index.js";

const manifest = {
	xript: "0.10",
	name: "budget-probe",
	limits: { timeout_ms: 40 },
	hooks: {
		tick: { description: "Fired once per frame." },
		save: { description: "Fired during a save.", limits: { timeout_ms: 1000 } },
	},
	events: [{ id: "ping", description: "Fired when the host pings." }],
};

const spin = (ms) => `var end = Date.now() + ${ms}; while (Date.now() < end) {}`;

const slotManifest = {
	xript: "0.10",
	name: "slot-budget-probe",
	limits: { timeout_ms: 40 },
	slots: [
		{ id: "wide", accepts: ["application/x-xript-hook"], description: "an event slot with room", limits: { timeout_ms: 1000 } },
		{ id: "tight", accepts: ["application/x-xript-hook"], description: "an event slot without", limits: { timeout_ms: 20 } },
	],
};

const filler = {
	xript: "0.10",
	name: "filler",
	version: "1.0.0",
	entry: { script: "mod.js", exports: { onWide: { description: "spins inside the wide slot's budget" } } },
	fills: { wide: [{ handler: "onWide" }] },
};

describe("hook and event handler budgets (node)", () => {
	it("runs handlers without a budget by default and raises unbudgeted-handler once", () => {
		const seen = [];
		const runtime = createRuntime(manifest, { hostBindings: {}, onDeprecation: (n) => seen.push(n) });
		runtime.execute(`events.on('ping', function () { ${spin(80)} return 'done'; }); hooks.tick(function () { ${spin(80)} return 'ticked'; });`);
		assert.deepEqual(runtime.emit("ping"), ["done"]);
		assert.deepEqual(runtime.fireHook("tick"), ["ticked"]);
		assert.deepEqual(seen.map((n) => n.code), ["unbudgeted-handler"]);
		assert.match(seen[0].replacement, /budgetHandlers/);
		runtime.dispose();
	});

	it("raises nothing for handlers that finish inside the script timeout", () => {
		const seen = [];
		const runtime = createRuntime(manifest, { hostBindings: {}, onDeprecation: (n) => seen.push(n) });
		runtime.execute("events.on('ping', function () { return 1; }); hooks.tick(function () { return 2; });");
		runtime.emit("ping");
		runtime.fireHook("tick");
		assert.deepEqual(seen, []);
		runtime.dispose();
	});

	it("stops an over-budget fire with the execution-limit error when budgets are on", () => {
		const seen = [];
		const runtime = createRuntime(manifest, { hostBindings: {}, budgetHandlers: true, onDeprecation: (n) => seen.push(n) });
		runtime.execute(`events.on('ping', function () { ${spin(400)} }); hooks.tick(function () { ${spin(400)} });`);
		assert.throws(() => runtime.emit("ping"), (e) => e.name === "ExecutionLimitError");
		assert.throws(() => runtime.fireHook("tick"), (e) => e.name === "ExecutionLimitError");
		assert.equal(runtime.execute("'still usable'").value, "still usable");
		assert.deepEqual(seen, []);
		runtime.dispose();
	});

	it("gives every fire a fresh budget and honours a hook's own limits", () => {
		const runtime = createRuntime(manifest, { hostBindings: {}, budgetHandlers: true });
		runtime.execute(`events.on('ping', function () { ${spin(25)} return 'ok'; }); hooks.save(function () { ${spin(120)} return 'saved'; });`);
		assert.deepEqual(runtime.emit("ping"), ["ok"]);
		assert.deepEqual(runtime.emit("ping"), ["ok"]);
		assert.deepEqual(runtime.fireHook("save"), ["saved"]);
		runtime.dispose();
	});

	it("still surfaces a fire's own failure, untouched, under a budget", () => {
		const kept = [];
		const runtime = createRuntime(
			{ ...manifest, bindings: { keep: { description: "Keeps a callback.", params: [{ name: "fn", type: "function", retain: true }] } } },
			{ hostBindings: { keep: (fn) => { kept.push(fn.retain()); } }, budgetHandlers: true },
		);
		runtime.execute("keep(function () {}); events.on('ping', function () {});");
		kept[0].release();
		assert.throws(() => runtime.emit("ping", { g: kept[0] }), (e) => e.name === "CallbackError" && e.reason === "released");
		runtime.dispose();
	});

	it("honours an event slot's own limits for its handlers and its fills", () => {
		const runtime = createRuntime(slotManifest, { hostBindings: {}, budgetHandlers: true });
		runtime.loadMod(filler, { fragmentSources: { "mod.js": `xript.exports.register('onWide', function () { ${spin(120)} return 'filled'; });` } });
		runtime.execute(`hooks.wide(function () { ${spin(120)} return 'wide'; }); hooks.tight(function () { ${spin(400)} });`);
		assert.deepEqual(runtime.fireHook("wide"), ["wide", "filled"]);
		assert.throws(() => runtime.fireHook("tight"), (e) => e.name === "ExecutionLimitError");
		runtime.dispose();
	});
});
