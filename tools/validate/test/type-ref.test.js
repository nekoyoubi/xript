import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
	lintManifests,
	nonCanonicalSpellings,
	parseTypeRef,
	typeRefNames,
	typeRefToMarkdown,
	typeRefToTypeScript,
	validateManifest,
	validateModManifest,
} from "../dist/index.js";

const corpus = JSON.parse(readFileSync(new URL("../../../spec/type-ref-tests.json", import.meta.url), "utf-8"));

describe("typeRef corpus (shared renderer)", () => {
	for (const testCase of corpus.cases) {
		it(testCase.name, () => {
			assert.equal(typeRefToTypeScript(testCase.ref), testCase.typescript);
			assert.equal(typeRefToMarkdown(testCase.ref), testCase.markdown);
			const words = [...new Set(nonCanonicalSpellings(testCase.ref).map((s) => s.word))];
			assert.deepEqual(words.sort(), [...(testCase.canonical ?? [])].sort());
		});
	}
});

describe("typeRef string grammar", () => {
	it("parses [] tighter than |", () => {
		assert.deepEqual(parseTypeRef("string | number[]"), {
			kind: "union",
			members: [
				{ kind: "name", name: "string" },
				{ kind: "array", element: { kind: "name", name: "number" } },
			],
		});
	});

	it("keeps a string outside the grammar as one opaque name", () => {
		assert.deepEqual(parseTypeRef("Record<string, Player>"), { kind: "name", name: "Record<string, Player>" });
		assert.equal(typeRefToTypeScript("Record<string, Player>"), "Record<string, Player>");
	});

	it("names only custom types, after type words resolve", () => {
		assert.deepEqual([...typeRefNames("int | Player[] | object | function")], ["Player"]);
	});
});

describe("lint on type spellings", () => {
	const host = (bindings) => ({ xript: "0.9", name: "h", bindings });

	it("does not report an accepted type word as an undeclared type", () => {
		const { findings } = lintManifests(host({ f: { description: "F.", params: [{ name: "a", type: "int" }, { name: "b", type: "string | bool[]" }], returns: "array" } }));
		assert.equal(findings.filter((f) => f.code === "undeclared-type").length, 0);
	});

	it("suggests the canonical spelling for an alias type word", () => {
		const { findings } = lintManifests(host({ f: { description: "F.", params: [{ name: "a", type: "int" }] } }));
		const finding = findings.find((f) => f.code === "noncanonical-type-spelling");
		assert.ok(finding);
		assert.equal(finding.severity, "info");
		assert.match(finding.suggestion, /`number`/);
	});

	it("flags a loose type word with a suggestion to name its elements", () => {
		const { findings } = lintManifests(host({ f: { description: "F.", params: [], returns: { type: "object", description: "D." } } }));
		const finding = findings.find((f) => f.code === "loose-type-word");
		assert.ok(finding);
		assert.match(finding.message, /binding "f" return/);
	});

	it("suggests the object form for the ? suffix", () => {
		const { findings } = lintManifests(host({ f: { description: "F.", params: [{ name: "a", type: "Player?" }] } }));
		assert.ok(findings.find((f) => f.code === "noncanonical-type-spelling" && /optional/.test(f.suggestion)));
	});

	it("suggests required over the optional alias", () => {
		const { findings } = lintManifests(host({ f: { description: "F.", params: [{ name: "a", type: "string", optional: true }] } }));
		const finding = findings.find((f) => f.code === "param-optional-alias");
		assert.ok(finding);
		assert.match(finding.suggestion, /"required": false/);
	});

	it("still reports a misspelled custom type as undeclared", () => {
		const { findings } = lintManifests(host({ f: { description: "F.", params: [{ name: "a", type: "string | Plyer[]" }] } }));
		assert.ok(findings.find((f) => f.code === "undeclared-type" && /"Plyer"/.test(f.message)));
	});
});

describe("parameter shape", () => {
	const host = (params, returns) => ({ xript: "0.9", name: "h", bindings: { f: { description: "F.", params, ...(returns ? { returns } : {}) } } });

	it("accepts a variadic last parameter", async () => {
		const result = await validateManifest(host([{ name: "a", type: "string" }, { name: "rest", type: "number", variadic: true }]));
		assert.equal(result.valid, true, JSON.stringify(result.errors));
	});

	it("rejects a variadic parameter that is not last", async () => {
		const result = await validateManifest(host([{ name: "rest", type: "number", variadic: true }, { name: "a", type: "string" }]));
		assert.equal(result.valid, false);
		assert.equal(result.errors[0].keyword, "variadic-position");
		assert.equal(result.errors[0].path, "/bindings/f/params/0/variadic");
	});

	it("checks variadic position inside namespaces and hooks", async () => {
		const result = await validateManifest({
			xript: "0.9",
			name: "h",
			bindings: { ns: { description: "N.", members: { g: { description: "G.", params: [{ name: "r", type: "string", variadic: true }, { name: "x", type: "string" }] } } } },
			hooks: { tick: { description: "T.", params: [{ name: "r", type: "string", variadic: true }, { name: "x", type: "string" }] } },
		});
		assert.deepEqual(result.errors.map((e) => e.path), ["/bindings/ns/members/g/params/0/variadic", "/hooks/tick/params/0/variadic"]);
	});

	it("accepts optional as the inverse alias of required", async () => {
		assert.equal((await validateManifest(host([{ name: "a", type: "string", optional: true }]))).valid, true);
		assert.equal((await validateManifest(host([{ name: "a", type: "string", optional: true, required: false }]))).valid, true);
	});

	it("rejects optional and required that disagree", async () => {
		const result = await validateManifest(host([{ name: "a", type: "string", optional: true, required: true }]));
		assert.equal(result.valid, false);
		assert.equal(result.errors[0].keyword, "optional-required-conflict");
	});

	it("accepts the { type, description } return form and keeps the string form", async () => {
		assert.equal((await validateManifest(host([], { type: "string", description: "The name." }))).valid, true);
		assert.equal((await validateManifest(host([], "string"))).valid, true);
		assert.equal((await validateManifest(host([], { type: "string", note: "x" }))).valid, false);
	});

	it("applies the same rules to mod exports", async () => {
		const mod = {
			xript: "0.9",
			name: "m",
			version: "1.0.0",
			entry: {
				script: "m.js",
				format: "module",
				exports: {
					go: {
						description: "Go.",
						params: [{ name: "r", type: "string", variadic: true }, { name: "x", type: "string" }],
						returns: { type: "number", description: "N." },
					},
				},
			},
		};
		const result = await validateModManifest(mod);
		assert.deepEqual(result.errors.map((e) => e.keyword), ["variadic-position"]);
	});
});
