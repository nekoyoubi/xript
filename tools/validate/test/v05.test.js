import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, cp, rm } from "node:fs/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, "fixtures");
const distDir = resolve(__dirname, "..", "dist");
const pkgTestRoot = resolve(__dirname, "..", "__pkgtest__");

const {
	validateManifest,
	validateModManifest,
	validateManifestFile,
	validateModManifestFile,
	validateShape,
	validateEntrySource,
	detectCommonJs,
	resolveExtends,
	resolveManifestFile,
	ManifestResolutionError,
} = await import("../dist/index.js");

const { mkdtemp, writeFile } = await import("node:fs/promises");
const { tmpdir } = await import("node:os");

describe("schema packaging", () => {
	it("bundles the schema files into dist/schema", async () => {
		const { access } = await import("node:fs/promises");
		await access(join(distDir, "schema", "manifest.schema.json"));
		await access(join(distDir, "schema", "mod-manifest.schema.json"));
	});

	it("resolves schemas from a published layout with no spec/ dir above the package", async () => {
		const pkgRoot = pkgTestRoot;
		await rm(pkgRoot, { recursive: true, force: true });
		await mkdir(pkgRoot, { recursive: true });
		try {
			await cp(distDir, join(pkgRoot, "dist"), { recursive: true });

			const moduleUrl = new URL(`file://${join(pkgRoot, "dist", "index.js").replace(/\\/g, "/")}`);
			const isolated = await import(moduleUrl.href);

			const result = await isolated.validateManifest({ xript: "0.3", name: "calculator" });
			assert.equal(result.valid, true);

			const modResult = await isolated.validateModManifest({
				xript: "0.3",
				name: "my-mod",
				version: "1.0.0",
			});
			assert.equal(modResult.valid, true);
		} finally {
			await rm(pkgRoot, { recursive: true, force: true });
		}
	});
});

describe("manifest extends merge", () => {
	it("merges base bindings, capabilities, and slots into the child", async () => {
		const merged = await resolveExtends(
			JSON.parse(
				JSON.stringify({
					xript: "0.3",
					extends: "./extends-base.json",
					name: "host-child",
					bindings: { setHealth: { description: "Sets health." } },
					slots: [{ id: "statusbar", accepts: ["text/html"] }],
				}),
			),
			fixturesDir,
		);
		assert.equal(merged.name, "host-child");
		assert.ok(merged.bindings.getHealth, "inherits base binding");
		assert.ok(merged.bindings.setHealth, "keeps child binding");
		assert.ok(merged.capabilities.storage, "inherits base capability");
		const slotIds = merged.slots.map((s) => s.id).sort();
		assert.deepEqual(slotIds, ["sidebar", "statusbar"]);
		assert.equal(merged.extends, undefined, "extends is stripped after resolution");
	});

	it("validates a resolved extends chain through validateManifestFile", async () => {
		const result = await validateManifestFile(resolve(fixturesDir, "extends-child.json"));
		assert.equal(result.valid, true, JSON.stringify(result.errors));
	});

	it("errors on a binding id present in both base and child", async () => {
		const result = await validateManifestFile(resolve(fixturesDir, "extends-conflict.json"));
		assert.equal(result.valid, false);
		const conflict = result.errors.find((e) => e.keyword === "extends");
		assert.ok(conflict, "reports an extends conflict");
		assert.match(conflict.message, /getHealth/);
	});

	it("detects extends cycles", async () => {
		await assert.rejects(
			() => resolveManifestFile(resolve(fixturesDir, "cycle-a.json")),
			(err) => {
				assert.ok(err instanceof ManifestResolutionError);
				assert.match(err.message, /cyclic/);
				return true;
			},
		);
	});

	it("errors when an extended base path cannot be read", async () => {
		await assert.rejects(
			() => resolveExtends({ xript: "0.3", extends: "./nope.json", name: "x" }, fixturesDir),
			(err) => {
				assert.ok(err instanceof ManifestResolutionError);
				return true;
			},
		);
	});
});

describe("mod manifest family", () => {
	it("accepts a valid family field", async () => {
		const result = await validateModManifest({
			xript: "0.3",
			name: "acme-tools",
			version: "1.0.0",
			family: "acme",
		});
		assert.equal(result.valid, true, JSON.stringify(result.errors));
	});

	it("rejects a family that violates the machine-id pattern", async () => {
		const result = await validateModManifest({
			xript: "0.3",
			name: "acme-tools",
			version: "1.0.0",
			family: "Acme System",
		});
		assert.equal(result.valid, false);
		assert.ok(result.errors.some((e) => e.keyword === "pattern"));
	});
});

describe("mod manifest entry exports", () => {
	it("accepts the bare string entry form (back-compat)", async () => {
		const result = await validateModManifest({
			xript: "0.3",
			name: "my-mod",
			version: "1.0.0",
			entry: "main.js",
		});
		assert.equal(result.valid, true, JSON.stringify(result.errors));
	});

	it("accepts the object entry form with declared exports", async () => {
		const result = await validateModManifest({
			xript: "0.3",
			name: "my-mod",
			version: "1.0.0",
			capabilities: ["audio-read"],
			entry: {
				script: "main.js",
				format: "script",
				exports: {
					transcribe: {
						description: "Transcribe audio.",
						params: [{ name: "audioUrl", type: "string" }],
						returns: "string",
						capability: "audio-read",
					},
				},
			},
		});
		assert.equal(result.valid, true, JSON.stringify(result.errors));
	});

	it("rejects an entry object missing the script field", async () => {
		const result = await validateModManifest({
			xript: "0.3",
			name: "my-mod",
			version: "1.0.0",
			entry: { format: "script", exports: {} },
		});
		assert.equal(result.valid, false);
	});

	it("rejects an export capability not declared in the mod's capabilities", async () => {
		const result = await validateModManifest({
			xript: "0.3",
			name: "my-mod",
			version: "1.0.0",
			entry: {
				script: "main.js",
				exports: {
					transcribe: { description: "Transcribe audio.", capability: "audio-read" },
				},
			},
		});
		assert.equal(result.valid, false);
		assert.ok(result.errors.some((e) => e.keyword === "export-capability"));
	});

	it("rejects an unknown entry.format value", async () => {
		const result = await validateModManifest({
			xript: "0.3",
			name: "my-mod",
			version: "1.0.0",
			entry: { script: "main.js", format: "wasm" },
		});
		assert.equal(result.valid, false);
	});
});

describe("provider roles (wave 2)", () => {
	it("accepts a valid contributions.provides with an object fns map", async () => {
		const result = await validateModManifest({
			xript: "0.3",
			name: "clip-mod",
			version: "1.0.0",
			contributions: {
				provides: [
					{ role: "clipboard-history", fns: { query: "ch_query", restore: "ch_restore" } },
				],
			},
		});
		assert.equal(result.valid, true, JSON.stringify(result.errors));
	});

	it("rejects an array-form fns (the object map is the decided shape)", async () => {
		const result = await validateModManifest({
			xript: "0.3",
			name: "clip-mod",
			version: "1.0.0",
			contributions: { provides: [{ role: "clipboard-history", fns: ["ch_query"] }] },
		});
		assert.equal(result.valid, false);
	});

	it("rejects an empty fns map", async () => {
		const result = await validateModManifest({
			xript: "0.3",
			name: "clip-mod",
			version: "1.0.0",
			contributions: { provides: [{ role: "clipboard-history", fns: {} }] },
		});
		assert.equal(result.valid, false);
	});

	it("rejects a role that violates the machine-id pattern", async () => {
		const result = await validateModManifest({
			xript: "0.3",
			name: "clip-mod",
			version: "1.0.0",
			contributions: { provides: [{ role: "Clipboard History", fns: { query: "ch_query" } }] },
		});
		assert.equal(result.valid, false);
		assert.ok(result.errors.some((e) => e.keyword === "pattern"));
	});

	it("errors on a duplicate role within one mod's provides[]", async () => {
		const result = await validateModManifest({
			xript: "0.3",
			name: "clip-mod",
			version: "1.0.0",
			contributions: {
				provides: [
					{ role: "clipboard-history", fns: { query: "a" } },
					{ role: "clipboard-history", fns: { restore: "b" } },
				],
			},
		});
		assert.equal(result.valid, false);
		assert.ok(result.errors.some((e) => e.keyword === "duplicate-role"));
	});

	it("warns when a role fn is not a declared export", async () => {
		const result = await validateModManifest({
			xript: "0.3",
			name: "clip-mod",
			version: "1.0.0",
			entry: { script: "main.js", exports: { ch_query: { description: "Query." } } },
			contributions: {
				provides: [{ role: "clipboard-history", fns: { query: "ch_query", restore: "ch_restore" } }],
			},
		});
		assert.equal(result.valid, true, JSON.stringify(result.errors));
		assert.ok((result.warnings ?? []).some((w) => w.keyword === "provides-fn-unbound"));
		assert.ok(!(result.warnings ?? []).some((w) => w.message.includes("ch_query")));
	});

	it("does not warn about role fns when entry declares no exports", async () => {
		const result = await validateModManifest({
			xript: "0.3",
			name: "clip-mod",
			version: "1.0.0",
			entry: "main.js",
			contributions: { provides: [{ role: "clipboard-history", fns: { query: "ch_query" } }] },
		});
		assert.equal((result.warnings ?? []).length, 0);
	});
});

describe("field enum mismatch warning (wave 2)", () => {
	it("warns when an inline enum value type does not match the field's primitive type", async () => {
		const result = await validateManifest({
			xript: "0.3",
			name: "host",
			types: {
				Config: {
					description: "Config.",
					fields: { count: { type: "number", enum: ["one", "two"] } },
				},
			},
		});
		assert.ok((result.warnings ?? []).some((w) => w.keyword === "enum-type-mismatch"));
	});

	it("does not warn when enum values match the field type", async () => {
		const result = await validateManifest({
			xript: "0.3",
			name: "host",
			types: {
				Config: {
					description: "Config.",
					fields: { mode: { type: "string", enum: ["a", "b"] } },
				},
			},
		});
		assert.equal((result.warnings ?? []).filter((w) => w.keyword === "enum-type-mismatch").length, 0);
	});

	it("accepts a field with default and enum in the schema", async () => {
		const result = await validateManifest({
			xript: "0.3",
			name: "host",
			types: {
				Config: {
					description: "Config.",
					fields: { style: { type: "string", enum: ["posix", "native"], default: "posix" } },
				},
			},
		});
		assert.equal(result.valid, true, JSON.stringify(result.errors));
	});
});

describe("grant shape validation (wave 2)", () => {
	it("validates a well-formed CapabilityPrompt", async () => {
		const result = await validateShape("capability-prompt", {
			capability: "clipboard-write",
			description: "Write to the clipboard.",
			risk: "medium",
			mod: { name: "clip-mod", version: "1.0.0" },
			requestedScope: "session",
			state: "first-time",
		});
		assert.equal(result.valid, true, JSON.stringify(result.errors));
	});

	it("rejects a CapabilityPrompt with an out-of-vocabulary requestedScope", async () => {
		const result = await validateShape("capability-prompt", {
			capability: "clipboard-write",
			description: "Write.",
			risk: "low",
			mod: { name: "clip-mod", version: "1.0.0" },
			requestedScope: "forever",
			state: "first-time",
		});
		assert.equal(result.valid, false);
	});

	it("validates an InstallDescriptor with a closed source.type", async () => {
		const ok = await validateShape("install-descriptor", {
			name: "clip-mod",
			version: "1.0.0",
			source: { type: "registry", location: "clip-mod@1.0.0" },
		});
		assert.equal(ok.valid, true, JSON.stringify(ok.errors));

		const bad = await validateShape("install-descriptor", {
			name: "clip-mod",
			version: "1.0.0",
			source: { type: "ftp", location: "x" },
		});
		assert.equal(bad.valid, false);
	});

	it("validates a DiscoveryResult with role-vocabulary provides", async () => {
		const result = await validateShape("discovery-result", {
			mods: [
				{
					name: "clip-mod",
					version: "1.0.0",
					location: "/mods/clip",
					enabled: true,
					capabilities: ["clipboard-write"],
					provides: ["clipboard-history"],
				},
			],
			scannedAt: 1730000000000,
		});
		assert.equal(result.valid, true, JSON.stringify(result.errors));
	});

	it("validates DAP debug message structs against debug-messages defs", async () => {
		const { resolve: r, dirname: d } = await import("node:path");
		const { fileURLToPath: f } = await import("node:url");
		const { readFile } = await import("node:fs/promises");
		const here = d(f(import.meta.url));
		const raw = await readFile(r(here, "..", "dist", "schema", "debug-messages.schema.json"), "utf-8");
		const schema = JSON.parse(raw);
		assert.ok(schema.$defs.stoppedEvent, "stoppedEvent def present");
		assert.equal(schema.$defs.stoppedEvent.properties.threadId.const, 1);
		assert.deepEqual(schema.$defs.scope.properties.name.enum, ["Local", "Closure", "Global"]);
	});
});

describe("module-format entry (wave 3)", () => {
	it("accepts entry.format module in the schema", async () => {
		const result = await validateModManifest({
			xript: "0.3",
			name: "my-mod",
			version: "1.0.0",
			capabilities: ["audio-read"],
			entry: {
				script: "main.js",
				format: "module",
				exports: {
					transcribe: { description: "Transcribe.", capability: "audio-read" },
				},
			},
		});
		assert.equal(result.valid, true, JSON.stringify(result.errors));
	});
});

describe("CommonJS guardrail (wave 3)", () => {
	it("detects require() in a source string", () => {
		assert.equal(detectCommonJs('const fs = require("fs");'), "require()");
	});

	it("detects module.exports", () => {
		assert.equal(detectCommonJs("module.exports = { foo };"), "module.exports");
	});

	it("detects a top-level exports.x assignment", () => {
		assert.equal(detectCommonJs("exports.transcribe = function () {};"), "exports.x");
	});

	it("detects exports[ index assignment", () => {
		assert.equal(detectCommonJs('exports["transcribe"] = fn;'), "exports.x");
	});

	it("does not flag clean ESM source", () => {
		assert.equal(detectCommonJs("export function transcribe() {}"), null);
	});

	it("raises a hard commonjs-detected error via validateEntrySource", () => {
		const { errors } = validateEntrySource(
			{ entry: { script: "main.js", format: "module" } },
			'const fs = require("fs");',
		);
		const cjs = errors.find((e) => e.keyword === "commonjs-detected");
		assert.ok(cjs, "reports commonjs-detected");
		assert.equal(cjs.path, "/entry");
		assert.match(cjs.message, /authoring-mods-in-typescript/);
	});

	it("flags CJS at file-validation time and reports invalid", async () => {
		const dir = await mkdtemp(join(tmpdir(), "xript-validate-cjs-"));
		try {
			await writeFile(
				join(dir, "src.js"),
				'const x = require("./dep");\nmodule.exports = { x };\n',
			);
			await writeFile(
				join(dir, "mod-manifest.json"),
				JSON.stringify({
					xript: "0.3",
					name: "cjs-mod",
					version: "1.0.0",
					entry: { script: "src.js", format: "module" },
				}),
			);
			const result = await validateModManifestFile(join(dir, "mod-manifest.json"));
			assert.equal(result.valid, false);
			assert.ok(result.errors.some((e) => e.keyword === "commonjs-detected"));
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("applies the CJS guard in script mode too", async () => {
		const dir = await mkdtemp(join(tmpdir(), "xript-validate-cjs-s-"));
		try {
			await writeFile(join(dir, "src.js"), 'module.exports.run = require("x");\n');
			await writeFile(
				join(dir, "mod-manifest.json"),
				JSON.stringify({
					xript: "0.3",
					name: "cjs-script",
					version: "1.0.0",
					entry: "src.js",
				}),
			);
			const result = await validateModManifestFile(join(dir, "mod-manifest.json"));
			assert.equal(result.valid, false);
			assert.ok(result.errors.some((e) => e.keyword === "commonjs-detected"));
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("module import lint + export reconciliation (wave 3)", () => {
	it("flags a static import in a module entry as import-denied", () => {
		const { errors } = validateEntrySource(
			{ entry: { script: "main.js", format: "module" } },
			'import { x } from "lodash";\nexport function go() {}',
		);
		const denied = errors.find((e) => e.keyword === "import-denied");
		assert.ok(denied, "reports import-denied");
		assert.match(denied.message, /lodash/);
	});

	it("flags a relative import in a module entry as import-denied", () => {
		const { errors } = validateEntrySource(
			{ entry: { script: "main.js", format: "module" } },
			'import "./helper.js";\nexport function go() {}',
		);
		assert.ok(errors.some((e) => e.keyword === "import-denied"));
	});

	it("warns when a declared export has no detectable top-level export", () => {
		const { warnings } = validateEntrySource(
			{
				entry: {
					script: "main.js",
					format: "module",
					exports: { transcribe: { description: "x" } },
				},
			},
			"export function other() {}",
		);
		assert.ok(warnings.some((w) => w.keyword === "export-unbound"));
	});

	it("does not warn when the declared export matches a top-level export", () => {
		const { warnings } = validateEntrySource(
			{
				entry: {
					script: "main.js",
					format: "module",
					exports: { transcribe: { description: "x" } },
				},
			},
			"export function transcribe() {}",
		);
		assert.equal(warnings.filter((w) => w.keyword === "export-unbound").length, 0);
	});

	it("matches a renamed named-export list (export { a as transcribe })", () => {
		const { warnings } = validateEntrySource(
			{
				entry: {
					script: "main.js",
					format: "module",
					exports: { transcribe: { description: "x" } },
				},
			},
			"function impl() {}\nexport { impl as transcribe };",
		);
		assert.equal(warnings.filter((w) => w.keyword === "export-unbound").length, 0);
	});

	it("does not lint imports in script-mode entries", () => {
		const { errors } = validateEntrySource(
			{ entry: { script: "main.js", format: "script" } },
			'import "x";',
		);
		assert.equal(errors.filter((e) => e.keyword === "import-denied").length, 0);
	});
});

describe("app manifest extends field", () => {
	it("accepts an inline extends string in the schema", async () => {
		const result = await validateManifest({
			xript: "0.3",
			name: "my-app",
			extends: "./base.json",
		});
		assert.equal(result.valid, true, JSON.stringify(result.errors));
	});

	it("accepts an extends array in the schema", async () => {
		const result = await validateManifest({
			xript: "0.3",
			name: "my-app",
			extends: ["./a.json", "./b.json"],
		});
		assert.equal(result.valid, true, JSON.stringify(result.errors));
	});
});
