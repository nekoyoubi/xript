import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizeHTML, sanitizeHTMLDetailed, validateFragment } from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const conformancePath = resolve(__dirname, "../../../spec/sanitizer-tests.json");
const conformanceTests = JSON.parse(await readFile(conformancePath, "utf-8"));

describe("sanitizer conformance suite", () => {
	for (const testCase of conformanceTests) {
		it(testCase.description, () => {
			const result = sanitizeHTML(testCase.input);
			assert.equal(result, testCase.expected);
		});
	}
});

describe("sanitizeHTMLDetailed", () => {
	it("reports stripped elements", () => {
		const result = sanitizeHTMLDetailed("<script>evil()</script><p>safe</p>");
		assert.equal(result.html, "<p>safe</p>");
		assert.ok(result.strippedElements.includes("script"));
	});

	it("reports stripped attributes", () => {
		const result = sanitizeHTMLDetailed('<div onclick="evil()">text</div>');
		assert.equal(result.html, "<div>text</div>");
		assert.ok(result.strippedAttributes.some(a => a.attribute === "onclick"));
	});

	it("returns empty arrays when nothing is stripped", () => {
		const result = sanitizeHTMLDetailed("<p>clean</p>");
		assert.equal(result.html, "<p>clean</p>");
		assert.equal(result.strippedElements.length, 0);
		assert.equal(result.strippedAttributes.length, 0);
	});
});

describe("validateFragment", () => {
	it("returns valid for clean fragment", () => {
		const result = validateFragment('<div data-bind="health">0</div>');
		assert.equal(result.valid, true);
		assert.equal(result.errors.length, 0);
	});

	it("returns invalid for dangerous fragment", () => {
		const result = validateFragment('<script>alert("xss")</script><p>text</p>');
		assert.equal(result.valid, false);
		assert.ok(result.errors.length > 0);
		assert.ok(result.errors[0].message.includes("script"));
	});

	it("returns sanitized content", () => {
		const result = validateFragment('<div onclick="evil()">text</div>');
		assert.equal(result.sanitized, "<div>text</div>");
	});

	it("rejects unsupported formats", () => {
		const result = validateFragment("<div>text</div>", "text/xml");
		assert.equal(result.valid, false);
		assert.ok(result.errors[0].message.includes("unsupported"));
	});
});

describe("edge cases", () => {
	it("handles nested stripped elements", () => {
		const result = sanitizeHTML("<script><script>double</script></script><p>safe</p>");
		assert.equal(result, "<p>safe</p>");
	});

	it("handles unclosed tags gracefully", () => {
		const result = sanitizeHTML("<p>unclosed");
		assert.equal(result, "<p>unclosed");
	});

	it("handles self-closing syntax on non-void elements", () => {
		const result = sanitizeHTML("<div />");
		assert.ok(result.includes("div"));
	});

	it("handles mixed case tag names", () => {
		const result = sanitizeHTML("<DIV class=\"test\">text</DIV>");
		assert.equal(result, '<div class="test">text</div>');
	});

	it("handles mixed case attribute names", () => {
		const result = sanitizeHTML('<div onClick="evil()">text</div>');
		assert.equal(result, "<div>text</div>");
	});

	it("preserves entities in text content", () => {
		const result = sanitizeHTML("<p>&amp; &lt; &gt;</p>");
		assert.equal(result, "<p>&amp; &lt; &gt;</p>");
	});

	it("handles boolean attributes", () => {
		const result = sanitizeHTML("<input disabled hidden />");
		assert.ok(result.includes("disabled"));
		assert.ok(result.includes("hidden"));
	});

	it("strips form elements but not their text siblings", () => {
		const result = sanitizeHTML("before<form><input /></form>after");
		assert.equal(result, "beforeafter");
	});
});

describe("JSML", () => {
	it("converts simple JSML to HTML", async () => {
		const { jsmlToHtml } = await import("../dist/jsml.js");
		const result = jsmlToHtml([["div", { class: "panel" }, "hello"]]);
		assert.equal(result, '<div class="panel">hello</div>');
	});

	it("handles nested elements", async () => {
		const { jsmlToHtml } = await import("../dist/jsml.js");
		const result = jsmlToHtml([
			["div", { class: "panel" },
				["span", { "data-bind": "health" }, "0"],
				" / ",
				["span", { "data-bind": "maxHealth" }, "0"],
			],
		]);
		assert.ok(result.includes('<span data-bind="health">0</span>'));
		assert.ok(result.includes(" / "));
		assert.ok(result.includes('<span data-bind="maxHealth">0</span>'));
	});

	it("handles void elements", async () => {
		const { jsmlToHtml } = await import("../dist/jsml.js");
		const result = jsmlToHtml([["br"], ["img", { src: "icon.png", alt: "icon" }]]);
		assert.ok(result.includes("<br />"));
		assert.ok(result.includes('src="icon.png"'));
	});

	it("handles elements without attributes", async () => {
		const { jsmlToHtml } = await import("../dist/jsml.js");
		const result = jsmlToHtml([["p", "just text"]]);
		assert.equal(result, "<p>just text</p>");
	});

	it("preserves data-bind and data-if attributes", async () => {
		const { jsmlToHtml } = await import("../dist/jsml.js");
		const result = jsmlToHtml([
			["div", { "data-bind": "health", "data-if": "health < 50" }, "0"],
		]);
		assert.ok(result.includes('data-bind="health"'));
		assert.ok(result.includes('data-if="health < 50"'));
	});

	it("sanitizes dangerous elements from JSML", async () => {
		const { sanitizeJsml } = await import("../dist/jsml.js");
		const result = sanitizeJsml([
			["script", "alert('xss')"],
			["p", "safe"],
		]);
		assert.equal(result.html, "<p>safe</p>");
		assert.ok(result.strippedElements.includes("script"));
	});

	it("sanitizes dangerous attributes from JSML", async () => {
		const { sanitizeJsml } = await import("../dist/jsml.js");
		const result = sanitizeJsml([
			["div", { onclick: "evil()", class: "ok" }, "text"],
		]);
		assert.ok(!result.html.includes("onclick"));
		assert.ok(result.html.includes('class="ok"'));
	});

	it("sanitizes javascript: URIs from JSML", async () => {
		const { sanitizeJsml } = await import("../dist/jsml.js");
		const result = sanitizeJsml([
			["a", { href: "javascript:alert('xss')" }, "click"],
		]);
		assert.ok(!result.html.includes("javascript:"));
	});

	it("validates JSML fragments", () => {
		const result = validateFragment(
			JSON.stringify(["div", { "data-bind": "health" }, "0"]),
			"application/jsml+json",
		);
		assert.equal(result.valid, true);
	});

	it("validates dirty JSML fragments", () => {
		const result = validateFragment(
			JSON.stringify(["script", "alert('xss')"]),
			"application/jsml+json",
		);
		assert.equal(result.valid, false);
		assert.ok(result.errors[0].message.includes("script"));
	});

	it("returns sanitized tree in result", async () => {
		const { sanitizeJsml } = await import("../dist/jsml.js");
		const result = sanitizeJsml([
			["div", { class: "panel", onclick: "evil()" },
				["script", "bad"],
				["span", "safe"],
			],
		]);
		assert.equal(result.tree.length, 1);
		assert.ok(result.html.includes("<span>safe</span>"));
		assert.ok(!result.html.includes("script"));
		assert.ok(!result.html.includes("onclick"));
	});
});
