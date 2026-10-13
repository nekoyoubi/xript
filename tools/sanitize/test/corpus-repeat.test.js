import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
	MAX_REPEAT_COPIES,
	PROTOCOL_PROPS,
	diffRepeat,
	evaluateExpression,
	evaluateRepeatItems,
	parseRepeatHeader,
	repeatScope,
	resolveFormatProfile,
	resolveRepeatKeys,
	sanitizeFragment,
} from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(await readFile(resolve(__dirname, "../../../spec/repeat-tests.json"), "utf-8"));

describe("repeat corpus: headers", () => {
	for (const testCase of corpus.headers) {
		it(testCase.id, () => {
			const parsed = parseRepeatHeader(testCase.source);
			if (testCase.expected === null) {
				assert.equal(parsed.ok, false);
				return;
			}
			assert.equal(parsed.ok, true, parsed.message);
			assert.deepEqual(
				{ item: parsed.header.item, index: parsed.header.index, expression: parsed.header.source },
				testCase.expected,
			);
		});
	}
});

describe("repeat corpus: diff", () => {
	for (const testCase of corpus.diff) {
		it(testCase.id, () => assert.deepEqual(diffRepeat(testCase.previous, testCase.next), testCase.patch));
	}
});

describe("repeat: evaluation", () => {
	it("matches the corpus copy ceiling", () => assert.equal(MAX_REPEAT_COPIES, corpus.maxCopies));

	it("repeats nothing over a value that is not an array", () => {
		const parsed = parseRepeatHeader("x in xs");
		for (const xs of ["abc", { a: 1 }, null, 3, undefined]) {
			assert.deepEqual(evaluateRepeatItems(parsed.header, { xs }), []);
		}
	});

	it("layers the item, index name, and $index over the outer scope", () => {
		const { header } = parseRepeatHeader("(item, i) in items");
		const scope = repeatScope({ item: "outer", other: 1 }, header, "inner", 2);
		assert.equal(evaluateExpression("item", scope), "inner");
		assert.equal(evaluateExpression("i + $index + other", scope), 5);
	});

	it("rejects a key that is neither a string nor a number", () => {
		assert.equal(resolveRepeatKeys(["a", true]).problem, "invalid-key");
		assert.equal(resolveRepeatKeys(["a", "a"]).problem, "duplicate-key");
		assert.equal(resolveRepeatKeys([1, "1"]).mode, "keyed");
	});
});

describe("repeat: protocol props", () => {
	const formats = {
		"application/x-list+json": {
			syntax: "jsml",
			nodes: { List: {}, Item: { props: { label: { type: "string" } } } },
		},
	};
	const profile = resolveFormatProfile("application/x-list+json", formats, null);

	it("declares data-each and data-key as protocol props", () => {
		assert.ok(PROTOCOL_PROPS.has("data-each"));
		assert.ok(PROTOCOL_PROPS.has("data-key"));
	});

	it("keeps them on a node no vocabulary declares them for", () => {
		const source = JSON.stringify(["List", ["Item", { "data-each": "x in xs", "data-key": "x.id", label: "a" }]]);
		const result = sanitizeFragment(source, profile);
		assert.deepEqual(result.diagnostics, []);
		assert.deepEqual(result.tree[0].children[0].props, { "data-each": "x in xs", "data-key": "x.id", label: "a" });
	});

	it("drops a non-string value the way every protocol prop does", () => {
		const source = JSON.stringify(["List", ["Item", { "data-each": 3 }]]);
		const result = sanitizeFragment(source, profile);
		assert.deepEqual(result.diagnostics.map((d) => d.code), ["invalid-prop"]);
		assert.equal(result.tree[0].children[0].props["data-each"], undefined);
	});

	it("keeps them through the built-in HTML vocabulary and the JSML form of it", () => {
		const html = sanitizeFragment('<li data-each="x in xs" data-key="x">a</li>', resolveFormatProfile("text/html", null, null));
		assert.equal(html.html, '<li data-each="x in xs" data-key="x">a</li>');
		const jsml = sanitizeFragment(
			JSON.stringify(["li", { "data-each": "x in xs", "data-key": "x" }, "a"]),
			resolveFormatProfile("application/jsml+json", null, null),
		);
		assert.deepEqual(jsml.tree[0].props, { "data-each": "x in xs", "data-key": "x" });
	});
});
