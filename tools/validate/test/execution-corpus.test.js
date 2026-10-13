import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	widenExecutionIntent,
	resolveExecutionIntent,
	declaredExecutionIntent,
	resolveInvokeIntent,
	resolveManifestFile,
	validateManifest,
	validateModManifest,
	lintManifests,
	DURATION_ORDER,
	AFFINITY_ORDER,
	DEFAULT_EXECUTION_INTENT,
} from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const specDir = resolve(__dirname, "../../../spec");

const corpus = JSON.parse(await readFile(resolve(specDir, "execution-tests.json"), "utf-8"));
const hostSchema = JSON.parse(await readFile(resolve(specDir, "manifest.schema.json"), "utf-8"));
const modSchema = JSON.parse(await readFile(resolve(specDir, "mod-manifest.schema.json"), "utf-8"));

describe("execution intent — the schema block", () => {
	it("is byte-identical in the host schema, the mod schema, and the corpus", () => {
		assert.deepEqual(hostSchema.$defs.executionIntent, corpus.schemaBlock);
		assert.deepEqual(modSchema.$defs.executionIntent, corpus.schemaBlock);
		assert.equal(JSON.stringify(hostSchema.$defs.executionIntent), JSON.stringify(modSchema.$defs.executionIntent));
	});

	it("carries no `reentrant` property — reentrancy is a documented host contract, not a manifest field", () => {
		assert.equal("reentrant" in corpus.schemaBlock.properties, false);
		assert.equal("reentrant" in hostSchema.$defs.executionIntent.properties, false);
		assert.equal("reentrant" in modSchema.$defs.executionIntent.properties, false);
	});

	it("is referenced from every surface the spec names", () => {
		assert.equal(hostSchema.properties.execution.$ref, "#/$defs/executionIntent");
		assert.equal(hostSchema.$defs.functionBinding.properties.execution.$ref, "#/$defs/executionIntent");
		assert.equal(hostSchema.$defs.hook.properties.execution.$ref, "#/$defs/executionIntent");
		assert.equal(hostSchema.$defs.slot.properties.execution.$ref, "#/$defs/executionIntent");
		assert.equal(modSchema.$defs.exportDef.properties.execution.$ref, "#/$defs/executionIntent");
		assert.equal(modSchema.properties.execution.$ref, "#/$defs/executionIntent");
	});

	it("keeps the mod schema's `$id` at v0.9 with v0.7 still resolvable as an alias", async () => {
		assert.equal(modSchema.$id, "https://xript.dev/schema/mod-manifest/v0.9.json");
		const pinned = {
			$schema: "https://xript.dev/schema/mod-manifest/v0.7.json",
			xript: "0.8",
			name: "pinned-mod",
			version: "1.0.0",
		};
		const result = await validateModManifest(pinned);
		assert.equal(result.valid, true);
	});

	it("agrees with the corpus on the lattices and the defaults", () => {
		assert.deepEqual([...DURATION_ORDER], corpus.durationOrder);
		assert.deepEqual([...AFFINITY_ORDER], corpus.affinityOrder);
		assert.deepEqual(DEFAULT_EXECUTION_INTENT, corpus.defaults);
	});
});

describe("execution intent — widen", () => {
	for (const testCase of corpus.widen) {
		it(testCase.name, () => {
			assert.deepEqual(widenExecutionIntent(testCase.a, testCase.b), testCase.expected);
		});
	}
});

describe("execution intent — resolution", () => {
	for (const testCase of corpus.resolve) {
		it(testCase.name, () => {
			assert.deepEqual(resolveExecutionIntent(testCase.manifest, testCase.path), testCase.expected);
			const declared = declaredExecutionIntent(testCase.manifest, testCase.path);
			if (testCase.declared === null) {
				assert.equal(declared, undefined);
			} else {
				assert.deepEqual(declared, testCase.declared);
			}
		});
	}

	it("validates every resolution fixture against its own schema", async () => {
		for (const testCase of corpus.resolve) {
			const isMod = typeof testCase.manifest.version === "string" && testCase.path.startsWith("exports/");
			const result = isMod ? await validateModManifest(testCase.manifest) : await validateManifest(testCase.manifest);
			assert.equal(result.valid, true, `${testCase.name}: ${JSON.stringify(result.errors)}`);
		}
	});
});

describe("execution intent — resolution through extends", () => {
	for (const testCase of corpus.extends) {
		it(testCase.name, async () => {
			const dir = await mkdtemp(join(tmpdir(), "xript-execution-"));
			await writeFile(join(dir, "base.json"), JSON.stringify(testCase.base), "utf-8");
			await writeFile(join(dir, "child.json"), JSON.stringify({ ...testCase.child, extends: "./base.json" }), "utf-8");
			const resolved = await resolveManifestFile(join(dir, "child.json"));
			assert.deepEqual(resolveExecutionIntent(resolved, ""), testCase.expected);
		});
	}
});

describe("execution intent — host versus mod precedence", () => {
	for (const testCase of corpus.precedence) {
		it(testCase.name, () => {
			assert.deepEqual(resolveInvokeIntent(testCase.host, testCase.mod, testCase.call), testCase.expected);
		});
	}
});

describe("execution intent — lint", () => {
	for (const testCase of corpus.lint) {
		it(testCase.name, () => {
			const { findings } = lintManifests(testCase.host, testCase.mods ?? []);
			const codes = findings.map((finding) => finding.code);
			for (const expected of testCase.expect ?? []) {
				assert.ok(codes.includes(expected), `expected ${expected}, got ${codes.join(", ")}`);
			}
			for (const forbidden of testCase.forbid ?? []) {
				assert.equal(codes.includes(forbidden), false, `did not expect ${forbidden}`);
			}
		});
	}

	it("never emits an error-severity finding for declared intent — intent is advisory", () => {
		for (const testCase of corpus.lint) {
			const { findings } = lintManifests(testCase.host, testCase.mods ?? []);
			for (const finding of findings) {
				if (!finding.code.startsWith("execution-")) continue;
				assert.notEqual(finding.severity, "error", `${finding.code} must not be an error`);
			}
		}
	});
});
