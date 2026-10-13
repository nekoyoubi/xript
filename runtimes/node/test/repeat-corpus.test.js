import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseRepeatHeader, diffRepeat, MAX_REPEAT_COPIES } from "@xriptjs/sanitize";
import { createFragmentInstance } from "../dist/fragment.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(await readFile(resolve(__dirname, "../../../spec/repeat-tests.json"), "utf-8"));

function generated(spec) {
	const out = {};
	for (const [name, count] of Object.entries(spec ?? {})) out[name] = Array.from({ length: count }, (_, i) => i);
	return out;
}

function instanceFor(source, bindingNames, interpolate = false) {
	return createFragmentInstance(
		{
			id: "corpus",
			slot: "corpus",
			format: "text/html",
			source,
			inline: true,
			interpolate,
			bindings: bindingNames.map((name) => ({ name, path: name })),
		},
		source,
	);
}

function diagnostics(result) {
	return result.diagnostics.map((d) => ({ code: d.code, path: d.path, node: d.node, prop: d.prop ?? null }));
}

describe("repeat corpus: copy ceiling", () => {
	it("matches the corpus", () => assert.equal(MAX_REPEAT_COPIES, corpus.maxCopies));
});

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

describe("repeat corpus: render", () => {
	for (const testCase of corpus.render) {
		it(testCase.id, () => {
			const bindings = { ...testCase.bindings, ...generated(testCase.generate) };
			const result = instanceFor(testCase.source, Object.keys(bindings), testCase.interpolate === true)
				.getContent(bindings);
			const expected = testCase.expected;
			if (expected.copies !== undefined) {
				assert.equal(result.repeats.reduce((n, r) => n + r.count, 0), expected.copies);
				assert.equal(result.repeats.length, expected.repeats);
			} else {
				assert.equal(result.html, expected.html);
				assert.deepEqual(result.conditions, expected.conditions);
				assert.deepEqual(result.repeats, expected.repeats);
			}
			assert.deepEqual(diagnostics(result), expected.diagnostics);
		});
	}
});

describe("repeat corpus: updates", () => {
	for (const testCase of corpus.updates) {
		it(testCase.id, () => {
			const names = Object.keys(Object.assign({}, ...testCase.steps.map((s) => s.bindings)));
			const instance = instanceFor(testCase.source, names);
			for (const step of testCase.steps) {
				const result = instance.getContent(step.bindings);
				assert.equal(result.html, step.expected.html);
				assert.deepEqual(result.repeats, step.expected.repeats);
			}
		});
	}
});

describe("repeat corpus: diff", () => {
	for (const testCase of corpus.diff) {
		it(testCase.id, () => {
			assert.deepEqual(diffRepeat(testCase.previous, testCase.next), testCase.patch);
		});
	}
});

describe("repeat: tree shape", () => {
	it("copies drop the template attributes and keep the rest", () => {
		const source = '<li id="row" data-each="x in xs" data-key="x" data-if="x" class="r" data-bind="x"></li>';
		const result = instanceFor(source, ["xs"]).getContent({ xs: ["a"] });
		const copy = result.tree[0];
		assert.deepEqual(Object.keys(copy.props), ["id", "data-if", "class", "data-bind"]);
	});

	it("a repeat in a JSML fragment expands the same way", () => {
		const source = JSON.stringify(["ul", ["li", { "data-each": "x in xs", "data-bind": "x" }]]);
		const instance = createFragmentInstance(
			{ id: "j", slot: "s", format: "application/jsml+json", source, inline: true, bindings: [{ name: "xs", path: "xs" }] },
			source,
		);
		const result = instance.getContent({ xs: [1, 2] });
		assert.equal(result.tree[0].children.length, 2);
		assert.equal(result.repeats[0].count, 2);
	});

	it("an item value cannot re-enter the tokenizer through interpolation", () => {
		const source = '<p data-each="x in xs">{{ x }}</p>';
		const result = instanceFor(source, ["xs"], true).getContent({ xs: ["{{ secret }}", "<b>x</b>"] });
		assert.equal(result.html, "<p>{{ secret }}</p><p>&lt;b&gt;x&lt;/b&gt;</p>");
	});
});
