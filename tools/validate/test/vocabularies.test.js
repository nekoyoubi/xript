import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateManifest, crossValidate, lintManifests, scoreManifests } from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const corpusPath = resolve(__dirname, "../../../spec/fragment-vocabulary-tests.json");
const corpus = JSON.parse(await readFile(corpusPath, "utf-8"));

const components = {
	description: "The shared component set.",
	nodes: {
		"x-panel": {
			description: "A titled container.",
			props: { heading: { type: "string" } },
		},
		"x-link": {
			description: "A navigational link.",
			props: { href: { type: "string", sink: "uri" } },
		},
	},
};

function hostWith(overrides = {}) {
	return {
		xript: "0.8",
		name: "vocabulary-host",
		capabilities: { ui: { description: "Mount UI into a slot." } },
		slots: [
			{
				id: "sidebar",
				accepts: ["application/x-components+json"],
				capability: "ui",
				description: "The left sidebar.",
			},
		],
		vocabularies: { "app.components": components },
		formats: {
			"application/x-components+json": {
				description: "The component vocabulary this host renders.",
				syntax: "j5ml",
				vocabularies: ["app.components"],
			},
		},
		...overrides,
	};
}

const filling = {
	xript: "0.8",
	name: "m",
	version: "1.0.0",
	capabilities: ["ui"],
	fills: { sidebar: [{ format: "application/x-components+json", source: "p.json" }] },
};

function codes(result) {
	return result.findings.map((f) => f.code);
}

describe("vocabularies — schema conformance over the shared corpus", () => {
	for (const testCase of corpus) {
		if (!testCase.formats || Object.keys(testCase.formats).length === 0) continue;
		if (testCase.schemaValid === false) continue;

		it(`admits the fixture for: ${testCase.description}`, async () => {
			const host = {
				xript: "0.8",
				name: "corpus-host",
				slots: [{ id: "s", accepts: [testCase.format], description: "A slot." }],
				formats: testCase.formats,
				...(testCase.vocabularies ? { vocabularies: testCase.vocabularies } : {}),
			};
			const result = await validateManifest(host);
			assert.equal(result.valid, true, JSON.stringify(result.errors));
		});
	}

	it("refuses a format that declares neither nodes nor a non-empty vocabularies array", async () => {
		const result = await validateManifest(
			hostWith({
				formats: { "application/x-components+json": { syntax: "j5ml", vocabularies: [] } },
			}),
		);
		assert.equal(result.valid, false);
	});

	it("refuses a single-segment vocabulary id in the vocabularies block", async () => {
		const result = await validateManifest(hostWith({ vocabularies: { components } }));
		assert.equal(result.valid, false);
	});

	it("refuses a format that still declares the removed 'base' key", async () => {
		const result = await validateManifest(
			hostWith({
				formats: {
					"application/x-components+json": {
						syntax: "j5ml",
						base: "none",
						nodes: { Panel: {} },
					},
				},
			}),
		);
		assert.equal(result.valid, false);
	});
});

describe("vocabularies — crossValidate", () => {
	it("accepts a fill whose nodes a referenced vocabulary declares", async () => {
		const mod = {
			...filling,
			fills: {
				sidebar: [
					{
						format: "application/x-components+json",
						source: JSON.stringify(["x-panel", { heading: "Stats" }]),
						inline: true,
					},
				],
			},
		};
		const result = await crossValidate(hostWith(), mod);
		assert.equal(result.valid, true, JSON.stringify(result.errors));
	});

	it("fails a fill naming a node no vocabulary in scope declares", async () => {
		const mod = {
			...filling,
			fills: {
				sidebar: [
					{
						format: "application/x-components+json",
						source: JSON.stringify(["x-panle", {}]),
						inline: true,
					},
				],
			},
		};
		const result = await crossValidate(hostWith(), mod);
		assert.equal(result.valid, false);
		assert.ok(result.errors.some((e) => /x-panle/.test(e.message)));
	});

	it("reports an unresolvable vocabulary reference against the fill's format", async () => {
		const host = hostWith({
			vocabularies: undefined,
			formats: {
				"application/x-components+json": { syntax: "j5ml", vocabularies: ["app.missing"] },
			},
		});
		const mod = {
			...filling,
			fills: {
				sidebar: [{ format: "application/x-components+json", source: "[]", inline: true }],
			},
		};
		const result = await crossValidate(host, mod);
		assert.equal(result.valid, false);
		assert.ok(result.errors.some((e) => /undeclared vocabulary/.test(e.message)));
	});
});

describe("vocabularies — lint", () => {
	it("stays quiet on a well-formed shared vocabulary", () => {
		const result = lintManifests(hostWith(), [filling]);
		assert.equal(result.counts.error, 0, JSON.stringify(result.findings));
		assert.ok(!codes(result).includes("dead-vocabulary"));
		assert.ok(!codes(result).includes("undescribed-vocabulary"));
	});

	it("runs the node-level checks over a referenced vocabulary, not just inline nodes", () => {
		const result = lintManifests(
			hostWith({
				vocabularies: {
					"app.components": {
						...components,
						nodes: {
							...components.nodes,
							"x-button": { description: "A button.", props: { onClick: { type: "string" } } },
							"x-icon": { description: "An icon.", props: { svg: { type: "object", sink: "html" } } },
							"x-gauge": { description: "A gauge.", bindTo: "amount", props: { value: { type: "number" } } },
						},
					},
				},
			}),
			[filling],
		);
		assert.ok(codes(result).includes("prop-name-reserved"));
		assert.ok(codes(result).includes("sink-requires-string"));
		assert.ok(codes(result).includes("bind-target-undeclared"));
	});

	it("reports a shared vocabulary's node findings once, not once per format", () => {
		const result = lintManifests(
			hostWith({
				slots: [
					{
						id: "sidebar",
						accepts: ["application/x-components+json", "application/x-components+html"],
						capability: "ui",
						description: "The left sidebar.",
					},
				],
				vocabularies: {
					"app.components": {
						...components,
						nodes: { "x-button": { description: "A button.", props: { onClick: { type: "string" } } } },
					},
				},
				formats: {
					"application/x-components+json": {
						description: "The J5ML spelling.",
						syntax: "j5ml",
						vocabularies: ["app.components"],
					},
					"application/x-components+html": {
						description: "The HTML spelling.",
						syntax: "html",
						vocabularies: ["app.components", "html"],
					},
				},
			}),
			[filling],
		);
		assert.equal(codes(result).filter((c) => c === "prop-name-reserved").length, 1);
	});

	it("warns on a declared vocabulary no format brings into scope", () => {
		const result = lintManifests(
			hostWith({
				vocabularies: { "app.components": components, "app.unused": { description: "Unused.", nodes: { "x-ghost": { description: "A ghost." } } } },
			}),
			[filling],
		);
		assert.ok(codes(result).includes("dead-vocabulary"));
	});

	it("stays quiet on an inherited vocabulary no local format brings into scope", () => {
		const result = lintManifests(
			hostWith({
				vocabularies: { "app.components": components, "app.unused": { description: "Unused.", nodes: { "x-ghost": { description: "A ghost." } } } },
			}),
			[filling],
			{ inheritedVocabularies: ["app.unused"] },
		);
		assert.ok(!codes(result).includes("dead-vocabulary"));
	});

	it("errors on a format referencing a vocabulary the host does not declare", () => {
		const result = lintManifests(
			hostWith({
				formats: {
					"application/x-components+json": {
						description: "Components.",
						syntax: "j5ml",
						vocabularies: ["app.missing"],
					},
				},
			}),
			[filling],
		);
		assert.ok(codes(result).includes("unknown-vocabulary"));
	});

	it("errors on a format whose scope refuses to resolve", () => {
		const result = lintManifests(
			hostWith({
				formats: {
					"application/x-components+json": {
						description: "Components.",
						syntax: "j5ml",
						vocabularies: ["html", "app.components"],
					},
				},
			}),
			[filling],
		);
		assert.ok(codes(result).includes("invalid-format-scope"));
	});

	it("notes a vocabulary shadowed by an earlier one in the same scope", () => {
		const result = lintManifests(
			hostWith({
				vocabularies: {
					"app.components": components,
					"app.overrides": { description: "Overrides.", nodes: { "x-panel": { description: "A different panel." } } },
				},
				formats: {
					"application/x-components+json": {
						description: "Components.",
						syntax: "j5ml",
						vocabularies: ["app.components", "app.overrides"],
					},
				},
			}),
			[filling],
		);
		assert.ok(codes(result).includes("vocabulary-node-shadowed"));
	});

	it("notes a vocabulary declaring an always-stripped name while html is out of scope", () => {
		const result = lintManifests(
			hostWith({
				vocabularies: {
					"app.components": { description: "Components.", nodes: { script: { description: "Not an HTML script." } } },
				},
			}),
			[filling],
		);
		assert.ok(codes(result).includes("stripped-name-shadowed"));
	});

	it("notes an undescribed vocabulary", () => {
		const result = lintManifests(
			hostWith({ vocabularies: { "app.components": { nodes: components.nodes } } }),
			[filling],
		);
		assert.ok(codes(result).includes("undescribed-vocabulary"));
	});
});

describe("vocabularies — score", () => {
	it("counts a vocabulary shared by two formats once", async () => {
		const shared = await scoreManifests(
			hostWith({
				slots: [
					{
						id: "sidebar",
						accepts: ["application/x-components+json", "application/x-components+html"],
						capability: "ui",
						description: "The left sidebar.",
					},
				],
				formats: {
					"application/x-components+json": { description: "J5ML.", syntax: "j5ml", vocabularies: ["app.components"] },
					"application/x-components+html": { description: "HTML.", syntax: "html", vocabularies: ["app.components", "html"] },
				},
			}),
			[],
		);
		assert.equal(shared.formats.nodes, 2);
		assert.deepEqual(shared.formats.vocabularies, ["app.components"]);
		assert.deepEqual(shared.formats.vocabulariesUnreachable, []);
	});

	it("counts a vocabulary no reachable format brings into scope as zero", async () => {
		const result = await scoreManifests(
			hostWith({
				vocabularies: {
					"app.components": components,
					"app.unused": { description: "Unused.", nodes: { "x-ghost": { description: "A ghost." } } },
				},
			}),
			[],
		);
		assert.equal(result.formats.nodes, 2);
		assert.deepEqual(result.formats.vocabulariesUnreachable, ["app.unused"]);
	});

	it("counts inline nodes alongside a referenced vocabulary", async () => {
		const result = await scoreManifests(
			hostWith({
				formats: {
					"application/x-components+json": {
						description: "Components.",
						syntax: "j5ml",
						vocabularies: ["app.components"],
						nodes: { "x-extra": { description: "An inline extra." } },
					},
				},
			}),
			[],
		);
		assert.equal(result.formats.nodes, 3);
	});
});
