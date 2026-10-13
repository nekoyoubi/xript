import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, "fixtures");

const {
	validateManifest,
	satisfies,
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

	it("warns on unknown top-level properties without failing", async () => {
		const result = await validateManifest({
			xript: "0.1",
			name: "my-app",
			notARealField: true,
		});
		assert.equal(result.valid, true, JSON.stringify(result.errors));
		const warn = (result.warnings ?? []).find((w) => w.keyword === "unknown-key");
		assert.ok(warn, "should warn about the unrecognized top-level key");
		assert.match(warn.message, /notARealField/);
	});

	it("rejects a binding name that is not a JavaScript identifier", async () => {
		// A kebab binding name would parse as subtraction in a script and breaks typegen's output;
		// the spec says binding and member names are identifiers, so the schema enforces it.
		const kebab = await validateManifest({
			xript: "0.8", name: "app", version: "1.0.0",
			bindings: { "foo-bar": { description: "d", returns: "string" } },
		});
		assert.equal(kebab.valid, false, "a kebab top-level binding name should be rejected");
		assert.ok(kebab.errors.find((e) => e.keyword === "pattern"), "should report a pattern mismatch");

		const nestedKebab = await validateManifest({
			xript: "0.8", name: "app", version: "1.0.0",
			bindings: { ns: { description: "d", members: { "get-x": { description: "d" } } } },
		});
		assert.equal(nestedKebab.valid, false, "a kebab namespace member name should be rejected");

		const ok = await validateManifest({
			xript: "0.8", name: "app", version: "1.0.0",
			bindings: { fooBar: { description: "d", returns: "string" }, ns: { description: "d", members: { getX: { description: "d" } } } },
		});
		assert.equal(ok.valid, true, "camelCase binding and member names stay valid");

		// type names become generated interface/type names, so they are identifiers too
		const kebabType = await validateManifest({
			xript: "0.8", name: "app", version: "1.0.0",
			types: { "foo-bar": { description: "d", fields: {} } },
		});
		assert.equal(kebabType.valid, false, "a kebab type name should be rejected");
	});

	describe("a failed oneOf reports only the branch that nearly matched", () => {
		const namespaceMissingDescription = {
			xript: "0.8",
			name: "t",
			capabilities: { a: { description: "A" } },
			bindings: { ns: { members: { go: { description: "Go", capability: "a" } } } },
		};

		it("does not tell the author that `members` is unexpected on a namespace", async () => {
			const result = await validateManifest(namespaceMissingDescription);
			assert.equal(result.valid, false);
			const misleading = result.errors.find(
				(e) => e.keyword === "additionalProperties" && e.message.includes("members"),
			);
			assert.equal(misleading, undefined, "reported the namespace's own `members` as unexpected");
		});

		it("reports the one real problem, once", async () => {
			const result = await validateManifest(namespaceMissingDescription);
			const atPath = result.errors.filter((e) => e.path === "/bindings/ns");
			assert.equal(atPath.length, 1, `expected a single finding, got ${JSON.stringify(atPath)}`);
			assert.equal(atPath[0].message, 'missing required property "description"');
		});

		it("drops the bare oneOf meta-error", async () => {
			const result = await validateManifest(namespaceMissingDescription);
			assert.equal(result.errors.find((e) => e.keyword === "oneOf"), undefined);
		});

		it("still reports something when no branch is close", async () => {
			const result = await validateManifest({
				xript: "0.8",
				name: "t",
				bindings: { ns: 42 },
			});
			assert.equal(result.valid, false);
			assert.ok(result.errors.length > 0, "a wholly wrong binding must still report");
		});
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
	it("rejects an export name that is not a JavaScript identifier", async () => {
		// A module-mode named export cannot be a kebab name, and the host invokes exports by name.
		const result = await validateModManifest({
			xript: "0.8", name: "m", version: "1.0.0",
			entry: { script: "x.js", exports: { "do-thing": { description: "d" } } },
		});
		assert.equal(result.valid, false, "a kebab export name should be rejected");
	});

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

	const payloadApp = {
		xript: "0.6",
		name: "host",
		capabilities: { ui: { description: "UI." } },
		slots: [
			{
				id: "panel",
				accepts: ["text/html+jsml"],
				capability: "ui",
				payload: {
					type: "object",
					required: ["id", "format", "styling"],
					additionalProperties: true,
					properties: {
						id: { type: "string", minLength: 1 },
						format: { type: "string", enum: ["text/html+jsml"] },
						styling: { type: "string", enum: ["inherit", "isolated", "scoped"] },
					},
				},
			},
		],
	};

	it("fails a fill whose payload violates the slot's payload schema", async () => {
		const mod = {
			xript: "0.6",
			name: "m",
			version: "1.0.0",
			capabilities: ["ui"],
			fills: { panel: [{ id: "p", format: "application/json" }] },
		};
		const result = await crossValidate(payloadApp, mod);
		assert.equal(result.valid, false);
		const payloadError = result.errors.find((e) => e.keyword === "cross-fill-payload");
		assert.ok(payloadError, "should report a payload violation");
	});

	it("accepts a fill that carries more than the payload declares", async () => {
		const mod = {
			xript: "0.6",
			name: "m",
			version: "1.0.0",
			capabilities: ["ui"],
			fills: { panel: [{ id: "p", format: "text/html+jsml", styling: "scoped", extra: { anything: true } }] },
		};
		const result = await crossValidate(payloadApp, mod);
		assert.equal(result.valid, true, JSON.stringify(result.errors));
	});

	it("skips payload conformance when checkFillPayloads is off", async () => {
		const mod = {
			xript: "0.6",
			name: "m",
			version: "1.0.0",
			capabilities: ["ui"],
			fills: { panel: [{ id: "p", format: "application/json" }] },
		};
		const result = await crossValidate(payloadApp, mod, { checkFillPayloads: false });
		assert.equal(result.valid, true);
	});
});

describe("libraries surface", () => {
	it("validates a manifest with a libraries allow-list", async () => {
		const result = await validateManifest({
			xript: "0.7",
			name: "library-host",
			capabilities: { lib: { description: "Shared libraries." } },
			libraries: {
				"@example/doc": { description: "Doc helpers.", capability: "lib.doc", version: "^1.0.0" },
			},
		});
		assert.equal(result.valid, true, JSON.stringify(result.errors));
	});

	it("rejects a library entry with unknown fields", async () => {
		const result = await validateManifest({
			xript: "0.7",
			name: "library-host",
			libraries: { "doc-lib": { description: "Doc helpers.", sneaky: true } },
		});
		assert.equal(result.valid, false);
	});

	it("rejects a malformed library specifier", async () => {
		const result = await validateManifest({
			xript: "0.7",
			name: "library-host",
			libraries: { "Not A Specifier!": { description: "Nope." } },
		});
		assert.equal(result.valid, false);
	});
});

describe("capability predicate — shared conformance corpus", () => {
	it("matches every case in spec/capability-tests.json", async () => {
		const { readFile } = await import("node:fs/promises");
		const { fileURLToPath } = await import("node:url");
		const { dirname, resolve } = await import("node:path");
		const here = dirname(fileURLToPath(import.meta.url));
		const corpus = JSON.parse(await readFile(resolve(here, "../../../spec/capability-tests.json"), "utf-8"));
		assert.ok(corpus.length >= 30, "corpus is present");
		const { grantedSatisfies } = await import("../dist/index.js");
		for (const testCase of corpus) {
			const actual = testCase.granted !== undefined
				? grantedSatisfies(testCase.granted, testCase.require)
				: satisfies(testCase.grant, testCase.require);
			assert.equal(actual, testCase.expected, `${testCase.description}`);
		}
	});
});

describe("crossValidate — capability subsumption", () => {
	const host = {
		xript: "0.7",
		name: "h",
		capabilities: { fs: { description: "files" }, lib: { description: "libs" } },
		slots: [{ id: "panel", accepts: ["text/html"], capability: "lib.doc", description: "p" }],
	};

	it("accepts a mod requesting a child scope of a declared capability", async () => {
		const result = await crossValidate(host, {
			xript: "0.7", name: "m", version: "1.0.0",
			capabilities: ["fs.addon", "read:fs"],
		});
		assert.equal(result.valid, true, JSON.stringify(result.errors));
	});

	it("accepts a mod holding a broader capability than a slot's gate", async () => {
		const result = await crossValidate(host, {
			xript: "0.7", name: "m", version: "1.0.0",
			capabilities: ["lib"],
			fills: { panel: [{ format: "text/html", source: "p.html" }] },
		});
		assert.equal(result.valid, true, JSON.stringify(result.errors));
	});

	it("still rejects a request no declared scope subsumes", async () => {
		const result = await crossValidate(host, {
			xript: "0.7", name: "m", version: "1.0.0",
			capabilities: ["net"],
		});
		assert.equal(result.valid, false);
	});
});

describe("unknown top-level properties", () => {
	it("warns and names the offending property instead of failing", async () => {
		const result = await validateManifest({
			xript: "0.8",
			name: "stray",
			version: "1.0.0",
			commands: { doThing: { description: "nowhere to live" } },
		});
		assert.equal(result.valid, true, JSON.stringify(result.errors));
		const messages = (result.warnings ?? []).filter((w) => w.keyword === "unknown-key").map((w) => w.message);
		assert.ok(
			messages.some((m) => m.includes('"commands"')),
			`expected the key to be named, got ${JSON.stringify(messages)}`,
		);
	});

	it("names every offending property, not just the first", async () => {
		const result = await validateManifest({
			xript: "0.8",
			name: "stray",
			version: "1.0.0",
			alpha: {},
			beta: {},
		});
		assert.equal(result.valid, true, JSON.stringify(result.errors));
		const messages = (result.warnings ?? []).filter((w) => w.keyword === "unknown-key").map((w) => w.message).join(" ");
		assert.ok(messages.includes('"alpha"') && messages.includes('"beta"'), messages);
	});
});

describe("function parameters", () => {
	it("accepts the callback corpus host, with bare, optional, and signature function types", async () => {
		const { readFileSync } = await import("node:fs");
		const corpus = JSON.parse(readFileSync(resolve(__dirname, "../../../spec/callback-tests.json"), "utf8"));
		const result = await validateManifest(corpus.manifest);
		assert.equal(result.valid, true, JSON.stringify(result.errors));
	});

	it("rejects an unknown key in a function signature", async () => {
		const result = await validateManifest({
			xript: "0.8",
			name: "h",
			bindings: {
				find: { description: "d", params: [{ name: "test", type: { function: { arguments: [] } } }] },
			},
		});
		assert.equal(result.valid, false);
	});
});
