import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { builtinModules } from "node:module";
import { build } from "esbuild";
import * as nodeEntry from "../dist/index.js";
import * as coreEntry from "../dist/core.js";

const here = dirname(fileURLToPath(import.meta.url));
const coreFile = join(here, "../dist/core.js");

const NODE_ONLY = [
	"validateManifestFile",
	"validateModManifestFile",
	"validateManifestVersioned",
	"resolveExtends",
	"resolveManifestFile",
	"resolveProvenance",
	"ManifestResolutionError",
	"resolveSchema",
];

const variadicHost = (xript) => ({
	xript,
	name: "probe",
	bindings: { log: { description: "Logs.", params: [{ name: "parts", type: "string", variadic: true }] } },
});

const host = {
	xript: "0.9",
	name: "host",
	capabilities: { "ui.mount": { description: "Mount UI." } },
	slots: [{ id: "sidebar", accepts: ["text/html"], capability: "ui.mount" }],
};

describe("core entry", () => {
	let dir;
	let bundled;

	before(async () => {
		dir = await mkdtemp(join(tmpdir(), "xript-core-entry-"));
		const outfile = join(dir, "core.bundle.mjs");
		const result = await build({
			entryPoints: [coreFile],
			bundle: true,
			platform: "browser",
			format: "esm",
			outfile,
			metafile: true,
			logLevel: "silent",
		});
		bundled = { outfile, inputs: Object.keys(result.metafile.inputs), imports: result.metafile.outputs };
	});

	after(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("bundles for the browser with no Node builtin anywhere in its import graph", () => {
		const builtins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);
		for (const output of Object.values(bundled.imports)) {
			const external = output.imports.filter((entry) => entry.external || builtins.has(entry.path));
			assert.deepEqual(external, []);
		}
		assert.ok(bundled.inputs.some((input) => input.includes("ajv")), "ajv is bundled in");
		const nodeOnlyModules = ["index.js", "resolve.js", "schema-resolve.js", "cli.js"].map((file) => join(here, "../dist", file));
		const absoluteInputs = bundled.inputs.map((input) => resolve(input));
		assert.deepEqual(absoluteInputs.filter((input) => nodeOnlyModules.includes(input)), []);
		assert.ok(absoluteInputs.includes(coreFile));
	});

	it("runs as a bundle: schema, cross-validation, lint, and version pinning", async () => {
		const core = await import(pathToFileURL(bundled.outfile).href);
		assert.equal((await core.validateManifest(host)).valid, true);
		const broken = await core.validateManifest({ ...host, slots: "nope" });
		assert.equal(broken.valid, false);

		const mod = {
			xript: "0.9",
			name: "mod-a",
			version: "1.0.0",
			capabilities: ["ui.mount"],
			fills: { sidebar: [{ format: "text/html", source: "<p>hi</p>", inline: true }] },
		};
		assert.equal((await core.validateModManifest(mod)).valid, true);
		assert.equal((await core.crossValidate(host, mod)).valid, true);
		const strayed = await core.crossValidate(host, { ...mod, fills: { missing: mod.fills.sidebar } });
		assert.equal(strayed.errors[0].keyword, "cross-fill-slot");
		assert.ok(Array.isArray(core.lintManifests(host, [mod]).findings));

		const pinned = await core.validateManifestForVersion(variadicHost("0.8"));
		assert.equal(pinned.valid, false);
		assert.deepEqual(pinned.target, { version: "0.8", source: "xript" });
		assert.equal((await core.validateManifestForVersion(variadicHost("0.9"))).valid, true);
	});

	it("exports everything the Node entry does except the file and network resolvers", () => {
		const missing = Object.keys(nodeEntry).filter((name) => !(name in coreEntry) && !NODE_ONLY.includes(name));
		assert.deepEqual(missing, []);
		for (const name of NODE_ONLY) assert.ok(!(name in coreEntry), `${name} stays Node-only`);
		assert.equal(nodeEntry.validateManifest, coreEntry.validateManifest);
	});
});

describe("validateManifestForVersion", () => {
	it("agrees with the Node entry's versioned validation", async () => {
		for (const xript of ["0.8", "0.9"]) {
			const inMemory = await coreEntry.validateManifestForVersion(variadicHost(xript));
			const versioned = await nodeEntry.validateManifestVersioned(variadicHost(xript));
			assert.equal(inMemory.valid, versioned.valid);
			assert.deepEqual(inMemory.target, versioned.target);
		}
	});

	it("honors an explicit version and refuses one it does not speak", async () => {
		const pinned = await coreEntry.validateManifestForVersion(variadicHost("0.8"), { version: "0.9" });
		assert.equal(pinned.valid, true);
		assert.equal(pinned.target.source, "option");
		const refused = await coreEntry.validateManifestForVersion(variadicHost("0.9"), { version: "0.4" });
		assert.equal(refused.valid, false);
		assert.equal(refused.errors[0].keyword, "version");
	});

	it("falls back to bundled core with a warning for an overlay $schema it cannot fetch", async () => {
		const result = await coreEntry.validateManifestForVersion({ ...host, $schema: "https://example.com/overlay.json" });
		assert.equal(result.valid, true, JSON.stringify(result.errors));
		assert.ok(result.warnings.some((w) => w.keyword === "schema-fallback"));
	});

	it("validates against an overlay schema the caller supplies", async () => {
		const overlay = {
			$id: "https://example.com/overlay.json",
			allOf: [{ $ref: "https://xript.dev/schema/manifest/v0.9.json" }],
			required: ["tagline"],
		};
		const result = await coreEntry.validateManifestForVersion(host, { schema: overlay });
		assert.equal(result.valid, false);
		assert.ok(result.errors.some((e) => /tagline/.test(e.message)));
	});

	it("chooses mod validation from the manifest's content", async () => {
		const mod = { xript: "0.8", name: "m", version: "1.0.0", fills: {} };
		const result = await coreEntry.validateManifestForVersion(mod);
		assert.equal(result.valid, true, JSON.stringify(result.errors));
		assert.deepEqual(result.target, { version: "0.8", source: "xript" });
	});
});
