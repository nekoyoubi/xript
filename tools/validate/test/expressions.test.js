import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { analyzeExpressions, fragmentReadNames, lintManifests } from "../dist/index.js";

function mod(fill) {
	return {
		name: "demo",
		fills: {
			"header.status": [{
				id: "status-line",
				format: "text/html",
				inline: true,
				...fill,
			}],
		},
	};
}

function codes(findings) {
	return findings.map((finding) => finding.code);
}

describe("expressions analyzer", () => {
	it("accepts a fill whose expressions all resolve", () => {
		const findings = analyzeExpressions([mod({
			source: '<p data-if="hp < maxHp"><span data-bind="round(hp / maxHp * 100)">0</span>%</p>',
			bindings: [{ name: "hp", path: "p.hp" }, { name: "maxHp", path: "p.max" }],
		})]);
		assert.deepEqual(findings, []);
	});

	it("reports an identifier no binding declares, and names the ones that exist", () => {
		const findings = analyzeExpressions([mod({
			source: '<p data-if="hpp < 50">low</p>',
			bindings: [{ name: "hp", path: "p.hp" }],
		})]);
		assert.deepEqual(codes(findings), ["expression-unknown-binding", "expression-unused-binding"]);
		assert.match(findings[0].suggestion, /hp/);
	});

	it("reports an unparseable expression as an error", () => {
		const findings = analyzeExpressions([mod({
			source: '<p data-if="hp = 1">x</p>',
			bindings: [{ name: "hp", path: "p.hp" }],
		})]);
		assert.equal(codes(findings)[0], "expression-invalid");
		assert.match(findings[0].message, /data-if/);
	});

	it("reports a host-global reach as an invalid expression, not as a missing binding", () => {
		const findings = analyzeExpressions([mod({
			source: '<p data-if="fetch(\'https://x\')">x</p>',
			bindings: [],
		})]);
		assert.equal(codes(findings)[0], "expression-invalid");
	});

	it("reports a write-back handler bound to a computed data-bind", () => {
		const findings = analyzeExpressions([mod({
			source: '<input id="pct" data-bind="round(hp / maxHp * 100)" />',
			bindings: [{ name: "hp", path: "p.hp" }, { name: "maxHp", path: "p.max" }],
			handlers: [{ selector: "#pct", on: "input", handler: "onEdit" }],
		})]);
		assert.ok(codes(findings).includes("expression-readonly-writeback"));
	});

	it("leaves a write-back handler on a bare name alone", () => {
		const findings = analyzeExpressions([mod({
			source: '<input id="hp" data-bind="hp" />',
			bindings: [{ name: "hp", path: "p.hp" }],
			handlers: [{ selector: "#hp", on: "input", handler: "onEdit" }],
		})]);
		assert.deepEqual(findings, []);
	});

	it("reports a declared binding nothing reads", () => {
		const findings = analyzeExpressions([mod({
			source: '<p data-bind="hp">0</p>',
			bindings: [{ name: "hp", path: "p.hp" }, { name: "unused", path: "p.x" }],
		})]);
		assert.deepEqual(codes(findings), ["expression-unused-binding"]);
		assert.match(findings[0].message, /"unused"/);
	});

	it("reads interpolation sites when the fill opts in", () => {
		const findings = analyzeExpressions([mod({
			source: "<p>{{ hpp }}</p>",
			interpolate: true,
			bindings: [{ name: "hp", path: "p.hp" }],
		})]);
		assert.equal(codes(findings)[0], "expression-unknown-binding");
	});

	it("flags a well-formed site in a fill that never turned interpolation on", () => {
		const findings = analyzeExpressions([mod({
			source: "<p>{{ hp }}</p>",
			bindings: [{ name: "hp", path: "p.hp" }],
		})]);
		assert.ok(codes(findings).includes("expression-dormant-site"));
	});

	it("stays quiet on prose that merely opens a delimiter", () => {
		const findings = analyzeExpressions([mod({
			source: "<p>Handlebars uses {{ as an opener.</p>",
			bindings: [],
		})]);
		assert.deepEqual(findings, []);
	});

	it("skips a fill whose source it has not been given", () => {
		const findings = analyzeExpressions([{
			name: "demo",
			fills: { s: [{ id: "f", format: "text/html", source: "frag.html", bindings: [] }] },
		}]);
		assert.deepEqual(findings, []);
	});

	it("reads a file-backed fill when the source is supplied", () => {
		const findings = analyzeExpressions(
			[{
				name: "demo",
				fills: { s: [{ id: "f", format: "text/html", source: "frag.html", bindings: [] }] },
			}],
			{ fragmentSources: { "frag.html": '<p data-if="nope">x</p>' } },
		);
		assert.equal(codes(findings)[0], "expression-unknown-binding");
	});

	it("reports arithmetic on a non-numeric binding when types are known", () => {
		const findings = analyzeExpressions(
			[mod({
				source: '<p data-bind="name * 2">0</p>',
				bindings: [{ name: "name", path: "p.name" }],
			})],
			{ bindingTypes: { "status-line": { name: "string" } } },
		);
		assert.ok(codes(findings).includes("expression-type"));
	});

	it("reports member access on a scalar when types are known", () => {
		const findings = analyzeExpressions(
			[mod({
				source: '<p data-bind="hp.value">0</p>',
				bindings: [{ name: "hp", path: "p.hp" }],
			})],
			{ bindingTypes: { "status-line": { hp: "number" } } },
		);
		assert.ok(codes(findings).includes("expression-type"));
	});

	it("warns on a comparison between disjoint types", () => {
		const findings = analyzeExpressions(
			[mod({
				source: '<p data-if="name < hp">x</p>',
				bindings: [{ name: "name", path: "p.n" }, { name: "hp", path: "p.hp" }],
			})],
			{ bindingTypes: { "status-line": { name: "string", hp: "number" } } },
		);
		const typeFinding = findings.find((finding) => finding.code === "expression-type");
		assert.equal(typeFinding.severity, "warn");
	});

	it("stays silent on type checks when no types are supplied", () => {
		const findings = analyzeExpressions([mod({
			source: '<p data-bind="name * 2">0</p>',
			bindings: [{ name: "name", path: "p.name" }],
		})]);
		assert.deepEqual(findings, []);
	});
});

describe("lint wiring", () => {
	const host = {
		name: "host",
		slots: [{ id: "header.status", accepts: ["text/html"] }],
	};

	it("surfaces expression findings through lintManifests", () => {
		const result = lintManifests(host, [mod({
			source: '<p data-if="hpp < 50">x</p>',
			bindings: [{ name: "hp", path: "p.hp" }],
		})]);
		assert.ok(result.findings.some((finding) => finding.code === "expression-unknown-binding"));
		assert.ok(result.counts.error > 0);
	});

	it("a clean mod adds no expression findings", () => {
		const result = lintManifests(host, [mod({
			source: '<p data-if="hp < 50">x</p>',
			bindings: [{ name: "hp", path: "p.hp" }],
		})]);
		assert.deepEqual(
			result.findings.filter((finding) => finding.code.startsWith("expression-")),
			[],
		);
	});
});

describe("expressions analyzer: data-each", () => {
	it("puts the item, the index name, and $index in scope inside the template", () => {
		const findings = analyzeExpressions([mod({
			source: '<ul><li data-each="(row, i) in rows" data-key="row.id" data-if="row.alive"><b data-bind="i + $index"></b>{{ row.name }}</li></ul>',
			interpolate: true,
			bindings: [{ name: "rows", path: "party" }],
		})]);
		assert.deepEqual(findings, []);
	});

	it("evaluates the header in the enclosing scope, not its own", () => {
		const findings = analyzeExpressions([mod({
			source: '<li data-each="row in row.children" data-bind="row"></li>',
			bindings: [],
		})]);
		assert.deepEqual(codes(findings), ["expression-unknown-binding"]);
		assert.match(findings[0].message, /"row"/);
	});

	it("keeps a repeat name out of scope after the template", () => {
		const findings = analyzeExpressions([mod({
			source: '<li data-each="row in rows" data-bind="row"></li><p data-bind="row"></p>',
			bindings: [{ name: "rows", path: "party" }],
		})]);
		assert.deepEqual(codes(findings), ["expression-unknown-binding"]);
		assert.match(findings[0].message, /\/1/);
	});

	it("scopes nested repeats", () => {
		const findings = analyzeExpressions([mod({
			source: '<div data-each="row in grid"><i data-each="cell in row" data-bind="cell + $index"></i></div>',
			bindings: [{ name: "grid", path: "g" }],
		})]);
		assert.deepEqual(findings, []);
	});

	it("does not count a shadowing item as a read of the binding it shadows", () => {
		const findings = analyzeExpressions([mod({
			source: '<li data-each="item in items" data-bind="item"></li>',
			bindings: [{ name: "items", path: "list" }, { name: "item", path: "one" }],
		})]);
		assert.deepEqual(codes(findings), ["expression-unused-binding"]);
	});

	it("reports a malformed header as an invalid expression", () => {
		const findings = analyzeExpressions([mod({
			source: '<li data-each="item of items"></li>',
			bindings: [{ name: "items", path: "list" }],
		})]);
		assert.equal(codes(findings)[0], "expression-invalid");
		assert.match(findings[0].message, /data-each/);
	});

	it("warns on a data-key with no data-each", () => {
		const findings = analyzeExpressions([mod({
			source: '<li data-key="id"></li>',
			bindings: [],
		})]);
		assert.deepEqual(codes(findings), ["expression-orphan-key"]);
	});

	it("refuses write-back to a repeat item, which has no binding path", () => {
		const findings = analyzeExpressions([mod({
			source: '<div data-each="name in names"><input id="n" data-bind="name" /></div>',
			bindings: [{ name: "names", path: "list" }],
			handlers: [{ selector: "#n", on: "input", handler: "onName" }],
		})]);
		assert.deepEqual(codes(findings), ["expression-readonly-writeback"]);
	});
});

describe("fragmentReadNames", () => {
	it("lists every free name in first-read order, minus repeat-scoped names", () => {
		const source = '<p data-if="hp < max"><span data-bind="name"></span></p><li data-each="(m, i) in party" data-key="m">{{ i }} {{ m }} {{ title }}</li>';
		assert.deepEqual(fragmentReadNames(source, "text/html", { interpolate: true }), ["hp", "max", "name", "party", "title"]);
	});

	it("skips {{ }} unless the fill interpolates", () => {
		assert.deepEqual(fragmentReadNames("<p>{{ greeting }}</p>", "text/html"), []);
	});

	it("reads j5ml sources", () => {
		const source = JSON.stringify(["div", { "data-bind": "score" }]);
		assert.deepEqual(fragmentReadNames(source, "application/j5ml+json"), ["score"]);
	});

	it("returns nothing for an unknown format or an unparseable expression", () => {
		assert.deepEqual(fragmentReadNames('<p data-bind="x"></p>', "text/x-unknown"), []);
		assert.deepEqual(fragmentReadNames('<p data-if="a +"></p><p data-bind="b"></p>', "text/html"), ["b"]);
	});
});
