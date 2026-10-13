import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { validateManifest, validateModManifest } = await import("../dist/index.js");

const CORE_ID = "https://xript.dev/schema/manifest/v0.6.json";
const LEGACY_CORE_ID = "https://xript.dev/schema/manifest/v0.3.json";
const MOD_CORE_ID = "https://xript.dev/schema/mod-manifest/v0.9.json";

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

	it("warns on an unknown top-level key under the overlay without failing", async () => {
		const manifest = { xript: "0.3", name: "x", bogusKey: "nope" };
		const result = await validateManifest(manifest, overlay);
		assert.equal(result.valid, true, JSON.stringify(result.errors));
		assert.ok((result.warnings ?? []).some((w) => w.keyword === "unknown-key"));
	});

	it("warns on an unknown top-level key on a bare manifest by default", async () => {
		const manifest = { xript: "0.3", name: "x", bogusKey: "nope" };
		const result = await validateManifest(manifest);
		assert.equal(result.valid, true, JSON.stringify(result.errors));
		assert.ok((result.warnings ?? []).some((w) => w.keyword === "unknown-key"));
	});

	it("validates an overlay that still $refs the legacy core id", async () => {
		const manifest = { xript: "0.6", name: "x", domainBadge: "gold" };
		const result = await validateManifest(manifest, legacyOverlay);
		assert.equal(result.valid, true, JSON.stringify(result.errors));
	});
});

const modOverlay = {
	$schema: "https://json-schema.org/draft/2020-12/schema",
	allOf: [
		{ $ref: MOD_CORE_ID },
		{ type: "object", properties: { "x-domain": { type: "object" } } },
	],
	unevaluatedProperties: false,
};

describe("mod-manifest overlay composition — symmetric with the host schema", () => {
	const base = { xript: "0.8", name: "x", version: "1.0.0" };

	it("validates a mod manifest carrying the overlay's added property", async () => {
		const result = await validateModManifest({ ...base, "x-domain": { theme: "dusk" } }, modOverlay);
		assert.equal(result.valid, true, JSON.stringify(result.errors));
	});

	it("warns on an unknown top-level key under the overlay without failing", async () => {
		const result = await validateModManifest({ ...base, "x-domain": {}, bogusKey: "nope" }, modOverlay);
		assert.equal(result.valid, true, JSON.stringify(result.errors));
		assert.ok((result.warnings ?? []).some((w) => w.keyword === "unknown-key"));
	});

	it("warns on an unknown top-level key on a bare mod manifest by default", async () => {
		const result = await validateModManifest({ ...base, bogusKey: "nope" });
		assert.equal(result.valid, true, JSON.stringify(result.errors));
		assert.ok((result.warnings ?? []).some((w) => w.keyword === "unknown-key"));
	});

	it("validates a clean bare mod manifest", async () => {
		const result = await validateModManifest(base);
		assert.equal(result.valid, true, JSON.stringify(result.errors));
	});
});
