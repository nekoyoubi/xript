import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
	BUILTIN_PROFILES,
	FormatProfileError,
	FragmentParseError,
	RESERVED_FORMAT_IDS,
	htmlToTree,
	jsmlToTree,
	nodeDefinition,
	resolveFormatProfile,
	sanitizeFragment,
	sanitizeHTML,
	sanitizeTree,
	treeToHtml,
	treeToJsml,
	validateFragment,
} from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const conformancePath = resolve(__dirname, "../../../spec/sanitizer-tests.json");
const conformanceTests = JSON.parse(await readFile(conformancePath, "utf-8"));

const WIDGETS = {
	"application/x-widgets+json": {
		syntax: "jsml",
		nodes: {
			Panel: {
				props: {
					heading: { type: "string" },
					collapsible: { type: "boolean" },
					level: { type: "integer" },
				},
			},
			Link: {
				props: { href: { type: "string", sink: "uri" }, label: { type: "string" } },
				children: "text",
			},
			Icon: {
				props: { svg: { type: "string", sink: "html" } },
				children: "none",
			},
			Progress: {
				props: {
					value: { type: "number" },
					max: { type: "number" },
					gauge_style: { type: "object" },
					constraints: { type: "array" },
					style: { type: "string", sink: "css" },
					avatar: { type: "string", sink: "image-uri" },
				},
				children: "none",
			},
			"svg:rect": { props: { width: { type: "number" } } },
		},
	},
};

const HYBRID = {
	"application/hybrid+json": {
		syntax: "jsml",
		vocabularies: ["html"],
		nodes: {
			Panel: { props: { heading: { type: "string" } } },
		},
	},
};

function profileFor(id, formats, vocabularies = null) {
	const profile = resolveFormatProfile(id, formats, vocabularies);
	assert.ok(profile, `expected a profile for ${id}`);
	return profile;
}

function sanitizeWidgets(source) {
	return sanitizeFragment(
		typeof source === "string" ? source : JSON.stringify(source),
		profileFor("application/x-widgets+json", WIDGETS),
	);
}

function firstElement(tree) {
	return tree.find(node => node.kind === "element");
}

describe("format profiles", () => {
	it("resolves the built-in profiles", () => {
		assert.equal(resolveFormatProfile("text/html", null, null).syntax, "html");
		assert.equal(resolveFormatProfile("text/html+jsml", null, null).syntax, "html");
		assert.equal(resolveFormatProfile("application/j5ml+json", null, null).syntax, "j5ml");
		assert.equal(resolveFormatProfile("application/jsml+json", null, null).syntax, "j5ml");
		for (const id of [
			"text/html",
			"text/html+jsml",
			"application/j5ml+json",
			"application/jsml+json",
		]) {
			assert.equal(BUILTIN_PROFILES[id].builtin, true);
			assert.deepEqual(BUILTIN_PROFILES[id].scope, [{ kind: "builtin-html" }]);
		}
	});

	it("treats application/jsml+json as a deprecated alias of application/j5ml+json", () => {
		const source = '["div",{"class":"p"},"hi"]';
		const canonical = sanitizeFragment(source, BUILTIN_PROFILES["application/j5ml+json"]);
		const deprecated = sanitizeFragment(source, BUILTIN_PROFILES["application/jsml+json"]);
		assert.equal(deprecated.html, canonical.html);
		assert.equal(deprecated.contentType, canonical.contentType);
	});

	it("normalizes both syntax spellings to j5ml on a host-declared format", () => {
		const declare = (syntax) => ({ "application/x-demo+json": { syntax, nodes: {} } });
		assert.equal(
			resolveFormatProfile("application/x-demo+json", declare("j5ml"), null).syntax,
			"j5ml",
		);
		assert.equal(
			resolveFormatProfile("application/x-demo+json", declare("jsml"), null).syntax,
			"j5ml",
		);
	});

	it("still reports the value a host actually wrote for an unknown syntax", () => {
		assert.throws(
			() =>
				resolveFormatProfile("application/x-demo+json", {
					"application/x-demo+json": { syntax: "jsonml", nodes: {} },
				}, null),
			/unknown syntax: "jsonml"/,
		);
	});

	it("treats text/html+jsml as an alias of text/html", () => {
		const html = sanitizeFragment('<div class="p">hi</div>', BUILTIN_PROFILES["text/html"]);
		const alias = sanitizeFragment('<div class="p">hi</div>', BUILTIN_PROFILES["text/html+jsml"]);
		assert.equal(alias.html, html.html);
		assert.equal(alias.contentType, "html");
	});

	it("returns null for an unknown format", () => {
		assert.equal(resolveFormatProfile("application/x-widgets+json", null, null), null);
		assert.equal(resolveFormatProfile("text/xml", null, null), null);
	});

	it("resolves a host-declared format", () => {
		const profile = profileFor("application/x-widgets+json", WIDGETS);
		assert.equal(profile.builtin, false);
		assert.deepEqual(profile.scope.map(v => v.kind), ["declared"]);
		assert.ok(nodeDefinition(profile, "Panel"));
	});

	it("never lets a host redeclare a built-in format", () => {
		const profile = resolveFormatProfile("text/html", {
			"text/html": { syntax: "jsml", nodes: { Panel: {} } },
		}, null);
		assert.equal(profile.builtin, true);
		assert.equal(profile.syntax, "html");
		assert.deepEqual(profile.scope, [{ kind: "builtin-html" }]);
	});

	it("reserves the non-fragment slot content types", () => {
		assert.ok(RESERVED_FORMAT_IDS.has("application/x-xript-role"));
		assert.ok(RESERVED_FORMAT_IDS.has("application/x-xript-hook"));
		assert.ok(RESERVED_FORMAT_IDS.has("application/x-xript-command"));
		assert.equal(resolveFormatProfile("application/x-xript-role", null, null), null);
	});

	it("throws on a declared format with an unknown syntax", () => {
		assert.throws(
			() => resolveFormatProfile("application/bad+json", {
				"application/bad+json": { syntax: "xml", nodes: {} },
			}, null),
			FormatProfileError,
		);
	});
});

describe("built-in HTML vocabulary is unchanged", () => {
	it("projects the tree back to byte-identical HTML across the conformance corpus", () => {
		const profile = BUILTIN_PROFILES["text/html"];
		for (const testCase of conformanceTests) {
			const tree = sanitizeTree(htmlToTree(testCase.input, profile), profile).tree;
			assert.equal(
				treeToHtml(tree),
				sanitizeHTML(testCase.input),
				`tree projection drifted for: ${testCase.description}`,
			);
		}
	});

	it("keeps sanitizeFragment's html byte-identical to sanitizeHTML", () => {
		for (const testCase of conformanceTests) {
			const result = sanitizeFragment(testCase.input, BUILTIN_PROFILES["text/html"]);
			assert.equal(result.html, testCase.expected, testCase.description);
			assert.equal(result.contentType, "html");
		}
	});

	it("still lowercases HTML node and attribute names", () => {
		const result = sanitizeFragment('<DIV CLASS="x">t</DIV>', BUILTIN_PROFILES["text/html"]);
		const div = firstElement(result.tree);
		assert.equal(div.name, "div");
		assert.deepEqual(Object.keys(div.props), ["class"]);
	});

	it("still repairs viewBox casing", () => {
		const result = sanitizeFragment(
			JSON.stringify(["svg", { viewBox: "0 0 1 1" }]),
			BUILTIN_PROFILES["application/jsml+json"],
		);
		assert.ok("viewBox" in firstElement(result.tree).props);
	});

	it("reports an unknown HTML element as a warning, not an error", () => {
		const result = sanitizeFragment(
			JSON.stringify(["marquee", "hi"]),
			BUILTIN_PROFILES["application/jsml+json"],
		);
		assert.equal(result.diagnostics.length, 1);
		assert.equal(result.diagnostics[0].code, "unknown-node");
		assert.equal(result.diagnostics[0].severity, "warning");
	});

	it("unwraps an unknown HTML element rather than swallowing its content", () => {
		const source = "<marquee>hi <b>there</b></marquee>";
		const result = sanitizeFragment(source, BUILTIN_PROFILES["text/html"]);
		assert.equal(result.html, sanitizeHTML(source));
		assert.equal(treeToHtml(result.tree), sanitizeHTML(source));
		assert.equal(result.diagnostics[0].code, "unknown-node");
	});

	it("swallows the content of a stripped element", () => {
		const result = sanitizeFragment("<script>evil()</script><p>ok</p>", BUILTIN_PROFILES["text/html"]);
		assert.equal(treeToHtml(result.tree), "<p>ok</p>");
	});

	it("does not let a close tag inside a raw-text region leak its content", () => {
		const source = '<div><script></div><img src=x onerror=alert(1)></script></div>';
		const result = sanitizeFragment(source, BUILTIN_PROFILES["text/html"]);
		assert.equal(result.html, "<div></div>");
		assert.equal(treeToHtml(result.tree), "<div></div>");
	});

	it("promotes an unknown HTML element to an error under strictVocabulary", () => {
		const result = sanitizeFragment(
			JSON.stringify(["marquee", "hi"]),
			BUILTIN_PROFILES["application/jsml+json"],
			{ strictVocabulary: true },
		);
		assert.equal(result.diagnostics[0].severity, "error");
	});

	it("keeps the strippedElements contract for stripped elements only", () => {
		const result = sanitizeFragment(
			JSON.stringify([["script", "bad"], ["marquee", "unknown"], ["p", "ok"]]),
			BUILTIN_PROFILES["application/jsml+json"],
		);
		assert.deepEqual(result.strippedElements, ["script"]);
		assert.equal(result.html, "<p>ok</p>");
		assert.deepEqual(result.diagnostics.map(d => d.code), ["stripped-node", "unknown-node"]);
	});

	it("drops the whole subtree of an unknown jsml node, byte-identical to the pre-vocabulary sanitizer", () => {
		const result = sanitizeFragment(
			JSON.stringify(["Panel", ["p", "hi"]]),
			BUILTIN_PROFILES["application/jsml+json"],
		);
		assert.equal(result.html, "");
		assert.deepEqual(result.tree, []);
		assert.equal(result.diagnostics[0].code, "unknown-node");
	});

	it("does not let a crafted jsml attribute name break out of the attribute list", () => {
		const payload = 'data-x"><img src=x onerror=alert(1)><b data-y="';
		const result = sanitizeFragment(
			JSON.stringify(["div", { [payload]: "1" }, "t"]),
			BUILTIN_PROFILES["application/jsml+json"],
		);
		assert.equal(result.html, "<div>t</div>");
		assert.ok(!result.html.includes("<img"));
		assert.ok(!("kind" in firstElement(result.tree).props));
		assert.deepEqual(Object.keys(firstElement(result.tree).props), []);
		assert.ok(result.diagnostics.some(d => d.code === "unsafe-prop"));
	});
});

describe("declared vocabulary: names and values", () => {
	it("preserves node-name case", () => {
		const result = sanitizeWidgets(["Panel", { heading: "Stats" }]);
		assert.equal(firstElement(result.tree).name, "Panel");
		assert.equal(result.contentType, "tree");
		assert.equal(result.html, "");
	});

	it("preserves prop-name case", () => {
		const declared = {
			"application/x+json": {
				syntax: "jsml",
				nodes: { Bar: { props: { maxHealth: { type: "number" } } } },
			},
		};
		const result = sanitizeFragment(
			JSON.stringify(["Bar", { maxHealth: 100 }]),
			profileFor("application/x+json", declared),
		);
		assert.deepEqual(firstElement(result.tree).props, { maxHealth: 100 });
	});

	it("preserves numbers, booleans, null, arrays, and objects", () => {
		const result = sanitizeWidgets([
			"Progress",
			{
				value: 70,
				max: 100,
				gauge_style: { fg: "Green" },
				constraints: ["Length:1", "Min:3"],
			},
		]);
		const props = firstElement(result.tree).props;
		assert.equal(props.value, 70);
		assert.equal(typeof props.value, "number");
		assert.deepEqual(props.gauge_style, { fg: "Green" });
		assert.deepEqual(props.constraints, ["Length:1", "Min:3"]);
	});

	it("keeps booleans as booleans", () => {
		const result = sanitizeWidgets(["Panel", { collapsible: true }]);
		assert.equal(firstElement(result.tree).props.collapsible, true);
	});

	it("preserves a namespaced node name", () => {
		const result = sanitizeWidgets(["svg:rect", { width: 4 }]);
		assert.equal(firstElement(result.tree).name, "svg:rect");
	});

	it("allows the protocol props on any declared node", () => {
		const result = sanitizeWidgets([
			"Panel",
			{ id: "stats", "data-bind": "health", "data-if": "alive" },
		]);
		assert.deepEqual(firstElement(result.tree).props, {
			id: "stats",
			"data-bind": "health",
			"data-if": "alive",
		});
		assert.equal(result.diagnostics.length, 0);
	});
});

describe("declared vocabulary: default-deny", () => {
	it("errors on an undeclared node instead of dropping it silently", () => {
		const result = sanitizeWidgets(["Panle", { heading: "typo" }]);
		assert.equal(result.tree.length, 0);
		assert.equal(result.diagnostics.length, 1);
		assert.equal(result.diagnostics[0].code, "unknown-node");
		assert.equal(result.diagnostics[0].severity, "error");
		assert.match(result.diagnostics[0].message, /Panle/);
	});

	it("errors on an HTML element in a closed scope", () => {
		const result = sanitizeWidgets(["div", "hi"]);
		assert.equal(result.tree.length, 0);
		assert.equal(result.diagnostics[0].code, "unknown-node");
		assert.equal(result.diagnostics[0].severity, "error");
	});

	it("is case-sensitive about node names", () => {
		const result = sanitizeWidgets(["panel", { heading: "x" }]);
		assert.equal(result.diagnostics[0].code, "unknown-node");
	});

	it("drops an undeclared prop with a warning", () => {
		const result = sanitizeWidgets(["Panel", { heading: "ok", bogus: 1 }]);
		assert.deepEqual(firstElement(result.tree).props, { heading: "ok" });
		assert.equal(result.diagnostics.length, 1);
		assert.equal(result.diagnostics[0].code, "unknown-prop");
		assert.equal(result.diagnostics[0].severity, "warning");
	});

	it("drops a prop whose value fails the declared JSON Schema type", () => {
		const result = sanitizeWidgets(["Panel", { heading: 42 }]);
		assert.deepEqual(firstElement(result.tree).props, {});
		assert.equal(result.diagnostics[0].code, "invalid-prop");
	});

	it("honours integer vs number", () => {
		const ok = sanitizeWidgets(["Panel", { level: 2 }]);
		assert.equal(firstElement(ok.tree).props.level, 2);
		const bad = sanitizeWidgets(["Panel", { level: 2.5 }]);
		assert.equal(bad.diagnostics[0].code, "invalid-prop");
	});

	it("resolves an HTML element alongside declared nodes when html is in scope", () => {
		const profile = profileFor("application/hybrid+json", HYBRID);
		const result = sanitizeFragment(
			JSON.stringify(["Panel", { heading: "h" }, ["p", "text"], ["script", "bad"]]),
			profile,
		);
		const panel = firstElement(result.tree);
		assert.equal(panel.name, "Panel");
		assert.equal(panel.children[0].name, "p");
		assert.deepEqual(result.strippedElements, ["script"]);
	});

	it("enforces the children constraint", () => {
		const none = sanitizeWidgets(["Icon", { svg: "<b>x</b>" }, ["Panel", {}]]);
		assert.equal(firstElement(none.tree).children.length, 0);
		assert.ok(none.diagnostics.some(d => d.code === "illegal-child" && d.severity === "error"));

		const text = sanitizeWidgets(["Link", { href: "/a" }, "click"]);
		assert.equal(firstElement(text.tree).children[0].value, "click");
	});

	it("carries an index path on every diagnostic", () => {
		const result = sanitizeWidgets(["Panel", {}, ["Panel", {}, ["Nope", {}]]]);
		assert.equal(result.diagnostics[0].path, "/0/0/0");
		assert.equal(result.diagnostics[0].node, "Nope");
	});
});

describe("sink routing", () => {
	it("blocks javascript: on a uri sink", () => {
		const result = sanitizeWidgets(["Link", { href: "javascript:alert(1)" }]);
		assert.deepEqual(firstElement(result.tree).props, {});
		assert.equal(result.diagnostics[0].code, "unsafe-prop");
	});

	it("blocks vbscript: on a uri sink", () => {
		const result = sanitizeWidgets(["Link", { href: "  VBScript:evil()" }]);
		assert.equal(result.diagnostics[0].code, "unsafe-prop");
	});

	it("permits a relative URI on a uri sink", () => {
		const result = sanitizeWidgets(["Link", { href: "/img/a.png" }]);
		assert.equal(firstElement(result.tree).props.href, "/img/a.png");
		assert.equal(result.diagnostics.length, 0);
	});

	it("rejects data: on a uri sink and permits a safe data:image on an image-uri sink", () => {
		const rejected = sanitizeWidgets(["Link", { href: "data:image/png;base64,AAA" }]);
		assert.equal(rejected.diagnostics[0].code, "unsafe-prop");

		const permitted = sanitizeWidgets(["Progress", { avatar: "data:image/png;base64,AAA" }]);
		assert.equal(firstElement(permitted.tree).props.avatar, "data:image/png;base64,AAA");
	});

	it("rejects a hostile data: payload on an image-uri sink", () => {
		const result = sanitizeWidgets(["Progress", { avatar: "data:text/html;base64,PHNjcmlwdD4=" }]);
		assert.equal(result.diagnostics[0].code, "unsafe-prop");
	});

	it("strips url() and expression() on a css sink", () => {
		const result = sanitizeWidgets(["Progress", { style: "color: red; background: url(javascript:1)" }]);
		const style = firstElement(result.tree).props.style;
		assert.ok(!style.includes("url("));
		assert.ok(style.includes("color: red"));
	});

	it("strips markup on an html sink", () => {
		const result = sanitizeWidgets(["Icon", { svg: "<svg><script>evil()</script></svg>" }]);
		const svg = firstElement(result.tree).props.svg;
		assert.equal(svg, "<svg></svg>");
		assert.ok(!svg.includes("script"));
	});

	it("leaves an inert text prop untouched", () => {
		const result = sanitizeWidgets(["Panel", { heading: "<not markup> & \"quoted\"" }]);
		assert.equal(firstElement(result.tree).props.heading, "<not markup> & \"quoted\"");
	});

	it("drops a non-string value at a non-text sink", () => {
		const result = sanitizeWidgets(["Link", { href: 12 }]);
		assert.ok(result.diagnostics.some(d => d.code === "invalid-prop"));
		assert.deepEqual(firstElement(result.tree).props, {});
	});
});

describe("event-handler and prototype hard floor", () => {
	it("rejects an on* prop in a declared vocabulary even if declared", () => {
		const declared = {
			"application/evil+json": {
				syntax: "jsml",
				nodes: { Btn: { props: { onclick: { type: "string" }, onClick: { type: "string" } } } },
			},
		};
		const profile = profileFor("application/evil+json", declared);
		const result = sanitizeFragment(
			JSON.stringify(["Btn", { onclick: "alert(1)", onClick: "alert(2)" }]),
			profile,
		);
		assert.deepEqual(firstElement(result.tree).props, {});
		assert.equal(result.diagnostics.length, 2);
		assert.ok(result.diagnostics.every(d => d.code === "unsafe-prop"));
	});

	it("rejects an on* attribute in the HTML vocabulary", () => {
		const result = sanitizeFragment(
			JSON.stringify(["div", { onmouseover: "evil()" }, "t"]),
			BUILTIN_PROFILES["application/jsml+json"],
		);
		assert.equal(result.html, "<div>t</div>");
		assert.ok(result.strippedAttributes.some(a => a.attribute === "onmouseover"));
	});

	it("never lets a __proto__ prop reach the tree or the prototype", () => {
		const raw = JSON.parse('{"__proto__": {"polluted": true}, "heading": "ok"}');
		const result = sanitizeWidgets(["Panel", raw]);
		const props = firstElement(result.tree).props;
		assert.deepEqual(props, { heading: "ok" });
		assert.equal({}.polluted, undefined);
		assert.equal(Object.getPrototypeOf(props), Object.prototype);
		assert.ok(result.diagnostics.some(d => d.code === "unsafe-prop"));
	});

	it("never lets a __proto__ attribute through the HTML vocabulary", () => {
		const raw = JSON.parse('{"__proto__": {"x": 1}, "class": "ok"}');
		const result = sanitizeFragment(
			JSON.stringify(["div", raw, "t"]),
			BUILTIN_PROFILES["application/jsml+json"],
		);
		assert.equal(result.html, '<div class="ok">t</div>');
		assert.equal({}.x, undefined);
	});
});

describe("tree conversions", () => {
	it("round-trips J5ML through the tree", () => {
		const nodes = [
			["div", { class: "panel" },
				["span", { "data-bind": "health" }, "0"],
				" / ",
				["span", { "data-bind": "maxHealth" }, "0"],
			],
			["hr"],
		];
		assert.deepEqual(treeToJsml(jsmlToTree(nodes)), nodes);
	});

	it("round-trips typed props through the tree", () => {
		const nodes = [["Progress", { value: 70, gauge_style: { fg: "Green" }, constraints: ["Length:1"] }]];
		assert.deepEqual(treeToJsml(jsmlToTree(nodes)), nodes);
	});

	it("escapes text and attribute values in the HTML projection", () => {
		const html = treeToHtml(jsmlToTree([["p", { title: 'a"b&c' }, "<script>"]]));
		assert.equal(html, '<p title="a&quot;b&amp;c">&lt;script&gt;</p>');
	});
});

describe("sanitizeFragment errors", () => {
	it("throws FragmentParseError on invalid JSON", () => {
		assert.throws(
			() => sanitizeFragment("{not json", BUILTIN_PROFILES["application/jsml+json"]),
			FragmentParseError,
		);
	});

	it("accepts both a bare element and a node list", () => {
		const bare = sanitizeFragment('["p","x"]', BUILTIN_PROFILES["application/jsml+json"]);
		const list = sanitizeFragment('[["p","x"],["p","y"]]', BUILTIN_PROFILES["application/jsml+json"]);
		assert.equal(bare.html, "<p>x</p>");
		assert.equal(list.html, "<p>x</p><p>y</p>");
	});
});

describe("validateFragment with vocabularies", () => {
	it("validates a declared fragment", () => {
		const result = validateFragment(
			JSON.stringify(["Panel", { heading: "Stats" }]),
			"application/x-widgets+json",
			WIDGETS,
			null,
		);
		assert.equal(result.valid, true);
		assert.equal(result.errors.length, 0);
	});

	it("fails a declared fragment with an undeclared node", () => {
		const result = validateFragment(
			JSON.stringify(["Panle", {}]),
			"application/x-widgets+json",
			WIDGETS,
			null,
		);
		assert.equal(result.valid, false);
		assert.match(result.errors[0].message, /Panle/);
	});

	it("warns without failing on an undeclared prop", () => {
		const result = validateFragment(
			JSON.stringify(["Panel", { heading: "ok", bogus: 1 }]),
			"application/x-widgets+json",
			WIDGETS,
			null,
		);
		assert.equal(result.valid, true);
		assert.equal(result.warnings.length, 1);
		assert.match(result.warnings[0], /bogus/);
	});

	it("warns without failing on an unknown HTML element", () => {
		const result = validateFragment("<marquee>hi</marquee>", "text/html", null, null);
		assert.equal(result.valid, true);
		assert.equal(result.warnings.length, 1);
		assert.match(result.warnings[0], /marquee/);
	});

	it("still rejects a format it cannot resolve", () => {
		const result = validateFragment("<div/>", "application/x-widgets+json", null, null);
		assert.equal(result.valid, false);
		assert.match(result.errors[0].message, /unsupported/);
	});
});
