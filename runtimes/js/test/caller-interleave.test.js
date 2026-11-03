import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { initXriptAsync, withCaller } from "../dist/index.js";

const manifest = {
	xript: "0.10",
	name: "interleave-host",
	bindings: {
		wait: { description: "Settles after a delay.", async: true, params: [{ name: "ms", type: "number" }] },
		who: { description: "Records the calling mod.", params: [{ name: "tag", type: "string" }] },
	},
	events: [{ id: "note.posted", description: "A note was posted." }],
};

const MOD_SOURCE = `
xript.exports.register('suspend', async function (tag, ms) {
	who(tag + ':before');
	var waited = await wait(ms);
	events.on('note.posted', function () { return tag; });
	who(tag + ':after');
	return waited;
});
xript.exports.register('settle', async function (tag) {
	who(tag + ':before');
	await null;
	events.on('note.posted', function () { return tag; });
	who(tag + ':after');
	await null;
	return who(tag + ':end');
});
`;

let xript;

before(async () => {
	xript = await initXriptAsync();
});

async function setup(wait) {
	const seen = [];
	const runtime = await xript.createRuntime(manifest, {
		hostBindings: {
			wait,
			who: withCaller((info, tag) => {
				seen.push(`${tag}=${info.modId}`);
				return info.modId;
			}),
		},
	});
	for (const name of ["mod-a", "mod-b"]) {
		runtime.loadMod(
			{
				xript: "0.10",
				name,
				version: "1.0.0",
				entry: { script: "mod.js", exports: { suspend: { description: "suspend" }, settle: { description: "settle" } } },
			},
			{ fragmentSources: { "mod.js": MOD_SOURCE } },
		);
	}
	return { runtime, seen };
}

function assertOwnMods(seen) {
	for (const entry of seen) {
		const [tag, mod] = entry.split("=");
		assert.equal(mod, `mod-${tag[0]}`, `${entry} was credited to the wrong mod`);
	}
}

describe("caller identity across interleaved async calls (js, async sandbox)", () => {
	it("returns what an export awaiting an async binding resolves to", async () => {
		const { runtime, seen } = await setup((ms) => new Promise((resolve) => setTimeout(() => resolve(ms), ms)));
		assert.equal(await runtime.invokeModExportAsync("mod-a", "suspend", ["a", 5]), 5);
		assert.deepEqual(seen, ["a:before=mod-a", "a:after=mod-a"]);
		runtime.dispose();
	});

	it("credits a call resumed while another is in flight to its own mod", async () => {
		const { runtime, seen } = await setup((ms) => new Promise((resolve) => setTimeout(() => resolve(ms), ms)));
		const a = runtime.invokeModExportAsync("mod-a", "suspend", ["a", 15]);
		const b = runtime.invokeModExportAsync("mod-b", "settle", ["b"]);
		assert.deepEqual(await Promise.all([a, b]), [15, "mod-b"]);
		assertOwnMods(seen);
		assert.equal(seen.length, 5);
		runtime.dispose();
	});

	it("credits a resumption that lands between another call's steps to its own mod", async () => {
		const { runtime, seen } = await setup(async (ms) => ms);
		const a = runtime.invokeModExportAsync("mod-a", "suspend", ["a", 1]);
		const b = runtime.invokeModExportAsync("mod-b", "settle", ["b"]);
		assert.deepEqual(await Promise.all([a, b]), [1, "mod-b"]);
		assertOwnMods(seen);
		runtime.dispose();
	});

	it("attributes subscriptions made after an await to the subscribing mod", async () => {
		const { runtime } = await setup(async (ms) => ms);
		await Promise.all([
			runtime.invokeModExportAsync("mod-a", "suspend", ["a", 1]),
			runtime.invokeModExportAsync("mod-b", "settle", ["b"]),
		]);
		const owners = (await runtime.executeAsync("return events.subscribers('note.posted').owners;")).value;
		assert.deepEqual(owners, [{ owner: "mod-a", count: 1 }, { owner: "mod-b", count: 1 }]);
		runtime.dispose();
	});

	it("refuses a second suspension with a binding error naming the limit", async () => {
		const { runtime, seen } = await setup((ms) => new Promise((resolve) => setTimeout(() => resolve(ms), ms)));
		const first = runtime.invokeModExportAsync("mod-a", "suspend", ["a", 20]);
		const second = runtime.executeAsync(
			"try { await wait(1); return 'suspended'; } catch (e) { return e.name + ': ' + e.message; }",
		);
		const [a, b] = await Promise.all([first, second]);
		assert.equal(a, 20);
		assert.match(b.value, /^BindingError: wait\(\): cannot suspend while another call on this runtime is suspended/);
		assert.match(b.value, /suspends one call at a time/);
		assert.deepEqual(seen, ["a:before=mod-a", "a:after=mod-a"]);
		assert.equal(await runtime.invokeModExportAsync("mod-b", "suspend", ["b", 1]), 1);
		runtime.dispose();
	});
});
