import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { initXript, initXriptAsync } from "../dist/index.js";

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

/**
 * Enough bytecode for the engine to consult its interrupt check many times, without spending
 * any time the test depends on: the budget test below moves the host's clock itself.
 */
const polls = "for (var i = 0; i < 200000; i++) {}";

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

for (const [label, make] of [
	["sync", () => initXript()],
	["async", () => initXriptAsync()],
]) {
	describe(`hook and event handler budgets (js, ${label})`, async () => {
		const factory = await make();

		it("runs handlers without a budget by default and raises unbudgeted-handler once", async () => {
			const seen = [];
			const runtime = await factory.createRuntime(manifest, { hostBindings: {}, onDeprecation: (n) => seen.push(n) });
			runtime.execute(`events.on('ping', function () { ${spin(80)} return 'done'; }); hooks.tick(function () { ${spin(80)} return 'ticked'; });`);
			assert.deepEqual(runtime.emit("ping"), ["done"]);
			assert.deepEqual(runtime.fireHook("tick"), ["ticked"]);
			assert.deepEqual(seen.map((n) => n.code), ["unbudgeted-handler"]);
			assert.equal(typeof seen[0].message, "string");
			assert.match(seen[0].replacement, /budgetHandlers/);
			runtime.dispose();
		});

		it("raises nothing for handlers that finish inside the script timeout", async () => {
			const seen = [];
			const runtime = await factory.createRuntime(manifest, { hostBindings: {}, onDeprecation: (n) => seen.push(n) });
			runtime.execute("events.on('ping', function () { return 1; }); hooks.tick(function () { return 2; });");
			runtime.emit("ping");
			runtime.fireHook("tick");
			assert.deepEqual(seen, []);
			runtime.dispose();
		});

		it("stops an over-budget fire with the execution-limit error when budgets are on", async () => {
			const seen = [];
			const runtime = await factory.createRuntime(manifest, {
				hostBindings: {},
				budgetHandlers: true,
				onDeprecation: (n) => seen.push(n),
			});
			runtime.execute(`events.on('ping', function () { ${spin(400)} }); hooks.tick(function () { ${spin(400)} });`);
			assert.throws(() => runtime.emit("ping"), (e) => e.name === "ExecutionLimitError");
			assert.throws(() => runtime.fireHook("tick"), (e) => e.name === "ExecutionLimitError");
			assert.equal(runtime.execute("'still usable'").value, "still usable");
			assert.deepEqual(seen, []);
			runtime.dispose();
		});

		it("gives every fire a fresh budget and honours a hook's own limits", async () => {
			const realNow = Date.now;
			let now = realNow();
			Date.now = () => now;
			try {
				const clocked = { ...manifest, bindings: { advance: { description: "Moves the host clock forward." } } };
				const runtime = await factory.createRuntime(clocked, {
					hostBindings: { advance: (ms) => void (now += ms) },
					budgetHandlers: true,
				});
				runtime.execute(
					`events.on('ping', function () { advance(25); ${polls} return 'ok'; }); ` +
						`hooks.save(function () { advance(120); ${polls} return 'saved'; }); ` +
						`hooks.tick(function () { advance(60); ${polls} return 'late'; });`,
				);
				assert.deepEqual(runtime.emit("ping"), ["ok"]);
				assert.deepEqual(runtime.emit("ping"), ["ok"]);
				assert.deepEqual(runtime.fireHook("save"), ["saved"]);
				assert.throws(() => runtime.fireHook("tick"), (e) => e.name === "ExecutionLimitError");
				runtime.dispose();
			} finally {
				Date.now = realNow;
			}
		});

		it("honours an event slot's own limits for its handlers and its fills", async () => {
			const runtime = await factory.createRuntime(slotManifest, { hostBindings: {}, budgetHandlers: true });
			runtime.loadMod(filler, { fragmentSources: { "mod.js": `xript.exports.register('onWide', function () { ${spin(120)} return 'filled'; });` } });
			runtime.execute(`hooks.wide(function () { ${spin(120)} return 'wide'; }); hooks.tight(function () { ${spin(400)} });`);
			assert.deepEqual(runtime.fireHook("wide"), ["wide", "filled"]);
			assert.throws(() => runtime.fireHook("tight"), (e) => e.name === "ExecutionLimitError");
			runtime.dispose();
		});
	});
}
