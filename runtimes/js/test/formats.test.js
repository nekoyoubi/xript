import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { treeToHtml } from "@xriptjs/sanitize";
import {
	initXript,
	FragmentFormatError,
	FragmentSanitizeError,
	ModManifestValidationError,
	createFragmentInstance,
	processTree,
	parseNodeRef,
	BUILTIN_PROFILES,
} from "../dist/index.js";

let xript;

before(async () => {
	xript = await initXript();
});

const DEMO_FORMAT = "application/x-demo+json";

const componentHost = {
	xript: "0.8",
	name: "component-host",
	slots: [
		{ id: "panel", accepts: [DEMO_FORMAT], description: "component panel" },
		{ id: "html.panel", accepts: ["text/html"], description: "html panel" },
		{ id: "ghost", accepts: ["application/x-ghost+json"], description: "undeclared format" },
		{ id: "data.items", accepts: ["application/json"], description: "opaque data" },
	],
	formats: {
		[DEMO_FORMAT]: {
			syntax: "jsml",
			nodes: {
				Panel: {
					props: {
						heading: { type: "string" },
						collapsible: { type: "boolean" },
						gaugeStyle: { type: "object" },
					},
				},
				Progress: {
					props: {
						value: { type: "number" },
						max: { type: "number" },
						constraints: { type: "array" },
					},
					children: "none",
					bindTo: "value",
				},
				Link: {
					props: {
						href: { type: "string", sink: "uri" },
						label: { type: "string" },
					},
					children: "none",
					bindTo: "label",
				},
				Icon: {
					props: { svg: { type: "string", sink: "html" } },
					children: "none",
				},
			},
		},
	},
};

function componentRuntime(options = {}) {
	return xript.createRuntime(componentHost, { hostBindings: {}, ...options });
}

function loadPanel(runtime, source, extra = {}) {
	return runtime.loadMod({
		xript: "0.8",
		name: "panel-mod",
		version: "1.0.0",
		fills: { panel: [{ id: "the-panel", format: DEMO_FORMAT, source: JSON.stringify(source), inline: true, ...extra }] },
	});
}

describe("host-declared fragment vocabulary", () => {
	it("keeps node names, prop names, and prop types intact", () => {
		const runtime = componentRuntime();
		const mod = loadPanel(runtime, [
			"Panel",
			{ heading: "Stats", collapsible: true, gaugeStyle: { fg: "Green" } },
			["Progress", { value: 42, max: 100, constraints: ["Length:1"] }],
		]);

		const fragment = mod.fragments[0];
		assert.equal(fragment.contentType, "tree");
		assert.equal(fragment.sanitizedSource, "");

		const [panel] = fragment.sanitizedTree;
		assert.equal(panel.name, "Panel");
		assert.equal(panel.props.heading, "Stats");
		assert.equal(panel.props.collapsible, true);
		assert.deepEqual(panel.props.gaugeStyle, { fg: "Green" });

		const [progress] = panel.children;
		assert.equal(progress.name, "Progress");
		assert.equal(progress.props.value, 42);
		assert.equal(typeof progress.props.value, "number");
		assert.deepEqual(progress.props.constraints, ["Length:1"]);
		runtime.dispose();
	});

	it("carries the tree through getContent and binds a void node's prop", () => {
		const runtime = componentRuntime();
		const mod = runtime.loadMod({
			xript: "0.8",
			name: "bound",
			version: "1.0.0",
			fills: {
				panel: [{
					id: "bound-panel",
					format: DEMO_FORMAT,
					inline: true,
					source: JSON.stringify(["Panel", {}, ["Progress", { "data-bind": "hp", max: 100 }]]),
					bindings: [{ name: "hp", path: "player.health" }],
				}],
			},
		});

		const result = mod.fragments[0].getContent({ player: { health: 61 } });
		assert.equal(result.contentType, "tree");
		assert.equal(result.html, "");
		assert.equal(result.format, DEMO_FORMAT);
		assert.equal(result.tree[0].children[0].props.value, "61");
		runtime.dispose();
	});

	it("rejects an undeclared node instead of dropping it silently", () => {
		const runtime = componentRuntime();
		assert.throws(
			() => loadPanel(runtime, ["Panle", { heading: "typo" }]),
			(error) => error instanceof FragmentSanitizeError
				&& error.diagnostics.some((d) => d.code === "unknown-node" && d.node === "Panle"),
		);
		runtime.dispose();
	});

	it("drops an undeclared prop and reports it", () => {
		const runtime = componentRuntime();
		const diagnostics = [];
		const mod = loadPanel(
			componentRuntime({ onFragmentDiagnostic: (d) => diagnostics.push(d) }),
			["Panel", { heading: "ok", mystery: 1 }],
		);
		assert.equal(mod.fragments[0].sanitizedTree[0].props.mystery, undefined);
		assert.equal(mod.fragments[0].diagnostics[0].code, "unknown-prop");
		assert.equal(diagnostics[0].fragmentId, "the-panel");
		runtime.dispose();
	});

	it("routes a prop through the sink its vocabulary declares", () => {
		const runtime = componentRuntime();
		const mod = loadPanel(runtime, [
			"Panel",
			{},
			["Link", { href: "javascript:alert(1)", label: "evil" }],
			["Link", { href: "/docs/index.html", label: "safe" }],
			["Icon", { svg: "<b>ok</b><script>bad()</script>" }],
		]);

		const [evil, safe, icon] = mod.fragments[0].sanitizedTree[0].children;
		assert.equal(evil.props.href, undefined);
		assert.equal(evil.props.label, "evil");
		assert.equal(safe.props.href, "/docs/index.html");
		assert.equal(icon.props.svg, "<b>ok</b>");
		runtime.dispose();
	});

	it("refuses a fragment whose format the host never declared", () => {
		const runtime = componentRuntime();
		assert.throws(
			() =>
				runtime.loadMod({
					xript: "0.8",
					name: "ghost-mod",
					version: "1.0.0",
					fills: { ghost: [{ format: "application/x-ghost+json", source: "[]", inline: true }] },
				}),
			(error) => error instanceof ModManifestValidationError && /declare it in the host manifest's 'formats' block/.test(error.message),
		);
		runtime.dispose();
	});

	it("throws FragmentFormatError when a fragment instance is built directly", () => {
		assert.throws(
			() => createFragmentInstance(
				{ id: "x", slot: "s", format: "application/x-nope+json", source: "[]", inline: true },
				"[]",
			),
			(error) => error instanceof FragmentFormatError && error.format === "application/x-nope+json",
		);
	});
});

describe("fill taxonomy", () => {
	it("passes a fill with no format/source through as opaque data", () => {
		const runtime = componentRuntime();
		const mod = runtime.loadMod({
			xript: "0.8",
			name: "data-mod",
			version: "1.0.0",
			fills: { "data.items": [{ members: ["sword", "shield"], label: "loot" }] },
		});
		assert.equal(mod.fragments.length, 0);
		assert.deepEqual(mod.data["data.items"], [{ members: ["sword", "shield"], label: "loot" }]);
		runtime.dispose();
	});
});

describe("built-in HTML vocabulary", () => {
	it("reports an unknown HTML tag rather than dropping it in silence", () => {
		const diagnostics = [];
		const runtime = componentRuntime({ onFragmentDiagnostic: (d) => diagnostics.push(d) });
		const mod = runtime.loadMod({
			xript: "0.8",
			name: "marquee-mod",
			version: "1.0.0",
			fills: { "html.panel": [{ id: "dlg", format: "text/html", source: "<marquee><p>hi</p></marquee>", inline: true }] },
		});
		assert.equal(mod.fragments[0].contentType, "html");
		assert.ok(diagnostics.some((d) => d.code === "unknown-node" && d.node === "marquee" && d.severity === "warning"));
		runtime.dispose();
	});

	it("promotes an unknown HTML tag to a load failure under strictHtmlVocabulary", () => {
		const runtime = componentRuntime({ strictHtmlVocabulary: true });
		assert.throws(
			() =>
				runtime.loadMod({
					xript: "0.8",
					name: "strict-mod",
					version: "1.0.0",
					fills: { "html.panel": [{ id: "dlg", format: "text/html", source: "<marquee>hi</marquee>", inline: true }] },
				}),
			(error) => error instanceof FragmentSanitizeError,
		);
		runtime.dispose();
	});

	it("carries a tree alongside the html for an HTML fragment", () => {
		const runtime = componentRuntime();
		const mod = runtime.loadMod({
			xript: "0.8",
			name: "html-mod",
			version: "1.0.0",
			fills: {
				"html.panel": [{
					id: "hp",
					format: "text/html",
					inline: true,
					source: '<div class="panel"><span data-bind="hp">0</span></div>',
					bindings: [{ name: "hp", path: "health" }],
				}],
			},
		});
		const result = mod.fragments[0].getContent({ health: 75 });
		assert.equal(result.contentType, "html");
		assert.ok(result.html.includes(">75<"));
		assert.equal(result.tree[0].name, "div");
		assert.equal(result.tree[0].children[0].children[0].value, "75");
		runtime.dispose();
	});

	it("escapes a bound value instead of letting it become markup", () => {
		const runtime = componentRuntime();
		const mod = runtime.loadMod({
			xript: "0.8",
			name: "escape-mod",
			version: "1.0.0",
			fills: {
				"html.panel": [{
					id: "esc",
					format: "text/html",
					inline: true,
					source: '<span data-bind="name">?</span>',
					bindings: [{ name: "name", path: "who" }],
				}],
			},
		});
		const result = mod.fragments[0].getContent({ who: "<img src=x onerror=alert(1)>" });
		assert.ok(!result.html.includes("<img"));
		assert.ok(result.html.includes("&lt;img"));
		runtime.dispose();
	});
});

describe("tree/html binding equivalence", () => {
	const fixtures = [
		['<div class="panel"><span data-bind="hp">0</span></div>', { hp: 75 }],
		['<ul><li data-bind="a">-</li><li data-bind="b">-</li></ul>', { a: 1, b: 2 }],
		['<div data-if="hp &lt; 50"><p>low</p></div>', { hp: 10 }],
		['<a href="/docs">docs</a>', {}],
		["<p>plain</p>", {}],
	];

	it("treeToHtml(processTree(...)) matches processFragment(...) for HTML fragments", () => {
		const runtime = componentRuntime();
		fixtures.forEach(([source, bindings], index) => {
			const declaration = {
				id: `fx-${index}`,
				slot: "html.panel",
				format: "text/html",
				source,
				inline: true,
				bindings: Object.keys(bindings).map((name) => ({ name, path: name })),
			};
			const fragment = createFragmentInstance(declaration, source);
			const result = fragment.getContent(bindings);
			assert.equal(treeToHtml(result.tree), result.html, `fixture ${index}: ${source}`);
		});
		runtime.dispose();
	});

	it("processTree reports data-if visibility without pruning the node", () => {
		const profile = BUILTIN_PROFILES["text/html"];
		const fragment = createFragmentInstance(
			{ id: "vis", slot: "html.panel", format: "text/html", source: '<div data-if="hp < 50">low</div>', inline: true },
			'<div data-if="hp < 50">low</div>',
		);
		const bound = processTree(fragment.sanitizedTree, { hp: 10 }, profile);
		assert.equal(bound.visibility["hp < 50"], true);
		assert.equal(bound.tree.length, 1);
	});
});

describe("FragmentOp generalization", () => {
	function htmlRuntime(options = {}) {
		return componentRuntime(options);
	}

	it("parses a #id target as a node reference and a selector as a selector", () => {
		assert.deepEqual(parseNodeRef("#heal-button"), { by: "id", id: "heal-button" });
		assert.deepEqual(parseNodeRef(".warning"), { by: "selector", selector: ".warning" });
	});

	it("emits setProp with a typed value and a parsed target", () => {
		const runtime = htmlRuntime();
		runtime.execute(`
			hooks.fragment.update("bar", function(bindings, fragment) {
				fragment.setProp("#gauge", "value", bindings.hp);
			});
		`);
		const ops = runtime.fireFragmentHook("bar", "update", { hp: 42 });
		assert.equal(ops.length, 1);
		assert.equal(ops[0].op, "setProp");
		assert.equal(ops[0].selector, "#gauge");
		assert.deepEqual(ops[0].target, { by: "id", id: "gauge" });
		assert.equal(ops[0].prop, "value");
		assert.equal(ops[0].value, 42);
		runtime.dispose();
	});

	it("keeps setAttr working and populates prop alongside attr", () => {
		const runtime = htmlRuntime();
		runtime.execute(`
			hooks.fragment.update("bar", function(bindings, fragment) {
				fragment.setAttr(".panel", "class", "warn");
			});
		`);
		const ops = runtime.fireFragmentHook("bar", "update", {});
		assert.equal(ops[0].op, "setAttr");
		assert.equal(ops[0].selector, ".panel");
		assert.equal(ops[0].attr, "class");
		assert.equal(ops[0].prop, "class");
		assert.equal(ops[0].value, "warn");
		assert.deepEqual(ops[0].target, { by: "selector", selector: ".panel" });
		runtime.dispose();
	});

	it("drops an op that tries to set an event handler attribute", () => {
		const diagnostics = [];
		const runtime = htmlRuntime({ onFragmentDiagnostic: (d) => diagnostics.push(d) });
		runtime.execute(`
			hooks.fragment.update("bar", function(bindings, fragment) {
				fragment.setAttr(".x", "onclick", "alert(1)");
			});
		`);
		const ops = runtime.fireFragmentHook("bar", "update", {});
		assert.equal(ops.length, 0);
		assert.equal(diagnostics[0].code, "unsafe-prop");
		runtime.dispose();
	});

	it("sanitizes a dangerous URI and dangerous markup in op values", () => {
		const runtime = htmlRuntime();
		runtime.execute(`
			hooks.fragment.update("bar", function(bindings, fragment) {
				fragment.setAttr("#link", "href", "javascript:alert(1)");
				fragment.replaceChildren(".list", "<p>ok</p><script>bad()</script>");
			});
		`);
		const ops = runtime.fireFragmentHook("bar", "update", {});
		assert.equal(ops.length, 1);
		assert.equal(ops[0].op, "replaceChildren");
		assert.ok(!String(ops[0].value).includes("script"));
		assert.ok(String(ops[0].value).includes("<p>ok</p>"));
		runtime.dispose();
	});

	it("drops HTML sugar and CSS-selector targets on a declared vocabulary", () => {
		const diagnostics = [];
		const runtime = componentRuntime({ onFragmentDiagnostic: (d) => diagnostics.push(d) });
		loadPanel(runtime, ["Panel", {}, ["Progress", { id: "gauge", value: 0 }]]);
		runtime.execute(`
			hooks.fragment.update("the-panel", function(bindings, fragment) {
				fragment.addClass("#gauge", "critical");
				fragment.setProp(".gauge", "value", 1);
				fragment.setProp("#gauge", "value", 88);
			});
		`);
		const ops = runtime.fireFragmentHook("the-panel", "update", {});
		assert.equal(ops.length, 1);
		assert.equal(ops[0].op, "setProp");
		assert.equal(ops[0].value, 88);
		assert.ok(diagnostics.some((d) => d.code === "unsupported-op"));
		assert.ok(diagnostics.some((d) => d.code === "unsupported-target"));
		runtime.dispose();
	});

	it("routes an op value through the declared prop's sink", () => {
		const runtime = componentRuntime();
		loadPanel(runtime, ["Panel", {}, ["Link", { id: "l", href: "/a" }]]);
		runtime.execute(`
			hooks.fragment.update("the-panel", function(bindings, fragment) {
				fragment.setProp("#l", "href", "javascript:alert(1)");
				fragment.setProp("#l", "href", "/safe");
				fragment.setProp("#l", "nonesuch", 1);
			});
		`);
		const ops = runtime.fireFragmentHook("the-panel", "update", {});
		assert.equal(ops.length, 1);
		assert.equal(ops[0].value, "/safe");
		runtime.dispose();
	});

	it("preserves a J5ML node list passed to replaceChildren on a tree format", () => {
		const runtime = componentRuntime();
		loadPanel(runtime, ["Panel", {}]);
		runtime.execute(`
			hooks.fragment.update("the-panel", function(bindings, fragment) {
				fragment.replaceChildren("#root", [["Progress", { value: 3 }], ["Panle", {}]]);
			});
		`);
		const ops = runtime.fireFragmentHook("the-panel", "update", {});
		assert.equal(ops.length, 1);
		assert.deepEqual(ops[0].value, [["Progress", { value: 3 }]]);
		runtime.dispose();
	});

	it("keeps a string array for replaceChildren a list, sanitizing each element", () => {
		const runtime = htmlRuntime();
		runtime.execute(`
			hooks.fragment.update("inv", function(bindings, fragment) {
				fragment.replaceChildren(".list", (bindings.items || []).map(function(i) { return "<li onclick='x()'>" + i + "</li>"; }));
			});
		`);
		const ops = runtime.fireFragmentHook("inv", "update", { items: ["sword", "shield"] });
		assert.deepEqual(ops[0].value, ["<li>sword</li>", "<li>shield</li>"]);
		runtime.dispose();
	});

	it("keeps a declared prop's false as a typed value rather than a removal", () => {
		const runtime = componentRuntime();
		loadPanel(runtime, ["Panel", {}, ["Progress", { id: "gauge", value: 0 }]]);
		runtime.execute(`
			hooks.fragment.update("the-panel", function(bindings, fragment) {
				fragment.setProp("#gauge", "value", false);
			});
		`);
		const ops = runtime.fireFragmentHook("the-panel", "update", {});
		assert.equal(ops[0].op, "setProp");
		assert.equal(ops[0].value, false);
		runtime.dispose();
	});
});
