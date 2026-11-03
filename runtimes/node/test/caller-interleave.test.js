import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRuntime, withCaller } from "../dist/index.js";

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
xript.exports.register('go', async function (tag, ms) {
	who(tag + ':before');
	await wait(ms);
	events.on('note.posted', function () { return tag; });
	who(tag + ':after');
	await wait(ms);
	return who(tag + ':end');
});
xript.exports.register('dangle', async function (tag, ms) {
	wait(ms).then(function () { who(tag + ':late'); });
	return who(tag + ':returned');
});
`;

function setup() {
	const seen = [];
	const runtime = createRuntime(manifest, {
		hostBindings: {
			wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
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
				entry: { script: "mod.js", exports: { go: { description: "go" }, dangle: { description: "dangle" } } },
			},
			{ fragmentSources: { "mod.js": MOD_SOURCE } },
		);
	}
	return { runtime, seen };
}

describe("caller identity across interleaved async calls (node)", () => {
	it("credits each resumed call to its own mod, whichever started last", async () => {
		const { runtime, seen } = setup();
		const a = runtime.invokeModExportAsync("mod-a", "go", ["a", 10]);
		const b = runtime.invokeModExportAsync("mod-b", "go", ["b", 40]);
		assert.deepEqual(await Promise.all([a, b]), ["mod-a", "mod-b"]);
		for (const entry of seen) {
			const [tag, mod] = entry.split("=");
			assert.equal(mod, `mod-${tag[0]}`, `${entry} was credited to the wrong mod`);
		}
		assert.equal(seen.length, 6);
		runtime.dispose();
	});

	it("attributes subscriptions made after an await to the subscribing mod", async () => {
		const { runtime } = setup();
		await Promise.all([
			runtime.invokeModExportAsync("mod-a", "go", ["a", 10]),
			runtime.invokeModExportAsync("mod-b", "go", ["b", 30]),
		]);
		const owners = (await runtime.execute("events.subscribers('note.posted').owners")).value;
		assert.deepEqual(owners, [{ owner: "mod-a", count: 1 }, { owner: "mod-b", count: 1 }]);
		runtime.dispose();
	});

	it("leaves a continuation that outlives its call owned by no mod", async () => {
		const { runtime, seen } = setup();
		assert.equal(await runtime.invokeModExportAsync("mod-a", "dangle", ["a", 10]), "mod-a");
		await new Promise((resolve) => setTimeout(resolve, 40));
		assert.deepEqual(seen, ["a:returned=mod-a", "a:late=null"]);
		runtime.dispose();
	});
});
