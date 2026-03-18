import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, "fixtures");

const {
	validateManifest,
	validateManifestFile,
	validateModManifest,
	validateModManifestFile,
	crossValidate,
	isModManifest,
} = await import("../dist/index.js");

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

	it("auto-detects mod manifests and validates with mod schema", async () => {
		const result = await validateManifestFile(
			resolve(fixturesDir, "valid-mod.json"),
		);
		assert.equal(result.valid, true);
	});
});

describe("validateModManifest", () => {
	it("accepts a valid mod manifest", async () => {
		const result = await validateModManifest({
			xript: "0.3",
			name: "my-mod",
			version: "1.0.0",
			entry: "src/mod.js",
			fragments: [
				{
					id: "health-panel",
					slot: "sidebar.left",
					format: "text/html",
					source: "fragments/panel.html",
				},
			],
		});
		assert.equal(result.valid, true);
		assert.equal(result.errors.length, 0);
	});

	it("rejects a mod manifest missing required fields", async () => {
		const result = await validateModManifest({
			xript: "0.3",
			name: "my-mod",
		});
		assert.equal(result.valid, false);
		const versionError = result.errors.find((e) =>
			e.message.includes("version"),
		);
		assert.ok(versionError, "should report missing version");
	});

	it("rejects a mod manifest with an invalid fragment", async () => {
		const result = await validateModManifest({
			xript: "0.3",
			name: "my-mod",
			version: "1.0.0",
			fragments: [
				{
					id: "panel",
					slot: "sidebar.left",
				},
			],
		});
		assert.equal(result.valid, false);
		assert.ok(result.errors.length > 0);
	});

	it("accepts a minimal mod manifest without fragments", async () => {
		const result = await validateModManifest({
			xript: "0.3",
			name: "my-mod",
			version: "1.0.0",
			entry: "src/mod.js",
		});
		assert.equal(result.valid, true);
	});
});

describe("isModManifest", () => {
	it("detects mod manifests with fragments", () => {
		assert.equal(isModManifest({ fragments: [], name: "x" }), true);
	});

	it("detects mod manifests with entry", () => {
		assert.equal(isModManifest({ entry: "mod.js", name: "x" }), true);
	});

	it("does not detect app manifests with bindings", () => {
		assert.equal(isModManifest({ bindings: {}, name: "x" }), false);
	});

	it("does not treat manifests with both bindings and fragments as mods", () => {
		assert.equal(
			isModManifest({ bindings: {}, fragments: [], name: "x" }),
			false,
		);
	});

	it("returns false for non-objects", () => {
		assert.equal(isModManifest(null), false);
		assert.equal(isModManifest("string"), false);
	});
});

describe("crossValidate", () => {
	const appManifest = {
		xript: "0.3",
		name: "my-game",
		capabilities: {
			"modify-state": { description: "Modify state.", risk: "medium" },
		},
		slots: [
			{ id: "sidebar.left", accepts: ["text/html"], multiple: true },
			{ id: "statusbar.right", accepts: ["text/html", "text/plain"] },
		],
	};

	it("passes when all fragments target valid slots with accepted formats", async () => {
		const modManifest = {
			xript: "0.3",
			name: "my-mod",
			version: "1.0.0",
			capabilities: ["modify-state"],
			fragments: [
				{
					id: "panel",
					slot: "sidebar.left",
					format: "text/html",
					source: "panel.html",
				},
			],
		};
		const result = await crossValidate(appManifest, modManifest);
		assert.equal(result.valid, true);
		assert.equal(result.errors.length, 0);
	});

	it("fails when a fragment targets a non-existent slot", async () => {
		const modManifest = {
			xript: "0.3",
			name: "my-mod",
			version: "1.0.0",
			fragments: [
				{
					id: "panel",
					slot: "toolbar.top",
					format: "text/html",
					source: "panel.html",
				},
			],
		};
		const result = await crossValidate(appManifest, modManifest);
		assert.equal(result.valid, false);
		const slotError = result.errors.find((e) => e.keyword === "cross-slot");
		assert.ok(slotError, "should report missing slot");
		assert.ok(slotError.message.includes("toolbar.top"));
	});

	it("fails when a fragment uses an unaccepted format", async () => {
		const modManifest = {
			xript: "0.3",
			name: "my-mod",
			version: "1.0.0",
			fragments: [
				{
					id: "panel",
					slot: "sidebar.left",
					format: "application/json",
					source: "panel.json",
				},
			],
		};
		const result = await crossValidate(appManifest, modManifest);
		assert.equal(result.valid, false);
		const formatError = result.errors.find(
			(e) => e.keyword === "cross-format",
		);
		assert.ok(formatError, "should report unaccepted format");
		assert.ok(formatError.message.includes("application/json"));
	});

	it("fails when a mod requests a capability not in the app manifest", async () => {
		const modManifest = {
			xript: "0.3",
			name: "my-mod",
			version: "1.0.0",
			capabilities: ["network-access"],
		};
		const result = await crossValidate(appManifest, modManifest);
		assert.equal(result.valid, false);
		const capError = result.errors.find(
			(e) => e.keyword === "cross-capability",
		);
		assert.ok(capError, "should report missing capability");
		assert.ok(capError.message.includes("network-access"));
	});
});
