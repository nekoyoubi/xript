import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
	evaluateExpression,
	parseExpression,
	tryParseExpression,
	renderValue,
	segmentText,
	segmentsToSource,
	resolveFormatProfile,
	sanitizeFragment,
	treeToHtml,
} from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const corpusPath = resolve(__dirname, "../../../spec/expression-tests.json");
const corpus = JSON.parse(await readFile(corpusPath, "utf-8"));

const html = resolveFormatProfile("text/html", null, null);

describe("XEG corpus: evaluation", () => {
	for (const testCase of corpus.cases) {
		it(testCase.id, () => {
			const bindings = testCase.bindings ?? corpus.defaultBindings;
			const actual = evaluateExpression(testCase.expression, bindings);
			assert.deepEqual(actual, testCase.expect, testCase.expression);
		});
	}
});

describe("XEG corpus: rejected sources", () => {
	for (const testCase of corpus.rejects) {
		it(testCase.id, () => {
			const parsed = tryParseExpression(testCase.expression);
			assert.equal(parsed.ok, false, `expected a parse failure: ${testCase.reason}`);
			assert.equal(
				evaluateExpression(testCase.expression, corpus.defaultBindings),
				null,
				"a rejected source must not evaluate to anything but null",
			);
		});
	}
});

describe("XEG corpus: text-node segmentation", () => {
	for (const testCase of corpus.interpolation) {
		it(testCase.id, () => {
			const { segments, issues } = segmentText(testCase.text);

			if (testCase.invalid) {
				assert.ok(issues.length > 0, "expected at least one segmentation issue");
				return;
			}

			assert.deepEqual(issues, [], "expected no segmentation issues");
			assert.deepEqual(segments, testCase.segments ?? null);
		});
	}
});

describe("XEG corpus: interpolation safety", () => {
	for (const testCase of corpus.safety) {
		it(`${testCase.id} — resolves as text`, () => {
			const { segments } = segmentText(testCase.text);
			const resolved = segments === null
				? testCase.text
				: segments
					.map((segment) => segment.kind === "literal"
						? segment.value
						: renderValue(evaluateExpression(segment.source, testCase.bindings)))
					.join("");
			assert.equal(resolved, testCase.rendered);
		});

		it(`${testCase.id} — cannot introduce markup`, () => {
			const { segments } = segmentText(testCase.text);
			if (segments === null) return;
			for (const segment of segments) {
				assert.ok(
					segment.kind === "literal" || segment.kind === "expr",
					"a segment has exactly two shapes, neither of which is an element",
				);
				assert.equal(Object.prototype.hasOwnProperty.call(segment, "props"), false);
				assert.equal(Object.prototype.hasOwnProperty.call(segment, "children"), false);
			}
		});
	}
});

describe("XEG corpus: attribute values are never segmented", () => {
	for (const testCase of corpus.attributes) {
		it(testCase.id, () => {
			const parsed = sanitizeFragment(testCase.source, html, { interpolate: true });
			const attributeText = JSON.stringify(collectProps(parsed.tree));
			assert.equal(
				attributeText.includes("segments"),
				false,
				"no prop value carries segments",
			);
		});
	}

	it("an interpolation site in an attribute stays a literal string", () => {
		const parsed = sanitizeFragment('<a href="{{ target }}">go</a>', html, { interpolate: true });
		assert.equal(parsed.tree[0].props.href, "{{ target }}");
		assert.equal(parsed.tree[0].props.href.includes("{{"), true);
	});

	it("an interpolation site in a text node is segmented", () => {
		const parsed = sanitizeFragment("<p>hp {{ hp }}</p>", html, { interpolate: true });
		assert.deepEqual(parsed.tree[0].children[0].segments, [
			{ kind: "literal", value: "hp " },
			{ kind: "expr", source: "hp" },
		]);
	});
});

describe("XEG corpus: parse mode is opt-in and round-trips", () => {
	it("a delimiter in prose is untouched when interpolation is off", () => {
		const source = "<p>Handlebars uses {{ hp }} as a site.</p>";
		const parsed = sanitizeFragment(source, html, {});
		assert.equal(parsed.tree[0].children[0].segments, undefined);
		assert.equal(parsed.html, source);
	});

	it("segments never displace the authored source", () => {
		const source = "<p>hp {{ hp }} \\{{ literal }}</p>";
		const parsed = sanitizeFragment(source, html, { interpolate: true });
		assert.equal(parsed.tree[0].children[0].value, "hp {{ hp }} \\{{ literal }}");
		assert.equal(treeToHtml(parsed.tree), source);
	});

	it("segments re-serialize to their authored source", () => {
		for (const testCase of corpus.interpolation) {
			if (testCase.invalid) continue;
			const { segments } = segmentText(testCase.text);
			if (!segments) continue;
			const { segments: again } = segmentText(segmentsToSource(segments));
			assert.deepEqual(again, segments, testCase.id);
		}
	});
});

describe("XEG: the grammar has no host reach", () => {
	const hostShaped = [
		"globalThis", "eval('1')", "fetch('x')", "require('fs')", "process.exit()",
		"this", "new Function('x')", "hp.constructor('x')", "(() => 1)()",
	];

	for (const source of hostShaped) {
		it(`refuses ${source}`, () => {
			assert.equal(tryParseExpression(source).ok, false);
		});
	}

	it("names that merely look like globals resolve to null, not to a global", () => {
		globalThis.__xriptExpressionCanary = "leaked";
		try {
			assert.equal(evaluateExpression("__xriptExpressionCanary", {}), null);
			assert.equal(evaluateExpression("process", {}), null);
			assert.equal(evaluateExpression("process.env", {}), null);
		} finally {
			delete globalThis.__xriptExpressionCanary;
		}
	});

	it("a binding cannot smuggle a callable into the evaluator", () => {
		let called = false;
		const bindings = { boom: () => { called = true; return 1; } };
		assert.equal(evaluateExpression("boom", bindings), null);
		assert.equal(tryParseExpression("boom()").ok, false);
		assert.equal(called, false);
	});

	it("a binding cannot reach the prototype chain", () => {
		const bindings = { player: Object.assign(Object.create({ inherited: "leak" }), { own: 1 }) };
		assert.equal(evaluateExpression("player.inherited", bindings), null);
		assert.equal(evaluateExpression("player.own", bindings), 1);
		assert.equal(evaluateExpression("player.__proto__", bindings), null);
	});

	it("evaluation is total — nothing thrown escapes", () => {
		const hostile = {
			get boom() { throw new Error("nope"); },
			toString() { throw new Error("nope"); },
		};
		assert.equal(evaluateExpression("hostile.boom", { hostile }), null);
	});

	it("the node limit is enforced at parse time", () => {
		const deep = Array.from({ length: 400 }, () => "1").join(" + ");
		assert.throws(() => parseExpression(deep), /node limit/);
	});
});

function collectProps(tree) {
	return tree.flatMap((node) => node.kind === "element"
		? [node.props, ...collectProps(node.children)]
		: []);
}
