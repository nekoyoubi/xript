import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createFragmentInstance,
	evaluateCondition,
	bindExpressionKind,
	processFragment,
	processTree,
	resolveFragmentProfile,
	sanitizeSource,
} from "../dist/fragment.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const corpusPath = resolve(__dirname, "../../../spec/expression-tests.json");
const corpus = JSON.parse(await readFile(corpusPath, "utf-8"));

function fragment(source, { bindings = {}, declared, interpolate = false, format = "text/html" } = {}) {
	const names = declared ?? Object.keys(bindings);
	const instance = createFragmentInstance(
		{
			id: "corpus",
			slot: "corpus",
			format,
			source,
			inline: true,
			interpolate,
			bindings: names.map((name) => (typeof name === "string" ? { name, path: name } : name)),
		},
		source,
	);
	return instance.getContent(bindings);
}

describe("XEG corpus: data-if truth", () => {
	for (const testCase of corpus.cases) {
		it(testCase.id, () => {
			const bindings = testCase.bindings ?? corpus.defaultBindings;
			const truth = evaluateCondition(testCase.expression, bindings);
			const expected = expectedTruth(testCase.expect);
			assert.equal(truth, expected, testCase.expression);
		});
	}
});

describe("XEG corpus: rejected sources are false, never thrown", () => {
	for (const testCase of corpus.rejects) {
		it(testCase.id, () => {
			assert.equal(evaluateCondition(testCase.expression, corpus.defaultBindings), false);
		});
	}
});

describe("XEG corpus: data-bind classification", () => {
	for (const testCase of corpus.bind) {
		it(testCase.id, () => {
			assert.equal(bindExpressionKind(testCase.expression), testCase.kind);
		});
	}

	it("a bare name still writes nothing when its binding is absent", () => {
		const result = fragment('<p data-bind="missing">fallback</p>', { bindings: {} });
		assert.equal(result.html, '<p data-bind="missing">fallback</p>');
	});

	it("an expression always writes, and null writes empty", () => {
		const result = fragment('<p data-bind="missing + 1">fallback</p>', { bindings: {} });
		assert.equal(result.html, '<p data-bind="missing + 1"></p>');
	});

	it("an expression-valued data-bind computes through the same sink as a name", () => {
		const result = fragment('<p data-bind="round(hp / maxHp * 100)">0</p>', {
			bindings: { hp: 35, maxHp: 100 },
		});
		assert.equal(result.html, '<p data-bind="round(hp / maxHp * 100)">35</p>');
	});

	it("a computed value cannot become markup", () => {
		const result = fragment('<p data-bind="evil">x</p>', {
			bindings: { evil: "<script>alert(1)</script>" },
		});
		assert.equal(result.html, '<p data-bind="evil">&lt;script&gt;alert(1)&lt;/script&gt;</p>');
	});
});

describe("XEG corpus: a bare name renders as its expression does", () => {
	for (const testCase of corpus.render) {
		it(testCase.id, () => {
			const result = fragment(testCase.source, {
				bindings: testCase.bindings,
				declared: testCase.declared,
			});
			assert.equal(result.html, testCase.expectedHtml);
		});
	}

	it("a bare name never reads an inherited property of the bindings", () => {
		const result = fragment('<p data-bind="constructor">fallback</p>', { bindings: {} });
		assert.equal(result.html, '<p data-bind="constructor">fallback</p>');
	});

	it("the deprecated string pass stringifies the same way", () => {
		const { html } = processFragment('<p data-bind="a">x</p><input data-bind="b" value="y" />', { a: null, b: 0 });
		assert.equal(html, '<p data-bind="a"></p><input data-bind="b" value="0" />');
	});

	it("the deprecated string pass writes a value literally", () => {
		const { html } = processFragment('<input data-bind="b" value="y" />', { b: "$&$1" });
		assert.equal(html, '<input data-bind="b" value="$&amp;$1" />');
	});
});

describe("XEG corpus: conditions are keyed by tree position", () => {
	for (const testCase of corpus.conditions) {
		it(testCase.id, () => {
			const result = fragment(testCase.source, { bindings: testCase.bindings });
			assert.deepEqual(result.conditions, testCase.expected);
		});
	}

	it("the deprecated visibility map still exists and still collides", () => {
		const result = fragment('<p data-if="alive">a</p><p data-if="alive">b</p>', {
			bindings: { alive: true },
		});
		assert.deepEqual(result.visibility, { alive: true });
		assert.equal(result.conditions.length, 2);
	});
});

describe("XEG corpus: interpolation safety, end to end", () => {
	for (const testCase of corpus.safety) {
		it(testCase.id, () => {
			const result = fragment(`<p>${testCase.text}</p>`, {
				bindings: testCase.bindings,
				interpolate: true,
			});
			assert.equal(result.html, `<p>${testCase.html}</p>`);
			assert.equal(result.tree[0].children[0].value, testCase.rendered);
			assert.equal(result.tree[0].children[0].segments, undefined);
		});
	}

	it("a resolved value never reaches the element tree", () => {
		const result = fragment("<p>{{ evil }}</p>", {
			bindings: { evil: "<b>bold</b>" },
			interpolate: true,
		});
		assert.equal(result.tree[0].children.length, 1);
		assert.equal(result.tree[0].children[0].kind, "text");
	});

	it("a value that spells an attribute cannot become one", () => {
		const result = fragment("<p>{{ evil }}</p>", {
			bindings: { evil: '" onclick="alert(1)' },
			interpolate: true,
		});
		assert.deepEqual(Object.keys(result.tree[0].props), []);
		assert.equal(result.html, '<p>" onclick="alert(1)</p>');
	});
});

describe("XEG corpus: attribute sinks are unreachable from interpolation", () => {
	for (const testCase of corpus.attributes) {
		it(testCase.id, () => {
			const result = fragment(testCase.source, {
				bindings: testCase.bindings,
				interpolate: true,
			});
			assert.equal(result.html, testCase.expectedHtml);
		});
	}

	it("a binding value never reaches the URI sink through a text site", () => {
		const result = fragment('<a href="/safe">{{ payload }}</a>', {
			bindings: { payload: "javascript:alert(1)" },
			interpolate: true,
		});
		assert.equal(result.tree[0].props.href, "/safe");
		assert.equal(result.html, '<a href="/safe">javascript:alert(1)</a>');
	});
});

describe("XEG: interpolation is opt-in", () => {
	it("a fill without `interpolate` leaves the delimiter alone", () => {
		const source = "<p>Health: {{ hp }}</p>";
		const result = fragment(source, { bindings: { hp: 35 } });
		assert.equal(result.html, source);
		assert.equal(result.tree[0].children[0].value, "Health: {{ hp }}");
	});

	it("a fill with `interpolate` resolves the same source", () => {
		const result = fragment("<p>Health: {{ hp }}</p>", {
			bindings: { hp: 35 },
			interpolate: true,
		});
		assert.equal(result.html, "<p>Health: 35</p>");
	});

	it("an unparseable site is a sanitize-time diagnostic", () => {
		const sanitized = sanitizeSource("<p>{{ hp = 1 }}</p>", "text/html", { interpolate: true });
		const errors = sanitized.diagnostics.filter((d) => d.code === "invalid-expression");
		assert.equal(errors.length, 1);
		assert.equal(errors[0].severity, "error");
	});

	it("an unclosed delimiter is not a diagnostic", () => {
		const sanitized = sanitizeSource("<p>use {{ to open</p>", "text/html", { interpolate: true });
		assert.deepEqual(sanitized.diagnostics.filter((d) => d.code === "invalid-expression"), []);
	});
});

describe("XEG: JSML gets interpolation from the same parse", () => {
	it("a string child segments identically", () => {
		const result = fragment(
			JSON.stringify(["p", "Health: {{ hp }}"]),
			{ bindings: { hp: 35 }, interpolate: true, format: "application/jsml+json" },
		);
		assert.equal(result.tree[0].children[0].value, "Health: 35");
	});

	it("a JSML value cannot become a node", () => {
		const result = fragment(
			JSON.stringify(["p", "{{ evil }}"]),
			{
				bindings: { evil: '["script", "alert(1)"]' },
				interpolate: true,
				format: "application/jsml+json",
			},
		);
		assert.equal(result.tree[0].children.length, 1);
		assert.equal(result.tree[0].children[0].kind, "text");
		assert.equal(result.tree[0].children[0].value, '["script", "alert(1)"]');
	});
});

describe("XEG: no code generation on the data-if path", () => {
	it("a data-if body cannot reach a host global", () => {
		globalThis.__xriptFragmentCanary = "leaked";
		try {
			assert.equal(evaluateCondition("__xriptFragmentCanary", {}), false);
			assert.equal(evaluateCondition("globalThis.process", {}), false);
			assert.equal(evaluateCondition("(function(){return true})()", {}), false);
			assert.equal(evaluateCondition("this.constructor.constructor('return 1')()", {}), false);
		} finally {
			delete globalThis.__xriptFragmentCanary;
		}
	});

	it("a data-if body cannot mutate anything", () => {
		const bindings = { hp: 1 };
		assert.equal(evaluateCondition("hp = 99", bindings), false);
		assert.equal(bindings.hp, 1);
	});

	it("processTree reports every condition, including duplicates", () => {
		const profile = resolveFragmentProfile("text/html", "x", null, null);
		const sanitized = sanitizeSource(
			'<div><p data-if="a">1</p><p data-if="a">2</p></div>',
			"text/html",
		);
		const bound = processTree(sanitized.tree, { a: true }, profile);
		assert.deepEqual(bound.conditions.map((c) => c.path), [[0, 0], [0, 1]]);
	});
});

function expectedTruth(expect) {
	if (expect === null || expect === false) return false;
	if (expect === true) return true;
	if (typeof expect === "number") return expect !== 0;
	if (typeof expect === "string") return expect.length > 0;
	return true;
}
