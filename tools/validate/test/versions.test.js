import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CURRENT_SPEC_VERSION,
	SUPPORTED_SPEC_VERSIONS,
	UnsupportedVersionError,
	describeTargetVersion,
	loadSpecSchema,
	resolveTargetVersion,
	validateManifestFile,
	validateManifestVersioned,
} from "../dist/index.js";

const variadicHost = (xript, extra = {}) => ({
	xript,
	name: "probe",
	bindings: { log: { description: "Logs.", params: [{ name: "parts", type: "string", variadic: true }] } },
	...extra,
});

describe("target version resolution", () => {
	it("speaks 0.6 through the current version", () => {
		assert.deepEqual(SUPPORTED_SPEC_VERSIONS, ["0.6", "0.7", "0.8", "0.9"]);
		assert.equal(CURRENT_SPEC_VERSION, "0.9");
	});

	it("prefers an explicit version, then $schema, then the xript field", () => {
		const manifest = { $schema: "https://xript.dev/schema/manifest/v0.7.json", xript: "0.8", name: "p" };
		assert.deepEqual(resolveTargetVersion(manifest, "0.6"), { version: "0.6", source: "option" });
		assert.deepEqual(resolveTargetVersion(manifest), { version: "0.7", source: "$schema" });
		assert.deepEqual(resolveTargetVersion({ xript: "0.8", name: "p" }), { version: "0.8", source: "xript" });
		assert.deepEqual(resolveTargetVersion({ name: "p" }), { version: "0.9", source: "default" });
	});

	it("normalizes a patch or v-prefixed version", () => {
		assert.equal(resolveTargetVersion({}, "0.8.1").version, "0.8");
		assert.equal(resolveTargetVersion({}, "v0.7").version, "0.7");
	});

	it("answers for the current version, with a note, when the manifest names one it does not speak", () => {
		const target = resolveTargetVersion({ xript: "0.3", name: "p" });
		assert.equal(target.version, "0.9");
		assert.equal(target.source, "default");
		assert.match(target.note, /xript 0\.3/);
		assert.match(describeTargetVersion(target), /^xript 0\.9 \(the toolchain default\); /);
	});

	it("refuses an explicit version it does not speak", () => {
		assert.throws(() => resolveTargetVersion({}, "0.5"), UnsupportedVersionError);
	});

	it("loads the frozen schema for an earlier version and the live one for the current", async () => {
		for (const version of SUPPORTED_SPEC_VERSIONS) {
			assert.equal((await loadSpecSchema(version, "manifest")).$id, `https://xript.dev/schema/manifest/v${version}.json`);
			assert.equal((await loadSpecSchema(version, "mod-manifest")).$id, `https://xript.dev/schema/mod-manifest/v${version}.json`);
		}
	});
});

describe("validating against a target version", () => {
	it("rejects a 0.9 feature in a manifest that declares 0.8", async () => {
		const result = await validateManifestVersioned(variadicHost("0.8"));
		assert.equal(result.valid, false);
		assert.deepEqual(result.target, { version: "0.8", source: "xript" });
	});

	it("accepts it when the manifest declares 0.9", async () => {
		const result = await validateManifestVersioned(variadicHost("0.9"));
		assert.equal(result.valid, true, JSON.stringify(result.errors));
	});

	it("lets an explicit version override the declared one", async () => {
		const result = await validateManifestVersioned(variadicHost("0.8"), { version: "0.9" });
		assert.equal(result.valid, true);
		assert.equal(result.target.source, "option");
	});

	it("surfaces the fallback note as a warning", async () => {
		const result = await validateManifestVersioned({ xript: "0.3", name: "p" });
		assert.ok(result.warnings.some((w) => w.keyword === "version-fallback"));
	});

	it("reports an unsupported explicit version as an error result", async () => {
		const result = await validateManifestVersioned({ xript: "0.9", name: "p" }, { version: "0.4" });
		assert.equal(result.valid, false);
		assert.equal(result.errors[0].keyword, "version");
	});

	it("validates a mod manifest against its version", async () => {
		const mod = {
			xript: "0.8",
			name: "m",
			version: "1.0.0",
			entry: { script: "m.js", exports: { go: { description: "Go.", returns: { type: "string", description: "S." } } } },
		};
		assert.equal((await validateManifestVersioned(mod)).valid, false);
		assert.equal((await validateManifestVersioned({ ...mod, xript: "0.9" })).valid, true);
	});

	it("honors the version option and the declared version on a file", async () => {
		const dir = await mkdtemp(join(tmpdir(), "xript-versions-"));
		try {
			const file = join(dir, "host.json");
			await writeFile(file, JSON.stringify(variadicHost("0.8")));
			assert.equal((await validateManifestFile(file)).valid, false);
			const pinned = await validateManifestFile(file, { version: "0.9" });
			assert.equal(pinned.valid, true);
			assert.deepEqual(pinned.target, { version: "0.9", source: "option" });
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
