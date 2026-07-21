import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { lintManifests, resolveProvenance, validateManifest } from "../dist/index.js";

const formatId = "application/x-widgets+json";

function hostWith(schemes) {
	return {
		xript: "0.8",
		name: "widget-host",
		capabilities: { ui: { description: "Mount UI into a slot." } },
		slots: [
			{ id: "sidebar", accepts: [formatId], capability: "ui", description: "The left sidebar." },
		],
		formats: {
			[formatId]: {
				description: "The widget vocabulary this host renders.",
				syntax: "j5ml",
				...(schemes === undefined ? {} : { schemes }),
				nodes: {
					Link: {
						description: "A navigational link.",
						props: { href: { type: "string", sink: "uri" } },
					},
				},
			},
		},
	};
}

const filling = {
	xript: "0.8",
	name: "m",
	version: "1.0.0",
	capabilities: ["ui"],
	fills: { sidebar: [{ format: formatId, source: "p.json" }] },
};

const codes = (result) => result.findings.map((f) => f.code);

describe("schemes — lint", () => {
	it("stays quiet on a well-formed scheme list", () => {
		const result = lintManifests(hostWith(["https", "tauri"]), [filling]);
		assert.equal(result.counts.error, 0, JSON.stringify(result.findings));
		assert.ok(!codes(result).includes("closed-schemes"));
	});

	it("stays quiet when the format declares no schemes at all", () => {
		const result = lintManifests(hostWith(undefined), [filling]);
		assert.ok(!codes(result).includes("closed-schemes"));
		assert.ok(!codes(result).includes("invalid-schemes"));
	});

	for (const prohibited of ["javascript", "vbscript", "JavaScript"]) {
		it(`errors on a declared "${prohibited}"`, () => {
			const result = lintManifests(hostWith(["https", prohibited]), [filling]);
			assert.ok(codes(result).includes("prohibited-scheme"), JSON.stringify(result.findings));
			assert.equal(
				result.findings.find((f) => f.code === "prohibited-scheme").severity,
				"error",
			);
		});
	}

	for (const malformed of [["https:"], ["ht tp"], "https", [7]]) {
		it(`errors on a malformed list ${JSON.stringify(malformed)}`, () => {
			const result = lintManifests(hostWith(malformed), [filling]);
			assert.ok(codes(result).includes("invalid-schemes"), JSON.stringify(result.findings));
		});
	}

	it("notes an empty list as deliberate closure rather than an error", () => {
		const result = lintManifests(hostWith([]), [filling]);
		const finding = result.findings.find((f) => f.code === "closed-schemes");
		assert.ok(finding, JSON.stringify(result.findings));
		assert.equal(finding.severity, "info");
		assert.equal(result.counts.error, 0, JSON.stringify(result.findings));
	});
});

describe("schemes — extends", () => {
	let tmpDir;

	before(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "xript-schemes-"));
	});

	after(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	async function refine(baseSchemes, childSchemes) {
		const basePath = join(tmpDir, `base-${Math.random().toString(36).slice(2)}.json`);
		await writeFile(basePath, JSON.stringify(hostWith(baseSchemes)), "utf-8");
		const child = {
			xript: "0.8",
			name: "child-host",
			extends: basePath,
			formats: {
				[formatId]: {
					refines: true,
					syntax: "j5ml",
					...(childSchemes === undefined ? {} : { schemes: childSchemes }),
				},
			},
		};
		const { resolved } = await resolveProvenance(child, tmpDir);
		return resolved.formats[formatId].schemes;
	}

	it("inherits the base list when the child declares none", async () => {
		assert.deepEqual(await refine(["https", "tauri"], undefined), ["https", "tauri"]);
	});

	it("replaces the base list wholesale when the child declares one", async () => {
		assert.deepEqual(await refine(["https", "tauri"], ["mailto"]), ["mailto"]);
	});

	it("lets a child narrow to deliberate closure", async () => {
		assert.deepEqual(await refine(["https", "tauri"], []), []);
	});

	it("lets a child widen a base that declared none", async () => {
		assert.deepEqual(await refine(undefined, ["https", "tauri"]), ["https", "tauri"]);
	});

	it("resolves a refined scheme list into a manifest that still validates", async () => {
		const basePath = join(tmpDir, "base-valid.json");
		await writeFile(basePath, JSON.stringify(hostWith(["https"])), "utf-8");
		const child = {
			xript: "0.8",
			name: "child-host",
			extends: basePath,
			formats: { [formatId]: { refines: true, syntax: "j5ml", schemes: ["https", "tauri"] } },
		};
		const { resolved } = await resolveProvenance(child, tmpDir);
		const result = await validateManifest(resolved);
		assert.equal(result.valid, true, JSON.stringify(result.errors));
	});
});

describe("schemes — schema", () => {
	it("accepts a well-formed list", async () => {
		const result = await validateManifest(hostWith(["http", "https", "mailto", "data", "tauri"]));
		assert.equal(result.valid, true, JSON.stringify(result.errors));
	});

	it("rejects javascript and vbscript at the schema level", async () => {
		for (const prohibited of ["javascript", "vbscript"]) {
			const result = await validateManifest(hostWith([prohibited]));
			assert.equal(result.valid, false, prohibited);
		}
	});

	it("rejects a scheme carrying a colon or uppercase", async () => {
		for (const malformed of ["https:", "HTTPS", "ht tp", ""]) {
			const result = await validateManifest(hostWith([malformed]));
			assert.equal(result.valid, false, JSON.stringify(malformed));
		}
	});

	it("accepts an empty list", async () => {
		const result = await validateManifest(hostWith([]));
		assert.equal(result.valid, true, JSON.stringify(result.errors));
	});
});
