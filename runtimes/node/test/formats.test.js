import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { treeToHtml } from "@xriptjs/sanitize";
import {
	createRuntime,
	FragmentFormatError,
	FragmentSanitizeError,
	ModManifestValidationError,
	sanitizeSource,
} from "../dist/index.js";

const WIDGETS = "application/x-widgets+json";

const widgetFormats = {
	[WIDGETS]: {
		syntax: "jsml",
		nodes: {
			Panel: {
				props: {
					heading: { type: "string" },
					collapsible: { type: "boolean" },
					level: { type: "number" },
					tags: { type: "array" },
					theme: { type: "object" },
				},
			},
			Link: {
				props: {
					href: { type: "string", sink: "uri" },
					label: { type: "string" },
				},
				children: "text",
			},
			Icon: {
				props: { svg: { type: "string", sink: "html" } },
				children: "none",
				bindTo: "svg",
			},
			Image: {
				props: { src: { type: "string", sink: "image-uri" } },
				children: "none",
			},
			Box: {
				props: { css: { type: "string", sink: "css" } },
			},
			Progress: {
				props: {
					value: { type: "number" },
					max: { type: "number" },
					gauge_style: { type: "object" },
				},
				children: "none",
			},
		},
	},
};

const host = {
	xript: "0.8",
	name: "vocab-host",
	version: "1.0.0",
	slots: [
		{ id: "widgets", accepts: [WIDGETS], multiple: true },
		{ id: "markup", accepts: ["text/html", "application/jsml+json"], multiple: true },
		{ id: "config", accepts: ["application/json"], multiple: true },
	],
	formats: widgetFormats,
};

function makeRuntime(overrides = {}) {
	return createRuntime(host, { hostBindings: {}, ...overrides });
}

function loadWidget(runtime, source, extra = {}) {
	return runtime.loadMod({
		xript: "0.8",
		name: "widget-mod",
		version: "1.0.0",
		fills: {
			widgets: [{ id: "panel", format: WIDGETS, source: JSON.stringify(source), inline: true, ...extra }],
		},
	});
}

function loadMarkup(runtime, source, format = "text/html", extra = {}) {
	return runtime.loadMod({
		xript: "0.8",
		name: "markup-mod",
		version: "1.0.0",
		fills: {
			markup: [{ id: "markup-frag", format, source, inline: true, ...extra }],
		},
	});
}

describe("unrecognized fragment formats are refused", () => {
	it("rejects a fragment fill whose format the host never declared", () => {
		const runtime = createRuntime(
			{ ...host, slots: [{ id: "widgets", accepts: ["application/x-ghost+json"], multiple: true }], formats: undefined },
			{ hostBindings: {} },
		);
		assert.throws(
			() =>
				runtime.loadMod({
					xript: "0.8",
					name: "ghost-mod",
					version: "1.0.0",
					fills: { widgets: [{ format: "application/x-ghost+json", source: "[]", inline: true }] },
				}),
			(error) => error instanceof ModManifestValidationError && /unknown fragment format/.test(error.message),
		);
	});

	it("throws FragmentFormatError from the sanitizer backstop", () => {
		assert.throws(
			() => sanitizeSource("[]", "application/x-ghost+json"),
			(error) => error instanceof FragmentFormatError && error.format === "application/x-ghost+json",
		);
	});

	it("keeps text/html+jsml working as a deprecated alias of text/html", () => {
		const result = sanitizeSource("<p>hi</p>", "text/html+jsml");
		assert.equal(result.contentType, "html");
		assert.equal(result.html, "<p>hi</p>");
	});
});

describe("the tree contract", () => {
	it("carries a sanitized tree alongside the html for an HTML fragment", () => {
		const runtime = makeRuntime();
		const mod = loadMarkup(runtime, '<div class="panel"><span data-bind="hp">0</span></div>', "text/html", {
			bindings: [{ name: "hp", path: "player.health" }],
		});
		const fragment = mod.fragments[0];
		assert.equal(fragment.contentType, "html");
		assert.equal(fragment.sanitizedTree[0].name, "div");

		const result = fragment.getContent({ player: { health: 75 } });
		assert.equal(result.contentType, "html");
		assert.ok(result.html.includes(">75<"));
		assert.equal(result.tree[0].children[0].children[0].value, "75");
		assert.equal(result.format, "text/html");
	});

	it("binds a void node's value prop on the tree path", () => {
		const runtime = makeRuntime();
		const mod = loadMarkup(runtime, '<input data-bind="hp" />', "text/html", {
			bindings: [{ name: "hp", path: "hp" }],
		});
		const result = mod.fragments[0].getContent({ hp: 42 });
		assert.equal(result.tree[0].props.value, "42");
		assert.ok(result.html.includes('value="42"'));
	});

	it("keeps the html and tree projections in agreement", () => {
		const fixtures = [
			['<p>plain</p>', {}, []],
			['<div class="panel"><span data-bind="hp">0</span></div>', { hp: 75 }, [{ name: "hp", path: "hp" }]],
			['<span data-bind="v">0</span>', { v: "safe & sound" }, [{ name: "v", path: "v" }]],
			['<input data-bind="v" />', { v: 7 }, [{ name: "v", path: "v" }]],
			['<div data-if="hp &lt; 50">low</div>', { hp: 10 }, [{ name: "hp", path: "hp" }]],
			['<ul><li>one</li><li>two</li></ul>', {}, []],
		];

		const runtime = makeRuntime();
		for (const [source, data, bindings] of fixtures) {
			const mod = runtime.loadMod({
				xript: "0.8",
				name: `equiv-${Math.random().toString(36).slice(2)}`,
				version: "1.0.0",
				fills: { markup: [{ format: "text/html", source, inline: true, bindings }] },
			});
			const result = mod.fragments[0].getContent(data);
			assert.equal(treeToHtml(result.tree), result.html, `divergence for ${source}`);
		}
	});

	it("processes a JSML fragment through the built-in HTML vocabulary", () => {
		const runtime = makeRuntime();
		const mod = loadMarkup(
			runtime,
			JSON.stringify(["div", { class: "card" }, ["span", { "data-bind": "hp" }, "0"]]),
			"application/jsml+json",
			{ bindings: [{ name: "hp", path: "hp" }] },
		);
		const result = mod.fragments[0].getContent({ hp: 9 });
		assert.equal(result.contentType, "html");
		assert.equal(result.html, '<div class="card"><span data-bind="hp">9</span></div>');
	});

	it("escapes a bound value that carries markup", () => {
		const runtime = makeRuntime();
		const mod = loadMarkup(runtime, '<span data-bind="v">0</span>', "text/html", {
			bindings: [{ name: "v", path: "v" }],
		});
		const result = mod.fragments[0].getContent({ v: '<img src=x onerror="alert(1)">' });
		assert.ok(!result.html.includes("<img"));
		assert.ok(result.html.includes("&lt;img"));
	});
});

describe("a host-declared vocabulary", () => {
	it("preserves node names, prop names, and prop types", () => {
		const runtime = makeRuntime();
		const mod = loadWidget(runtime, [
			"Panel",
			{ heading: "Stats", collapsible: true, level: 2, tags: ["a", "b"], theme: { fg: "Green" } },
			["Progress", { value: 30, max: 100, gauge_style: { fg: "Green" } }],
		]);

		const fragment = mod.fragments[0];
		assert.equal(fragment.contentType, "tree");
		assert.equal(fragment.sanitizedSource, "");

		const panel = fragment.sanitizedTree[0];
		assert.equal(panel.name, "Panel");
		assert.equal(panel.props.heading, "Stats");
		assert.equal(panel.props.collapsible, true);
		assert.equal(panel.props.level, 2);
		assert.deepEqual(panel.props.tags, ["a", "b"]);
		assert.deepEqual(panel.props.theme, { fg: "Green" });

		const progress = panel.children[0];
		assert.equal(progress.name, "Progress");
		assert.equal(progress.props.value, 30);
		assert.deepEqual(progress.props.gauge_style, { fg: "Green" });

		const result = fragment.getContent({});
		assert.equal(result.contentType, "tree");
		assert.equal(result.html, "");
		assert.equal(result.tree[0].name, "Panel");
	});

	it("refuses a node the vocabulary does not declare", () => {
		const runtime = makeRuntime();
		assert.throws(
			() => loadWidget(runtime, ["Panle", { heading: "typo" }]),
			(error) => error instanceof FragmentSanitizeError && error.diagnostics[0].code === "unknown-node",
		);
	});

	it("drops an undeclared prop and reports it", () => {
		const runtime = makeRuntime();
		const mod = loadWidget(runtime, ["Panel", { heading: "ok", maxHealth: 5 }]);
		const panel = mod.fragments[0].sanitizedTree[0];
		assert.equal(panel.props.heading, "ok");
		assert.equal(panel.props.maxHealth, undefined);
		assert.ok(mod.fragments[0].diagnostics.some((d) => d.code === "unknown-prop" && d.prop === "maxHealth"));
	});

	it("drops a prop whose value fails its declared type", () => {
		const runtime = makeRuntime();
		const mod = loadWidget(runtime, ["Progress", { value: "thirty" }]);
		const progress = mod.fragments[0].sanitizedTree[0];
		assert.equal(progress.props.value, undefined);
		assert.ok(mod.fragments[0].diagnostics.some((d) => d.code === "invalid-prop"));
	});

	it("binds through the prop a node's bindTo names, via that prop's sink", () => {
		const runtime = makeRuntime();
		const mod = loadWidget(runtime, ["Icon", { "data-bind": "glyph" }], {
			bindings: [{ name: "glyph", path: "glyph" }],
		});
		const result = mod.fragments[0].getContent({ glyph: '<b>ok</b><script>alert(1)</script>' });
		assert.equal(result.tree[0].props.svg, "<b>ok</b>");
	});

	it("reports visibility for data-if without pruning the node", () => {
		const runtime = makeRuntime();
		const mod = loadWidget(runtime, ["Panel", { "data-if": "hp < 50" }], {
			bindings: [{ name: "hp", path: "hp" }],
		});
		const low = mod.fragments[0].getContent({ hp: 10 });
		assert.equal(low.visibility["hp < 50"], true);
		assert.equal(low.tree.length, 1);
		const high = mod.fragments[0].getContent({ hp: 90 });
		assert.equal(high.visibility["hp < 50"], false);
	});
});

describe("prop sinks", () => {
	function propsOf(source) {
		const runtime = makeRuntime();
		return loadWidget(runtime, source).fragments[0];
	}

	it("rejects a javascript: URI at the uri sink", () => {
		const fragment = propsOf(["Link", { href: "javascript:alert(1)" }, "click"]);
		assert.equal(fragment.sanitizedTree[0].props.href, undefined);
		assert.ok(fragment.diagnostics.some((d) => d.code === "unsafe-prop"));
	});

	it("permits a relative URI at the uri sink", () => {
		const fragment = propsOf(["Link", { href: "/img/a.png" }, "click"]);
		assert.equal(fragment.sanitizedTree[0].props.href, "/img/a.png");
	});

	it("permits a safe data:image at the image-uri sink and rejects it at uri", () => {
		const dataUri = "data:image/png;base64,iVBORw0KGgo=";
		assert.equal(propsOf(["Image", { src: dataUri }]).sanitizedTree[0].props.src, dataUri);
		assert.equal(propsOf(["Link", { href: dataUri }, "x"]).sanitizedTree[0].props.href, undefined);
	});

	it("strips url() at the css sink", () => {
		const fragment = propsOf(["Box", { css: "color: red; background: url(javascript:alert(1))" }]);
		assert.ok(!String(fragment.sanitizedTree[0].props.css).includes("url("));
		assert.ok(String(fragment.sanitizedTree[0].props.css).includes("color: red"));
	});

	it("strips a script element at the html sink", () => {
		const fragment = propsOf(["Icon", { svg: '<svg></svg><script>alert(1)</script>' }]);
		assert.ok(!String(fragment.sanitizedTree[0].props.svg).includes("script"));
	});

	it("leaves inert data alone", () => {
		const fragment = propsOf(["Panel", { heading: "a < b", level: 3 }]);
		assert.equal(fragment.sanitizedTree[0].props.heading, "a < b");
		assert.equal(fragment.sanitizedTree[0].props.level, 3);
	});
});

describe("the built-in HTML vocabulary reports rather than drops silently", () => {
	it("reports an unknown node as a warning and keeps loading", () => {
		const runtime = makeRuntime();
		const mod = loadMarkup(runtime, "<marquee><p>hi</p></marquee>");
		const fragment = mod.fragments[0];
		assert.ok(fragment.diagnostics.some((d) => d.code === "unknown-node" && d.severity === "warning"));
		assert.ok(fragment.sanitizedSource.includes("<p>hi</p>"));
	});

	it("promotes an unknown node to an error under strictHtmlVocabulary", () => {
		const runtime = makeRuntime({ strictHtmlVocabulary: true });
		assert.throws(
			() => loadMarkup(runtime, "<marquee><p>hi</p></marquee>"),
			(error) => error instanceof FragmentSanitizeError,
		);
	});

	it("pushes diagnostics to onFragmentDiagnostic at load", () => {
		const seen = [];
		const runtime = makeRuntime({ onFragmentDiagnostic: (d) => seen.push(d) });
		loadMarkup(runtime, "<marquee><p>hi</p></marquee>");
		assert.ok(seen.some((d) => d.code === "unknown-node" && d.fragmentId === "markup-frag"));
	});
});

describe("fragment ops", () => {
	function fireOn(runtime, fragmentId, body, bindings = {}) {
		runtime.execute(`hooks.fragment.update("${fragmentId}", function(bindings, fragment) { ${body} });`);
		return runtime.fireFragmentHook(fragmentId, "update", bindings);
	}

	it("emits setProp with a parsed id target", () => {
		const runtime = makeRuntime();
		loadWidget(runtime, ["Progress", { id: "gauge", value: 0 }]);
		const ops = fireOn(runtime, "panel", `fragment.setProp("#gauge", "value", 42);`);
		assert.equal(ops.length, 1);
		assert.equal(ops[0].op, "setProp");
		assert.equal(ops[0].selector, "#gauge");
		assert.deepEqual(ops[0].target, { by: "id", id: "gauge" });
		assert.equal(ops[0].prop, "value");
		assert.equal(ops[0].value, 42);
	});

	it("keeps setAttr as a deprecated alias that also carries prop", () => {
		const runtime = makeRuntime();
		const ops = fireOn(runtime, "html-panel", `fragment.setAttr("#box", "title", "hi");`);
		assert.equal(ops[0].op, "setAttr");
		assert.equal(ops[0].attr, "title");
		assert.equal(ops[0].prop, "title");
		assert.deepEqual(ops[0].target, { by: "id", id: "box" });
	});

	it("parses a non-id target as a CSS selector", () => {
		const runtime = makeRuntime();
		const ops = fireOn(runtime, "html-panel", `fragment.toggle(".warning", true);`);
		assert.deepEqual(ops[0].target, { by: "selector", selector: ".warning" });
	});

	it("drops an op that would set an event-handler attribute", () => {
		const runtime = makeRuntime();
		const ops = fireOn(runtime, "html-panel", `fragment.setAttr(".x", "onclick", "alert(1)");`);
		assert.equal(ops.length, 0);
	});

	it("drops an op that would set an unsafe href", () => {
		const runtime = makeRuntime();
		const ops = fireOn(runtime, "html-panel", `fragment.setAttr(".x", "href", "javascript:alert(1)");`);
		assert.equal(ops.length, 0);
	});

	it("sanitizes replaceChildren html on an HTML vocabulary", () => {
		const runtime = makeRuntime();
		const ops = fireOn(runtime, "html-panel", `fragment.replaceChildren(".list", "<li>ok</li><script>alert(1)</script>");`);
		assert.equal(ops[0].value, "<li>ok</li>");
	});

	it("joins a string array for replaceChildren exactly as before", () => {
		const runtime = makeRuntime();
		const ops = fireOn(runtime, "html-panel", `fragment.replaceChildren(".list", ["<li>a</li>", "<li>b</li>"]);`);
		assert.equal(ops[0].value, "<li>a</li><li>b</li>");
	});

	it("preserves a node array for replaceChildren on a tree vocabulary", () => {
		const runtime = makeRuntime();
		loadWidget(runtime, ["Panel", { id: "root", heading: "x" }]);
		const ops = fireOn(runtime, "panel", `fragment.replaceChildren("#root", [["Progress", { value: 3 }]]);`);
		assert.equal(ops.length, 1);
		assert.deepEqual(ops[0].value, [["Progress", { value: 3 }]]);
	});

	it("drops addClass and a CSS-selector target on a tree vocabulary", () => {
		const diagnostics = [];
		const runtime = makeRuntime({ onFragmentDiagnostic: (d) => diagnostics.push(d) });
		loadWidget(runtime, ["Panel", { id: "root", heading: "x" }]);
		const ops = fireOn(
			runtime,
			"panel",
			`fragment.addClass("#root", "critical"); fragment.setProp(".root", "heading", "nope");`,
		);
		assert.equal(ops.length, 0);
		assert.ok(diagnostics.some((d) => d.code === "unsupported-op"));
		assert.ok(diagnostics.some((d) => d.code === "unsupported-target"));
	});

	it("routes an op value through the sink the vocabulary declares", () => {
		const safe = makeRuntime();
		loadWidget(safe, ["Link", { id: "cta", href: "/a" }, "go"]);
		const kept = fireOn(safe, "panel", `fragment.setProp("#cta", "href", "/b");`);
		assert.equal(kept.length, 1);
		assert.equal(kept[0].value, "/b");

		const unsafe = makeRuntime();
		loadWidget(unsafe, ["Link", { id: "cta", href: "/a" }, "go"]);
		const dropped = fireOn(unsafe, "panel", `fragment.setProp("#cta", "href", "javascript:alert(1)");`);
		assert.equal(dropped.length, 0);
	});

	it("drops an op naming a prop no node in the vocabulary declares", () => {
		const runtime = makeRuntime();
		loadWidget(runtime, ["Panel", { id: "root", heading: "x" }]);
		const ops = fireOn(runtime, "panel", `fragment.setProp("#root", "ghost", 1);`);
		assert.equal(ops.length, 0);
	});
});

describe("the fill taxonomy", () => {
	it("routes a data fill to mod.data rather than making a ghost fragment", () => {
		const runtime = makeRuntime();
		const mod = runtime.loadMod({
			xript: "0.8",
			name: "data-mod",
			version: "1.0.0",
			fills: {
				config: [
					{ members: [{ id: "a" }], label: "settings" },
					{ format: "application/json" },
				],
			},
		});
		assert.equal(mod.fragments.length, 0);
		assert.equal(mod.data.config.length, 2);
		assert.equal(mod.data.config[0].label, "settings");
	});

	it("still treats a fill with both format and source as a fragment", () => {
		const runtime = makeRuntime();
		const mod = loadMarkup(runtime, "<p>hi</p>");
		assert.equal(mod.fragments.length, 1);
		assert.deepEqual(mod.data, {});
	});
});
