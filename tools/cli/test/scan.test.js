import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, "fixtures");

let scanModule;
try {
	scanModule = await import("../dist/scan/index.js");
} catch {
	// ts-morph not available — skip scan tests
}

const skipScan = !scanModule;

describe("annotation scanner", { skip: skipScan ? "ts-morph not available" : false }, () => {
	test("scans annotated functions from a directory", async () => {
		const result = await scanModule.scanDirectory(FIXTURES);

		assert.ok(result.bindings.log, "should find top-level 'log' binding");
		assert.ok(result.bindings.data, "should find 'data' namespace");
		assert.ok(result.bindings.player, "should find 'player' namespace");

		const log = result.bindings.log;
		assert.equal(log.description, "Write a message to the application log.");
		assert.equal(log.params.length, 2);
		assert.equal(log.params[0].name, "message");
		assert.equal(log.params[0].type, "string");
		assert.equal(log.params[1].name, "level");
	});

	test("creates namespaces from dotted paths", async () => {
		const result = await scanModule.scanDirectory(FIXTURES);

		const data = result.bindings.data;
		assert.ok(data.members, "data should be a namespace");
		assert.ok(data.members.get, "data.get should exist");
		assert.ok(data.members.set, "data.set should exist");
	});

	test("extracts capabilities", async () => {
		const result = await scanModule.scanDirectory(FIXTURES);

		assert.ok(result.capabilities["read-state"], "should find read-state capability");
		assert.ok(result.capabilities["modify-state"], "should find modify-state capability");

		assert.ok(result.capabilities["read-state"].referencedBy.includes("data.get"));
		assert.ok(result.capabilities["modify-state"].referencedBy.includes("data.set"));
	});

	test("detects async functions", async () => {
		const result = await scanModule.scanDirectory(FIXTURES);

		const dataSet = result.bindings.data.members.set;
		assert.equal(dataSet.async, true, "data.set should be async");
	});

	test("extracts capability from binding", async () => {
		const result = await scanModule.scanDirectory(FIXTURES);

		const dataGet = result.bindings.data.members.get;
		assert.equal(dataGet.capability, "read-state");
	});

	test("extracts deprecated tag", async () => {
		const result = await scanModule.scanDirectory(FIXTURES);

		const getHealth = result.bindings.player.members.getHealth;
		assert.ok(getHealth.deprecated, "should have deprecated field");
		assert.ok(getHealth.deprecated.includes("data.get"), "should include migration path");
	});

	test("ignores non-annotated functions", async () => {
		const result = await scanModule.scanDirectory(FIXTURES);

		assert.ok(!result.bindings.notAnnotated, "should not include notAnnotated");
	});

	test("extracts return types", async () => {
		const result = await scanModule.scanDirectory(FIXTURES);

		const dataGet = result.bindings.data.members.get;
		assert.equal(dataGet.returns, "unknown");

		const getHealth = result.bindings.player.members.getHealth;
		assert.equal(getHealth.returns, "number");
	});

	test("extracts param descriptions", async () => {
		const result = await scanModule.scanDirectory(FIXTURES);

		const dataGet = result.bindings.data.members.get;
		assert.equal(dataGet.params[0].description, "Data path in dot notation");
	});
});

describe("manifest merger", { skip: skipScan ? "ts-morph not available" : false }, () => {
	test("merges scanned bindings into empty manifest", async () => {
		const existing = { xript: "0.4", name: "test-app" };
		const scanned = await scanModule.scanDirectory(FIXTURES);
		const result = await scanModule.mergeIntoManifest(existing, scanned);

		assert.ok(result.manifest.bindings.log);
		assert.ok(result.manifest.bindings.data);
		assert.ok(result.added.length > 0);
		assert.equal(result.removed.length, 0);
	});

	test("preserves existing bindings not in scan", async () => {
		const existing = {
			xript: "0.4",
			name: "test-app",
			bindings: {
				legacy: { description: "a legacy binding" },
			},
		};
		const scanned = await scanModule.scanDirectory(FIXTURES);
		const result = await scanModule.mergeIntoManifest(existing, scanned);

		assert.ok(result.manifest.bindings.legacy, "legacy binding should be preserved");
		assert.ok(result.removed.includes("legacy"), "legacy should be in removed list");
	});

	test("auto-generates capabilities", async () => {
		const existing = { xript: "0.4", name: "test-app" };
		const scanned = await scanModule.scanDirectory(FIXTURES);
		const result = await scanModule.mergeIntoManifest(existing, scanned);

		assert.ok(result.manifest.capabilities["read-state"]);
		assert.ok(result.manifest.capabilities["modify-state"]);
	});

	test("preserves existing capability definitions", async () => {
		const existing = {
			xript: "0.4",
			name: "test-app",
			capabilities: {
				"read-state": { description: "Custom description", risk: "medium" },
			},
		};
		const scanned = await scanModule.scanDirectory(FIXTURES);
		const result = await scanModule.mergeIntoManifest(existing, scanned);

		assert.equal(result.manifest.capabilities["read-state"].description, "Custom description");
		assert.equal(result.manifest.capabilities["read-state"].risk, "medium");
	});

	test("does not mutate the original manifest", async () => {
		const existing = { xript: "0.4", name: "test-app", bindings: {} };
		const scanned = await scanModule.scanDirectory(FIXTURES);
		await scanModule.mergeIntoManifest(existing, scanned);

		assert.deepEqual(existing.bindings, {});
	});

	test("reports capability gaps for capabilities not yet in manifest", async () => {
		const existing = { xript: "0.4", name: "test-app" };
		const scanned = await scanModule.scanDirectory(FIXTURES);
		const result = await scanModule.mergeIntoManifest(existing, scanned);

		assert.ok(result.capabilityGaps.length > 0, "should report gaps for newly discovered capabilities");
		assert.ok(result.capabilityGaps.includes("read-state") || result.capabilityGaps.includes("modify-state"));
	});

	test("does not report gaps for capabilities already in manifest", async () => {
		const existing = {
			xript: "0.4",
			name: "test-app",
			capabilities: {
				"read-state": { description: "read", risk: "low" },
				"modify-state": { description: "modify", risk: "medium" },
			},
		};
		const scanned = await scanModule.scanDirectory(FIXTURES);
		const result = await scanModule.mergeIntoManifest(existing, scanned);

		assert.equal(result.capabilityGaps.length, 0, "no gaps when all caps are pre-defined");
	});
});
