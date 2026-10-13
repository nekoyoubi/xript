import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fragmentFillFindings, lintManifests, looksLikeMarkup, validateModManifest } from "../dist/index.js";

const host = {
	xript: "0.9",
	name: "host",
	slots: [{ id: "panel", accepts: ["text/html", "application/jsml+json"], multiple: true, description: "A panel." }],
};

function mod(fills) {
	return { xript: "0.9", name: "mod-a", version: "1.0.0", fills };
}

function codes(findings) {
	return findings.map((f) => f.code);
}

describe("fragment fill findings", () => {
	it("flags HTML markup in a non-inline source", () => {
		const findings = fragmentFillFindings([mod({ panel: [{ format: "text/html", source: "<p>x</p>" }] })]);
		assert.deepEqual(codes(findings), ["markup-source-not-inline"]);
		assert.equal(findings[0].severity, "warn");
		assert.match(findings[0].message, /panel-fill-0/);
		assert.match(findings[0].message, /source/);
	});

	it("flags a JSML tree in a non-inline source", () => {
		const findings = fragmentFillFindings([
			mod({ panel: [{ id: "card", format: "application/jsml+json", source: "[\"p\", {}, \"x\"]" }] }),
		]);
		assert.deepEqual(codes(findings), ["markup-source-not-inline"]);
		assert.match(findings[0].message, /card/);
	});

	it("is silent for inline markup and for a file name", () => {
		const findings = fragmentFillFindings([
			mod({
				panel: [
					{ format: "text/html", source: "<p>x</p>", inline: true },
					{ format: "text/html", source: "panel.html" },
				],
			}),
		]);
		assert.deepEqual(findings, []);
	});

	it("is silent when the markup-looking source is a supplied file", () => {
		const findings = fragmentFillFindings(
			[mod({ panel: [{ format: "text/html", source: "<odd-name>" }] })],
			{ "<odd-name>": "<p>x</p>" },
		);
		assert.deepEqual(findings, []);
	});

	it("reports the events alias once per mod", () => {
		const handler = [{ selector: "#a", on: "click", handler: "onA" }];
		const findings = fragmentFillFindings([
			mod({
				panel: [
					{ format: "text/html", source: "<b id=a>a</b>", inline: true, events: handler },
					{ format: "text/html", source: "<b id=b>b</b>", inline: true, events: handler },
				],
			}),
		]);
		assert.deepEqual(codes(findings), ["deprecated-events-alias"]);
		assert.match(findings[0].message, /panel-fill-0/);
	});

	it("reports the events alias on the deprecated fragments surface", () => {
		const findings = fragmentFillFindings([
			{
				xript: "0.9",
				name: "mod-a",
				version: "1.0.0",
				fragments: [{ id: "card", slot: "panel", format: "text/html", source: "<b>a</b>", inline: true, events: [] }],
			},
		]);
		assert.deepEqual(codes(findings), ["deprecated-events-alias"]);
	});

	it("names a host-defined binding field as non-portable, at info", () => {
		const findings = fragmentFillFindings([
			mod({
				panel: [{
					format: "text/html",
					source: "<span data-bind=\"hp\">0</span>",
					inline: true,
					bindings: [{ name: "hp", path: "player.hp", type: "int", transform: "percent" }],
				}],
			}),
		]);
		assert.deepEqual(codes(findings), ["non-portable-binding-field"]);
		assert.equal(findings[0].severity, "info");
		assert.match(findings[0].message, /transform/);
		assert.match(findings[0].message, /"hp"/);
	});

	it("runs as part of lintManifests", () => {
		const result = lintManifests(host, [mod({ panel: [{ format: "text/html", source: "<p>x</p>" }] })]);
		assert.ok(result.findings.some((f) => f.code === "markup-source-not-inline"));
	});

	it("agrees with the runtime corpus about what counts as markup", () => {
		const corpusPath = fileURLToPath(new URL("../../../spec/mod-load-tests.json", import.meta.url));
		const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));
		for (const testCase of corpus.cases) {
			const expected = (testCase.diagnostics ?? []).filter((d) => d.code === "markup-source-not-inline").length;
			const found = fragmentFillFindings([testCase.mod], testCase.sources)
				.filter((f) => f.code === "markup-source-not-inline").length;
			assert.equal(found, expected, testCase.name);
		}
	});

	it("looksLikeMarkup separates content from file names", () => {
		assert.equal(looksLikeMarkup(" <p>x</p>"), true);
		assert.equal(looksLikeMarkup("{\"a\": 1}"), true);
		assert.equal(looksLikeMarkup("panel.html"), false);
		assert.equal(looksLikeMarkup("[not json"), false);
	});
});

describe("mod manifest schema: binding extensions", () => {
	it("accepts a host-defined field on a legacy fragment binding", async () => {
		const result = await validateModManifest({
			xript: "0.9",
			name: "mod-a",
			version: "1.0.0",
			fragments: [{
				id: "card",
				slot: "panel",
				format: "text/html",
				source: "<span data-bind=\"hp\">0</span>",
				inline: true,
				bindings: [{ name: "hp", path: "player.hp", transform: "percent" }],
			}],
		});
		assert.equal(result.valid, true, JSON.stringify(result.errors));
	});
});
