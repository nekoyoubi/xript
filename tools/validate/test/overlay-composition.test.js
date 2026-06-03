import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { validateManifest } = await import("../dist/index.js");

const CORE_ID = "https://xript.dev/schema/manifest/v0.6.json";
const LEGACY_CORE_ID = "https://xript.dev/schema/manifest/v0.3.json";

const overlay = {
	$schema: "https://json-schema.org/draft/2020-12/schema",
	allOf: [
		{ $ref: CORE_ID },
		{ type: "object", properties: { domainBadge: { type: "string" } } },
	],
	unevaluatedProperties: false,
};

const legacyOverlay = {
	$schema: "https://json-schema.org/draft/2020-12/schema",
	allOf: [
		{ $ref: LEGACY_CORE_ID },
		{ type: "object", properties: { domainBadge: { type: "string" } } },
	],
	unevaluatedProperties: false,
};

describe("overlay composition — allOf + $ref to core", () => {
	it("validates a manifest carrying the overlay's added property", async () => {
		const manifest = { xript: "0.3", name: "x", domainBadge: "gold" };
		const result = await validateManifest(manifest, overlay);
		assert.equal(result.valid, true, JSON.stringify(result.errors));
	});

	it("rejects a manifest with an unknown top-level key under the overlay", async () => {
		const manifest = { xript: "0.3", name: "x", bogusKey: "nope" };
		const result = await validateManifest(manifest, overlay);
		assert.equal(result.valid, false);
		assert.ok(result.errors.some((e) => e.keyword === "unevaluatedProperties"));
	});

	it("rejects an unknown top-level key on a bare manifest by default", async () => {
		const manifest = { xript: "0.3", name: "x", bogusKey: "nope" };
		const result = await validateManifest(manifest);
		assert.equal(result.valid, false);
		assert.ok(result.errors.some((e) => e.keyword === "unevaluatedProperties"));
	});

	it("validates an overlay that still $refs the legacy core id", async () => {
		const manifest = { xript: "0.6", name: "x", domainBadge: "gold" };
		const result = await validateManifest(manifest, legacyOverlay);
		assert.equal(result.valid, true, JSON.stringify(result.errors));
	});
});
