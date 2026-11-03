import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { initXript, initXriptAsync } from "../dist/index.js";

const manifest = {
	xript: "0.10",
	name: "callback-churn",
	bindings: {
		walk: { description: "Visits every node of a tree, summing what the visitor returns." },
		filter: { description: "Keeps the items the predicate accepts." },
		visit: { description: "Calls functions found inside an options object." },
		reenter: { description: "Calls a function that calls back into bindings." },
		boom: { description: "Calls a function that throws, letting the throw escape." },
		swallow: { description: "Calls a function that throws, and catches it." },
		keep: { description: "Retains a function.", params: [{ name: "fn", type: "function", retain: true }] },
	},
	hooks: { tick: { description: "Runs a churn pass." } },
	events: [{ id: "tock", description: "Runs a churn pass." }],
};

const CHURN = `
	function build(depth) {
		return depth === 0 ? { v: 1 } : { v: depth, kids: [build(depth - 1), build(depth - 1)] };
	}
	function churn(rounds) {
		var tree = build(4);
		var total = 0;
		for (var i = 0; i < rounds; i++) {
			total += walk(tree, function (node) { return node.v; });
			total += filter([1, 2, 3, 4, { n: 5 }], function (item) { return typeof item === "number" && item % 2 === 0; }).length;
			total += visit({ pre: function (n) { return n + 1; }, nested: [function () { return 2; }, { deep: function () { return 3; } }] });
			total += reenter(function () {
				return walk(tree, function (node) { return reenter(function () { return node.v; }); });
			});
			try { boom(function () { throw new Error("inner"); }); } catch (e) { total += 1; }
			total += swallow(function () { throw new Error("caught by the host"); });
		}
		return total;
	}
`;

function hostFor(retained) {
	const walk = (node, visitor) => {
		let sum = visitor(node);
		for (const kid of node.kids ?? []) sum += walk(kid, visitor);
		return sum;
	};
	return {
		walk,
		filter: (items, predicate) => items.filter((item) => predicate(item)),
		visit: (options) => options.pre(1) + options.nested[0]() + options.nested[1].deep(),
		reenter: (fn) => fn(),
		boom: (fn) => fn(),
		swallow: (fn) => {
			try {
				fn();
				return 0;
			} catch {
				return 1;
			}
		},
		keep: (fn) => {
			retained.push(fn.retain());
			return retained.length;
		},
	};
}

const ROUNDS = 25;

function expectedTotal(rounds) {
	const build = (depth) => (depth === 0 ? { v: 1 } : { v: depth, kids: [build(depth - 1), build(depth - 1)] });
	const sum = (node) => node.v + (node.kids ?? []).reduce((acc, kid) => acc + sum(kid), 0);
	const tree = build(4);
	return rounds * (sum(tree) + 2 + 7 + sum(tree) + 1 + 1);
}

function churnThenDispose(runtime, retained) {
	assert.equal(runtime.execute(`${CHURN}; churn(${ROUNDS})`).value, expectedTotal(ROUNDS));
	runtime.execute("keep(function () { return 'kept'; }); keep(function () { return 'released'; });");
	assert.equal(retained[1].call(), "released");
	retained[1].release();
	assert.equal(retained[0].call(), "kept");
	assert.doesNotThrow(() => runtime.dispose());
}

const churnMod = {
	xript: "0.10",
	name: "churner",
	version: "1.0.0",
	entry: {
		format: "script",
		script: "main.js",
		exports: { run: { description: "Runs churn passes over a host-supplied count." } },
	},
};

const churnModSource = `${CHURN}
	xript.exports.register("run", function (options) { return churn(options.rounds); });
	hooks.tick(function (rounds) { return churn(rounds); });
	events.on("tock", function (rounds) { return churn(rounds); });
`;

for (const [variant, init] of [["sync", initXript], ["async", initXriptAsync]]) {
	describe(`script callbacks leave no handle behind at dispose (${variant} sandbox)`, () => {
		it("survives dispose after callbacks at top level, nested, re-entrant, throwing, and retained", async () => {
			const retained = [];
			const runtime = await (await init()).createRuntime(manifest, { hostBindings: hostFor(retained) });
			churnThenDispose(runtime, retained);
		});

		it("survives dispose after a mod's exports, hooks, and events drive the same callbacks", async () => {
			const retained = [];
			const runtime = await (await init()).createRuntime(manifest, { hostBindings: hostFor(retained) });
			runtime.loadMod(churnMod, { fragmentSources: { "main.js": churnModSource } });
			for (let i = 0; i < 5; i++) {
				assert.equal(runtime.invokeExport("run", [{ rounds: 3, extra: [NaN, undefined, { deep: -0 }] }]), expectedTotal(3));
				assert.deepEqual(runtime.fireHook("tick", { data: 2 }), [expectedTotal(2)]);
				assert.deepEqual(runtime.emit("tock", 2), [expectedTotal(2)]);
			}
			if (variant === "async") assert.equal(await runtime.invokeExportAsync("run", [{ rounds: 2 }]), expectedTotal(2));
			runtime.execute("hooks.tick(async function () { return walk({ v: 1 }, function (n) { return n.v; }); }); events.on('tock', async function () { return 1; });");
			assert.deepEqual(runtime.fireHook("tick", { data: 1 }), [expectedTotal(1), {}]);
			assert.deepEqual(runtime.emit("tock", 1), [expectedTotal(1), {}]);
			assert.deepEqual(runtime.execute("Promise.resolve(1)").value, {});
			runtime.execute("keep(function () { return 'kept'; }); keep(function () { return 'released'; });");
			retained[1].release();
			assert.equal(retained[0].call(), "kept");
			assert.doesNotThrow(() => runtime.dispose());
		});
	});
}
