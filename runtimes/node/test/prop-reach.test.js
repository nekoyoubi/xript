import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createFragmentInstance } from "../dist/index.js";

const TREE_FORMAT = "application/x-probe+json";
const HTML_FORMAT = "application/x-probe-html+json";

const formats = {
	[TREE_FORMAT]: {
		syntax: "j5ml",
		nodes: {
			Gauge: { props: { max: { type: "number" } }, children: "none" },
			Meter: { props: { level: { type: "string" } }, children: "none", bindTo: "level" },
			Anchor: { props: { href: { type: "string", sink: "uri" } }, children: "none", bindTo: "href" },
		},
	},
	[HTML_FORMAT]: {
		syntax: "j5ml",
		vocabularies: ["probe.charts", "html"],
	},
};

const vocabularies = {
	"probe.charts": {
		nodes: {
			"x-chart": {
				props: { series: { type: "array" }, config: { type: "object" } },
			},
		},
	},
};

function instance(format, source, bindings) {
	return createFragmentInstance(
		{ id: "probe", slot: "s", format, source: JSON.stringify(source), bindings },
		JSON.stringify(source),
		{ formats, vocabularies },
	);
}

describe("data-bind into a prop the vocabulary does not reach", () => {
	it("reports the dropped write instead of discarding it silently", () => {
		const fragment = instance(TREE_FORMAT, ["Gauge", { "data-bind": "hp", max: 10 }], [{ name: "hp", path: "hp" }]);
		const content = fragment.getContent({ hp: 7 });

		assert.deepEqual(content.tree[0].props, { "data-bind": "hp", max: 10 });
		assert.deepEqual(content.diagnostics, [{
			code: "unknown-prop",
			severity: "warning",
			path: "/0",
			node: "Gauge",
			prop: "value",
			message: "data-bind target \"value\" is not declared on node \"Gauge\"; the bound value was dropped",
		}]);
	});

	it("writes a declared bindTo target with no diagnostic", () => {
		const fragment = instance(TREE_FORMAT, ["Meter", { "data-bind": "lvl" }], [{ name: "lvl", path: "lvl" }]);
		const content = fragment.getContent({ lvl: "high" });

		assert.equal(content.tree[0].props.level, "high");
		assert.deepEqual(content.diagnostics, []);
	});

	it("reports a bound value its sink rejects", () => {
		const fragment = instance(TREE_FORMAT, ["Anchor", { "data-bind": "url" }], [{ name: "url", path: "url" }]);
		const content = fragment.getContent({ url: "javascript:alert(1)" });

		assert.equal(content.tree[0].props.href, undefined);
		assert.equal(content.diagnostics.length, 1);
		assert.equal(content.diagnostics[0].code, "unsafe-prop");
		assert.equal(content.diagnostics[0].prop, "href");
		assert.equal(content.diagnostics[0].node, "Anchor");
	});

	it("keeps the sanitizer's diagnostics ahead of the bind pass's", () => {
		const fragment = instance(TREE_FORMAT, ["Gauge", { "data-bind": "hp", bogus: 1 }], [{ name: "hp", path: "hp" }]);
		const codes = fragment.getContent({ hp: 1 }).diagnostics.map((d) => `${d.code}:${d.prop}`);
		assert.deepEqual(codes, ["unknown-prop:bogus", "unknown-prop:value"]);
	});
});

describe("structured props in the HTML projection", () => {
	it("json-encodes declared array and object props in the html projection", () => {
		const fragment = instance(HTML_FORMAT, ["x-chart", { series: [1, 2], config: { b: 1, a: 2 }, "data-tags": ["x", "y"] }]);

		const expected = "<x-chart series=\"[1,2]\" config=\"{&quot;a&quot;:2,&quot;b&quot;:1}\" data-tags=\"x,y\"></x-chart>";
		assert.equal(fragment.sanitizedSource, expected);
		const content = fragment.getContent({});
		assert.equal(content.contentType, "tree");
		assert.equal(content.html, expected);
		assert.deepEqual(content.tree[0].props.series, [1, 2]);
	});

	it("leaves getContent html empty for a vocabulary with no html projection", () => {
		const fragment = instance(TREE_FORMAT, ["Gauge", { max: 3 }]);
		assert.equal(fragment.getContent({}).html, "");
	});

	it("never projects an object prop as [object Object]", () => {
		const fragment = instance("application/jsml+json", ["div", { "data-state": { open: true } }]);
		assert.equal(fragment.getContent({}).html, "<div data-state=\"{&quot;open&quot;:true}\"></div>");
	});
});
