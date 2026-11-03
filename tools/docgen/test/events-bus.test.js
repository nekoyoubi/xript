import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateDocs } from "../dist/index.js";

function index(manifest) {
	return generateDocs(manifest).pages.find((p) => p.slug === "index").content;
}

describe("events bus docs", () => {
	const manifest = {
		xript: "0.10",
		name: "host",
		events: [
			{ id: "stat.changed", description: "Fired after any stat changes.", emit: "mods", addressed: ["stat.<instanceId>.changed"], keys: ["instanceId", "value"] },
			{ id: "cell.<x>.<y>.lit", description: "Fired when one grid cell lights up.", pattern: true },
			{ id: "tick", description: "Fired once per frame." },
		],
	};

	it("names the bus verbs and the capabilities behind ownership", () => {
		const content = index(manifest);
		for (const verb of ["once", "cancel", "off", "emitAsync", "cancelOwned", "claim", "declare", "describe", "subscribers"]) {
			assert.match(content, new RegExp(`\`${verb}\``), verb);
		}
		assert.match(content, /`events\.off`/);
		assert.match(content, /`events\.claim`/);
		assert.match(content, /`events\.declare`/);
	});

	it("documents emit, pattern, addressed, and keys per event", () => {
		const content = index(manifest);
		assert.match(content, /### Event details/);
		assert.match(content, /- `stat\.changed`: mods may emit it with `events\.emit`; emitted alongside its addressed form `stat\.<instanceId>\.changed`; a subscription may `match` on `instanceId`, `value`/);
		assert.match(content, /- `cell\.<x>\.<y>\.lit`: a family shape/);
		assert.ok(!content.includes("- `tick`:"));
	});

	it("leaves out the details block when no event uses the new fields", () => {
		assert.ok(!index({ xript: "0.10", name: "host", events: [{ id: "tick", description: "Fired once per frame." }] }).includes("### Event details"));
	});
});
