import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateTypes } from "../dist/index.js";

const manifest = {
	xript: "0.8",
	name: "demo-mod",
	version: "1.0.0",
	types: {
		Effect: { description: "A status effect", fields: { id: { type: "string" } } },
	},
	fills: {
		"header.status": [{
			id: "status-line",
			format: "text/html",
			source: "fragments/status.html",
			interpolate: true,
			bindings: [
				{ name: "hp", path: "player.health.val", type: "int" },
				{ name: "maxHp", path: "player.health.max", type: "int" },
				{ name: "name", path: "player.name", type: "string" },
				{ name: "effect", path: "player.effect", type: "Effect" },
				{ name: "untyped", path: "player.misc" },
			],
		}],
	},
};

describe("typegen: per-fill binding surfaces", () => {
	const ambient = generateTypes(manifest, { ambient: true });

	it("emits a namespace of binding interfaces", () => {
		assert.match(ambient, /declare namespace XriptFragments \{/);
		assert.match(ambient, /interface StatusLineBindings \{/);
	});

	it("maps primitive binding types", () => {
		assert.match(ambient, /hp: number;/);
		assert.match(ambient, /name: string;/);
	});

	it("keeps a host-declared type name intact", () => {
		assert.match(ambient, /effect: Effect;/);
	});

	it("falls back to unknown rather than guessing from the path", () => {
		assert.match(ambient, /untyped: unknown;/);
	});

	it("emits the keyof alias an editor completes against", () => {
		assert.match(ambient, /type StatusLineBinding = keyof StatusLineBindings;/);
	});

	it("notes when a fill parses interpolation sites", () => {
		assert.match(ambient, /parses `\{\{ expression \}\}` sites/);
	});

	it("emits the same surface in non-ambient mode", () => {
		assert.match(generateTypes(manifest), /interface StatusLineBindings \{/);
	});

	it("emits nothing for a fill with no bindings", () => {
		const bare = generateTypes(
			{ xript: "0.8", name: "m", fills: { s: [{ id: "f", format: "text/html", source: "a.html" }] } },
			{ ambient: true },
		);
		assert.equal(bare.includes("XriptFragments"), false);
	});
});
