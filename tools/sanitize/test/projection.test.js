import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	BUILTIN_PROFILES,
	canonicalJson,
	compareCodePoints,
	propAttributeValue,
	projectsToHtml,
	resolveFormatProfile,
	sanitizeFragment,
	sanitizeHTML,
} from "../dist/index.js";

describe("structured prop projection", () => {
	it("orders object keys by code point, not UTF-16 unit", () => {
		const privateUse = String.fromCharCode(0xe000);
		assert.equal(compareCodePoints("\u{1F600}", privateUse), 1);
		assert.equal(compareCodePoints(privateUse, "\u{1F600}"), -1);
		assert.equal(compareCodePoints("a", "ab"), -1);
		assert.equal(compareCodePoints("b", "b"), 0);
		assert.equal(
			canonicalJson({ "\u{1F600}": 1, [privateUse]: 2 }),
			`{"${privateUse}":2,"\u{1F600}":1}`,
		);
	});

	it("matches JSON.stringify escaping and number formatting", () => {
		const value = { n: [1e21, 0.1, -5, 1.5e-7], s: `q"\\\b\f\n\r\t\u0001${String.fromCharCode(0x2028)}/<` };
		assert.equal(canonicalJson(value), JSON.stringify(value));
		assert.equal(canonicalJson("\uD800x"), JSON.stringify("\uD800x"));
		assert.equal(canonicalJson("\u{1F600}"), JSON.stringify("\u{1F600}"));
	});

	it("json-encodes objects and object-bearing arrays, keeps scalar arrays comma-joined", () => {
		assert.equal(propAttributeValue({ a: 1 }), "{\"a\":1}");
		assert.equal(propAttributeValue([{ a: 1 }]), "[{\"a\":1}]");
		assert.equal(propAttributeValue([[1, { a: 1 }]]), "[[1,{\"a\":1}]]");
		assert.equal(propAttributeValue([1, null, "x"]), "1,,x");
		assert.equal(propAttributeValue([1, null, "x"], "array"), "[1,null,\"x\"]");
		assert.equal(propAttributeValue([1, 2], ["null", "array"]), "[1,2]");
		assert.equal(propAttributeValue("text", "array"), "text");
		assert.equal(propAttributeValue(3, "object"), "3");
	});
});

describe("svg title and desc", () => {
	it("segments interpolation in an svg title when the fill opts in", () => {
		const result = sanitizeFragment("<svg><title>{{ name }}</title></svg>", BUILTIN_PROFILES["text/html"], { interpolate: true });
		const title = result.tree[0].children[0];
		assert.equal(title.name, "title");
		assert.ok(title.children[0].segments);
	});

	it("keeps an svg title under a host-declared format that speaks html", () => {
		const profile = resolveFormatProfile(
			"application/x-probe",
			{ "application/x-probe": { syntax: "html", vocabularies: ["probe.ui", "html"] } },
			{ "probe.ui": { nodes: { "x-icon": { props: {} } } } },
		);
		const result = sanitizeFragment("<x-icon><svg><title>Close</title></svg></x-icon>", profile);
		assert.equal(result.html, "<x-icon><svg><title>Close</title></svg></x-icon>");
		assert.equal(projectsToHtml(profile), true);
	});

	it("does not treat a title as svg content once the svg has closed", () => {
		assert.equal(sanitizeHTML("<svg></svg><title>x</title><p>y</p>"), "<svg></svg><p>y</p>");
	});

	it("keeps data and aria attributes on an svg title", () => {
		assert.equal(
			sanitizeHTML("<svg><title data-bind=\"label\" aria-hidden=\"true\" lang=\"en\">x</title></svg>"),
			"<svg><title data-bind=\"label\" aria-hidden=\"true\" lang=\"en\">x</title></svg>",
		);
	});
});
