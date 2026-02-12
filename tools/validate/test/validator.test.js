import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, "fixtures");

const { validateManifest, validateManifestFile } = await import(
	"../dist/index.js"
);

describe("validateManifest", () => {
	it("accepts a minimal valid manifest", async () => {
		const result = await validateManifest({
			xript: "0.1",
			name: "calculator",
		});
		assert.equal(result.valid, true);
		assert.equal(result.errors.length, 0);
	});

	it("accepts a manifest with bindings", async () => {
		const result = await validateManifest({
			xript: "0.1",
			name: "my-game",
			version: "1.0.0",
			bindings: {
				getHealth: {
					description: "Returns health.",
					returns: "number",
				},
			},
		});
		assert.equal(result.valid, true);
	});

	it("accepts a manifest with capabilities and types", async () => {
		const result = await validateManifest({
			xript: "0.1",
			name: "my-game",
			capabilities: {
				storage: {
					description: "Read/write storage.",
					risk: "low",
				},
			},
			types: {
				Position: {
					description: "A position.",
					fields: {
						x: { type: "number" },
						y: { type: "number" },
					},
				},
			},
		});
		assert.equal(result.valid, true);
	});

	it("rejects a manifest missing the name field", async () => {
		const result = await validateManifest({ xript: "0.1" });
		assert.equal(result.valid, false);
		assert.ok(result.errors.length > 0);
		const nameError = result.errors.find((e) => e.message.includes("name"));
		assert.ok(nameError, "should report missing name");
	});

	it("rejects a manifest with an invalid name format", async () => {
		const result = await validateManifest({
			xript: "0.1",
			name: "My Game!",
		});
		assert.equal(result.valid, false);
		const patternError = result.errors.find((e) => e.keyword === "pattern");
		assert.ok(patternError, "should report pattern mismatch");
	});

	it("rejects unknown top-level properties", async () => {
		const result = await validateManifest({
			xript: "0.1",
			name: "my-app",
			notARealField: true,
		});
		assert.equal(result.valid, false);
		const extraError = result.errors.find(
			(e) => e.keyword === "additionalProperties",
		);
		assert.ok(extraError, "should report additional property");
	});

	it("rejects a binding without a description", async () => {
		const result = await validateManifest({
			xript: "0.1",
			name: "my-app",
			bindings: {
				doThing: {
					returns: "number",
				},
			},
		});
		assert.equal(result.valid, false);
	});
});

describe("validateManifestFile", () => {
	it("validates a valid file", async () => {
		const result = await validateManifestFile(
			resolve(fixturesDir, "valid-minimal.json"),
		);
		assert.equal(result.valid, true);
		assert.ok(result.filePath.includes("valid-minimal.json"));
	});

	it("reports errors for an invalid file", async () => {
		const result = await validateManifestFile(
			resolve(fixturesDir, "invalid-missing-name.json"),
		);
		assert.equal(result.valid, false);
		assert.ok(result.errors.length > 0);
	});

	it("handles missing files gracefully", async () => {
		const result = await validateManifestFile(
			resolve(fixturesDir, "nonexistent.json"),
		);
		assert.equal(result.valid, false);
		const fileError = result.errors.find((e) => e.keyword === "file");
		assert.ok(fileError, "should report file read error");
	});

	it("handles invalid JSON gracefully", async () => {
		const result = await validateManifestFile(
			resolve(fixturesDir, "invalid-json.txt"),
		);
		assert.equal(result.valid, false);
		const parseError = result.errors.find((e) => e.keyword === "parse");
		assert.ok(parseError, "should report parse error");
	});
});
