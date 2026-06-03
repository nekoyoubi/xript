import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, "fixtures");

const { validateManifestFile, resolveSchema } = await import("../dist/index.js");

const overlayPath = resolve(fixturesDir, "domain-overlay.schema.json");

async function loadOverlay() {
	return JSON.parse(await readFile(overlayPath, "utf-8"));
}

function fetchThatServes(schema, calls = []) {
	return async (url) => {
		calls.push(url);
		return {
			ok: true,
			status: 200,
			json: async () => schema,
		};
	};
}

function fetchThatFails(calls = []) {
	return async (url) => {
		calls.push(url);
		throw new Error("network disabled in test");
	};
}

async function freshCacheDir() {
	return await mkdtemp(join(tmpdir(), "xript-schema-test-"));
}

describe("$schema resolution — known id", () => {
	it("resolves the core URI to bundled core", async () => {
		const result = await validateManifestFile(
			resolve(fixturesDir, "manifest-known-schema.json"),
		);
		assert.equal(result.valid, true);
		assert.equal(
			(result.warnings ?? []).some((w) => w.keyword === "schema-fallback"),
			false,
		);
	});

	it("reports bundled-known as the resolution source", async () => {
		const manifest = { $schema: "https://xript.dev/schema/manifest/v0.3.json", xript: "0.3", name: "x" };
		const resolved = await resolveSchema(manifest, fixturesDir, "manifest.schema.json");
		assert.equal(resolved.source, "bundled-known");
	});
});

describe("$schema resolution — local path", () => {
	const overlayUri = pathToFileURL(overlayPath).href;

	it("resolves a relative local-path $schema relative to the manifest", async () => {
		const manifest = { $schema: "./domain-overlay.schema.json", xript: "0.3", name: "x", domainBadge: "g" };
		const resolved = await resolveSchema(manifest, fixturesDir, "manifest.schema.json");
		assert.equal(resolved.source, "local");
		assert.equal(resolved.schema.$id, "https://example.test/schema/domain-overlay.json");
	});

	it("validates against a local overlay schema (extra top-level prop allowed)", async () => {
		const dir = await freshCacheDir();
		const file = join(dir, "app.json");
		await writeFile(file, JSON.stringify({ $schema: overlayUri, xript: "0.3", name: "x", domainBadge: "gold" }));
		const result = await validateManifestFile(file);
		assert.equal(result.valid, true, JSON.stringify(result.errors));
	});

	it("rejects a manifest that violates the overlay's added requirement", async () => {
		const dir = await freshCacheDir();
		const file = join(dir, "app.json");
		await writeFile(file, JSON.stringify({ $schema: overlayUri, xript: "0.3", name: "x" }));
		const result = await validateManifestFile(file);
		assert.equal(result.valid, false);
		assert.ok(result.errors.some((e) => e.keyword === "required"));
	});

	it("falls back to bundled core with a warning when the local schema is missing", async () => {
		const manifest = { $schema: "./does-not-exist.schema.json", xript: "0.3", name: "x" };
		const resolved = await resolveSchema(manifest, fixturesDir, "manifest.schema.json");
		assert.equal(resolved.source, "bundled-fallback");
		assert.match(resolved.warning, /could not read local schema/);
	});
});

describe("$schema resolution — remote (no network)", () => {
	it("fetches and caches a remote schema via injected fetch", async () => {
		const overlay = await loadOverlay();
		const cacheDir = await freshCacheDir();
		const calls = [];
		const manifest = JSON.parse(
			await readFile(resolve(fixturesDir, "manifest-remote-schema.json"), "utf-8"),
		);

		const resolved = await resolveSchema(manifest, fixturesDir, "manifest.schema.json", {
			fetchImpl: fetchThatServes(overlay, calls),
			cacheDir,
		});
		assert.equal(resolved.source, "remote-fetched");
		assert.equal(calls.length, 1);
		assert.equal(calls[0], "https://example.test/schema/remote-overlay.json");
	});

	it("serves a cache hit without fetching", async () => {
		const overlay = await loadOverlay();
		const cacheDir = await freshCacheDir();
		const url = "https://example.test/schema/remote-overlay.json";
		const manifest = { $schema: url, xript: "0.3", name: "x", domainBadge: "g" };

		const calls = [];
		await resolveSchema(manifest, fixturesDir, "manifest.schema.json", {
			fetchImpl: fetchThatServes(overlay, calls),
			cacheDir,
		});
		assert.equal(calls.length, 1);

		const secondCalls = [];
		const second = await resolveSchema(manifest, fixturesDir, "manifest.schema.json", {
			fetchImpl: fetchThatServes(overlay, secondCalls),
			cacheDir,
		});
		assert.equal(second.source, "remote-cached");
		assert.equal(secondCalls.length, 0);
	});

	it("falls back to bundled core with a warning on fetch failure", async () => {
		const cacheDir = await freshCacheDir();
		const manifest = { $schema: "https://example.test/schema/unreachable.json", xript: "0.3", name: "x" };
		const resolved = await resolveSchema(manifest, fixturesDir, "manifest.schema.json", {
			fetchImpl: fetchThatFails(),
			cacheDir,
		});
		assert.equal(resolved.source, "bundled-fallback");
		assert.match(resolved.warning, /could not fetch remote schema/);
	});

	it("falls back to bundled core when no fetch transport is available", async () => {
		const cacheDir = await freshCacheDir();
		const manifest = { $schema: "https://example.test/schema/uncached.json", xript: "0.3", name: "x" };
		const resolved = await resolveSchema(manifest, fixturesDir, "manifest.schema.json", {
			fetchImpl: undefined,
			cacheDir,
			disableRemote: false,
			allowRemote: ["https://example.test/schema/uncached.json"],
		});
		assert.equal(resolved.source, "bundled-fallback");
	});
});

describe("$schema resolution — restrictions (open by default)", () => {
	it("disableRemote falls back to bundled core with a warning, never hard-fails", async () => {
		const overlay = await loadOverlay();
		const cacheDir = await freshCacheDir();
		const calls = [];
		const manifest = { $schema: "https://example.test/schema/blocked.json", xript: "0.3", name: "x" };
		const resolved = await resolveSchema(manifest, fixturesDir, "manifest.schema.json", {
			fetchImpl: fetchThatServes(overlay, calls),
			cacheDir,
			disableRemote: true,
		});
		assert.equal(resolved.source, "bundled-fallback");
		assert.equal(calls.length, 0);
		assert.match(resolved.warning, /not permitted/);
	});

	it("allowRemote blocks URLs outside the allowlist", async () => {
		const overlay = await loadOverlay();
		const cacheDir = await freshCacheDir();
		const calls = [];
		const manifest = { $schema: "https://example.test/schema/elsewhere.json", xript: "0.3", name: "x" };
		const resolved = await resolveSchema(manifest, fixturesDir, "manifest.schema.json", {
			fetchImpl: fetchThatServes(overlay, calls),
			cacheDir,
			allowRemote: ["https://example.test/schema/allowed.json"],
		});
		assert.equal(resolved.source, "bundled-fallback");
		assert.equal(calls.length, 0);
	});

	it("allowRemote permits URLs on the allowlist", async () => {
		const overlay = await loadOverlay();
		const cacheDir = await freshCacheDir();
		const calls = [];
		const url = "https://example.test/schema/allowed.json";
		const manifest = { $schema: url, xript: "0.3", name: "x", domainBadge: "g" };
		const resolved = await resolveSchema(manifest, fixturesDir, "manifest.schema.json", {
			fetchImpl: fetchThatServes(overlay, calls),
			cacheDir,
			allowRemote: [url],
		});
		assert.equal(resolved.source, "remote-fetched");
		assert.equal(calls.length, 1);
	});
});

describe("$schema resolution — no declared schema preserves existing behavior", () => {
	it("validates a manifest with no $schema against bundled core", async () => {
		const result = await validateManifestFile(resolve(fixturesDir, "valid-minimal.json"));
		assert.equal(result.valid, true);
		assert.equal(
			(result.warnings ?? []).some((w) => w.keyword === "schema-fallback"),
			false,
		);
	});

	it("resolveSchema reports bundled-fallback with no warning when $schema is absent", async () => {
		const resolved = await resolveSchema({ xript: "0.3", name: "x" }, fixturesDir, "manifest.schema.json");
		assert.equal(resolved.source, "bundled-fallback");
		assert.equal(resolved.warning, undefined);
	});
});
