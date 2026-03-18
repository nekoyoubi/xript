import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { initXript, ModManifestValidationError } from "../dist/index.js";

let xript;

before(async () => {
	xript = await initXript();
});

const appManifest = {
	xript: "0.3",
	name: "test-app",
	version: "1.0.0",
	bindings: {
		log: { description: "Log a message", params: [{ name: "msg", type: "string" }] },
	},
	capabilities: {
		"ui-mount": { description: "Mount UI fragments", risk: "low" },
		"modify-player": { description: "Modify player state", risk: "medium" },
	},
	slots: [
		{ id: "sidebar.left", accepts: ["text/html", "application/jsml+json"], multiple: true, style: "isolated" },
		{ id: "header.status", accepts: ["text/html"], multiple: false, style: "inherit" },
		{ id: "main.overlay", accepts: ["text/html"], capability: "ui-mount", multiple: true },
	],
};

const validModManifest = {
	xript: "0.3",
	name: "test-mod",
	version: "1.0.0",
	capabilities: ["ui-mount"],
	fragments: [
		{
			id: "health-panel",
			slot: "sidebar.left",
			format: "text/html",
			source: '<div class="panel"><span data-bind="health">0</span>/<span data-bind="maxHealth">0</span></div>',
			inline: true,
			bindings: [
				{ name: "health", path: "player.health" },
				{ name: "maxHealth", path: "player.maxHealth" },
			],
		},
	],
};

describe("mod manifest validation", () => {
	it("validates a correct mod manifest", () => {
		const runtime = xript.createRuntime(appManifest, {
			hostBindings: { log: () => {} },
			capabilities: ["ui-mount"],
		});
		const mod = runtime.loadMod(validModManifest);
		assert.equal(mod.name, "test-mod");
		assert.equal(mod.fragments.length, 1);
		runtime.dispose();
	});

	it("rejects missing xript field", () => {
		const runtime = xript.createRuntime(appManifest, {
			hostBindings: { log: () => {} },
		});
		assert.throws(
			() => runtime.loadMod({ name: "bad", version: "1.0.0" }),
			ModManifestValidationError,
		);
		runtime.dispose();
	});

	it("rejects missing name field", () => {
		const runtime = xript.createRuntime(appManifest, {
			hostBindings: { log: () => {} },
		});
		assert.throws(
			() => runtime.loadMod({ xript: "0.3", version: "1.0.0" }),
			ModManifestValidationError,
		);
		runtime.dispose();
	});

	it("rejects missing version field", () => {
		const runtime = xript.createRuntime(appManifest, {
			hostBindings: { log: () => {} },
		});
		assert.throws(
			() => runtime.loadMod({ xript: "0.3", name: "bad" }),
			ModManifestValidationError,
		);
		runtime.dispose();
	});

	it("rejects fragment with missing id", () => {
		const runtime = xript.createRuntime(appManifest, {
			hostBindings: { log: () => {} },
		});
		assert.throws(
			() => runtime.loadMod({
				xript: "0.3", name: "bad", version: "1.0.0",
				fragments: [{ slot: "sidebar.left", format: "text/html", source: "<p>hi</p>" }],
			}),
			ModManifestValidationError,
		);
		runtime.dispose();
	});
});

describe("cross-validation", () => {
	it("rejects fragment targeting nonexistent slot", () => {
		const runtime = xript.createRuntime(appManifest, {
			hostBindings: { log: () => {} },
			capabilities: ["ui-mount"],
		});
		assert.throws(
			() => runtime.loadMod({
				xript: "0.3", name: "bad", version: "1.0.0",
				fragments: [{
					id: "panel", slot: "nonexistent", format: "text/html",
					source: "<p>hi</p>", inline: true,
				}],
			}),
			ModManifestValidationError,
		);
		runtime.dispose();
	});

	it("rejects fragment with unsupported format", () => {
		const runtime = xript.createRuntime(appManifest, {
			hostBindings: { log: () => {} },
		});
		assert.throws(
			() => runtime.loadMod({
				xript: "0.3", name: "bad", version: "1.0.0",
				fragments: [{
					id: "panel", slot: "sidebar.left", format: "text/xml",
					source: "<p>hi</p>", inline: true,
				}],
			}),
			ModManifestValidationError,
		);
		runtime.dispose();
	});

	it("rejects fragment when capability is not granted", () => {
		const runtime = xript.createRuntime(appManifest, {
			hostBindings: { log: () => {} },
		});
		assert.throws(
			() => runtime.loadMod({
				xript: "0.3", name: "bad", version: "1.0.0",
				fragments: [{
					id: "overlay", slot: "main.overlay", format: "text/html",
					source: "<p>hi</p>", inline: true,
				}],
			}),
			ModManifestValidationError,
		);
		runtime.dispose();
	});

	it("allows fragment when capability is granted", () => {
		const runtime = xript.createRuntime(appManifest, {
			hostBindings: { log: () => {} },
			capabilities: ["ui-mount"],
		});
		const mod = runtime.loadMod({
			xript: "0.3", name: "good", version: "1.0.0",
			fragments: [{
				id: "overlay", slot: "main.overlay", format: "text/html",
				source: "<p>hi</p>", inline: true,
			}],
		});
		assert.equal(mod.fragments.length, 1);
		runtime.dispose();
	});
});

describe("fragment sanitization", () => {
	it("strips script tags from fragment source", () => {
		const runtime = xript.createRuntime(appManifest, {
			hostBindings: { log: () => {} },
		});
		const mod = runtime.loadMod({
			xript: "0.3", name: "danger", version: "1.0.0",
			fragments: [{
				id: "panel", slot: "sidebar.left", format: "text/html",
				source: '<script>alert("xss")</script><p>safe</p>', inline: true,
			}],
		});
		const result = mod.fragments[0].getContent({});
		assert.ok(!result.html.includes("script"));
		assert.ok(result.html.includes("<p>safe</p>"));
		runtime.dispose();
	});

	it("strips event attributes from fragment source", () => {
		const runtime = xript.createRuntime(appManifest, {
			hostBindings: { log: () => {} },
		});
		const mod = runtime.loadMod({
			xript: "0.3", name: "danger", version: "1.0.0",
			fragments: [{
				id: "panel", slot: "sidebar.left", format: "text/html",
				source: '<div onclick="evil()">text</div>', inline: true,
			}],
		});
		const result = mod.fragments[0].getContent({});
		assert.ok(!result.html.includes("onclick"));
		assert.ok(result.html.includes("text"));
		runtime.dispose();
	});
});

describe("data-bind resolution", () => {
	it("substitutes binding values into data-bind elements", () => {
		const runtime = xript.createRuntime(appManifest, {
			hostBindings: { log: () => {} },
		});
		const mod = runtime.loadMod(validModManifest);
		const result = mod.fragments[0].getContent({
			player: { health: 75, maxHealth: 100 },
		});
		assert.ok(result.html.includes(">75<"));
		assert.ok(result.html.includes(">100<"));
		runtime.dispose();
	});

	it("leaves default content when binding is missing", () => {
		const runtime = xript.createRuntime(appManifest, {
			hostBindings: { log: () => {} },
		});
		const mod = runtime.loadMod(validModManifest);
		const result = mod.fragments[0].getContent({});
		assert.ok(result.html.includes(">0<"));
		runtime.dispose();
	});

	it("resolves nested binding paths", () => {
		const runtime = xript.createRuntime(appManifest, {
			hostBindings: { log: () => {} },
		});
		const mod = runtime.loadMod({
			xript: "0.3", name: "nested", version: "1.0.0",
			fragments: [{
				id: "deep", slot: "sidebar.left", format: "text/html",
				source: '<span data-bind="val">0</span>', inline: true,
				bindings: [{ name: "val", path: "a.b.c" }],
			}],
		});
		const result = mod.fragments[0].getContent({ a: { b: { c: 42 } } });
		assert.ok(result.html.includes(">42<"));
		runtime.dispose();
	});
});

describe("data-if evaluation", () => {
	it("evaluates data-if expressions against bindings", () => {
		const runtime = xript.createRuntime(appManifest, {
			hostBindings: { log: () => {} },
		});
		const mod = runtime.loadMod({
			xript: "0.3", name: "cond", version: "1.0.0",
			fragments: [{
				id: "cond-panel", slot: "sidebar.left", format: "text/html",
				source: '<div data-if="health < 50" class="warning">Low!</div>', inline: true,
				bindings: [{ name: "health", path: "hp" }],
			}],
		});

		const lowResult = mod.fragments[0].getContent({ hp: 30 });
		assert.equal(lowResult.visibility["health < 50"], true);

		const highResult = mod.fragments[0].getContent({ hp: 80 });
		assert.equal(highResult.visibility["health < 50"], false);
		runtime.dispose();
	});
});

describe("event extraction", () => {
	it("returns declared events from fragment", () => {
		const runtime = xript.createRuntime(appManifest, {
			hostBindings: { log: () => {} },
		});
		const mod = runtime.loadMod({
			xript: "0.3", name: "events", version: "1.0.0",
			fragments: [{
				id: "btn-panel", slot: "sidebar.left", format: "text/html",
				source: '<button data-action="heal">Heal</button>', inline: true,
				events: [
					{ selector: "[data-action='heal']", on: "click", handler: "onHeal" },
				],
			}],
		});
		const events = mod.fragments[0].getEvents();
		assert.equal(events.length, 1);
		assert.equal(events[0].selector, "[data-action='heal']");
		assert.equal(events[0].on, "click");
		assert.equal(events[0].handler, "onHeal");
		runtime.dispose();
	});
});

describe("fragment ordering", () => {
	it("sorts fragments by priority descending", () => {
		const runtime = xript.createRuntime(appManifest, {
			hostBindings: { log: () => {} },
		});
		const mod = runtime.loadMod({
			xript: "0.3", name: "ordered", version: "1.0.0",
			fragments: [
				{ id: "low", slot: "sidebar.left", format: "text/html", source: "<p>low</p>", inline: true, priority: 0 },
				{ id: "high", slot: "sidebar.left", format: "text/html", source: "<p>high</p>", inline: true, priority: 10 },
				{ id: "mid", slot: "sidebar.left", format: "text/html", source: "<p>mid</p>", inline: true, priority: 5 },
			],
		});
		assert.equal(mod.fragments[0].priority, 0);
		assert.equal(mod.fragments[1].priority, 10);
		assert.equal(mod.fragments[2].priority, 5);
		runtime.dispose();
	});
});

describe("inline fragments (JSML)", () => {
	it("uses source as inline markup when inline is true", () => {
		const runtime = xript.createRuntime(appManifest, {
			hostBindings: { log: () => {} },
		});
		const mod = runtime.loadMod({
			xript: "0.3", name: "inline", version: "1.0.0",
			fragments: [{
				id: "status", slot: "header.status", format: "text/html",
				source: '<span data-bind="hp">0</span>', inline: true,
				bindings: [{ name: "hp", path: "health" }],
			}],
		});
		const result = mod.fragments[0].getContent({ health: 50 });
		assert.ok(result.html.includes(">50<"));
		runtime.dispose();
	});

	it("processes JSML format fragments", () => {
		const runtime = xript.createRuntime(appManifest, {
			hostBindings: { log: () => {} },
		});
		const jsmlSource = JSON.stringify(
			["div", { class: "panel" },
				["span", { "data-bind": "hp" }, "0"],
				" / ",
				["span", { "data-bind": "max" }, "0"],
			],
		);
		const mod = runtime.loadMod({
			xript: "0.3", name: "jsml-mod", version: "1.0.0",
			fragments: [{
				id: "jsml-panel", slot: "sidebar.left", format: "application/jsml+json",
				source: jsmlSource, inline: true,
				bindings: [
					{ name: "hp", path: "health" },
					{ name: "max", path: "maxHealth" },
				],
			}],
		});
		const result = mod.fragments[0].getContent({ health: 75, maxHealth: 100 });
		assert.ok(result.html.includes(">75<"));
		assert.ok(result.html.includes(">100<"));
		assert.ok(result.html.includes('class="panel"'));
		runtime.dispose();
	});

	it("sanitizes dangerous content in JSML fragments", () => {
		const runtime = xript.createRuntime(appManifest, {
			hostBindings: { log: () => {} },
		});
		const jsmlSource = JSON.stringify([
			["script", "alert('xss')"],
			["p", "safe"],
		]);
		const mod = runtime.loadMod({
			xript: "0.3", name: "jsml-danger", version: "1.0.0",
			fragments: [{
				id: "jsml-bad", slot: "sidebar.left", format: "application/jsml+json",
				source: jsmlSource, inline: true,
			}],
		});
		const result = mod.fragments[0].getContent({});
		assert.ok(!result.html.includes("script"));
		assert.ok(result.html.includes("<p>safe</p>"));
		runtime.dispose();
	});

	it("uses fragmentSources for file-based fragments", () => {
		const runtime = xript.createRuntime(appManifest, {
			hostBindings: { log: () => {} },
		});
		const mod = runtime.loadMod(
			{
				xript: "0.3", name: "file-based", version: "1.0.0",
				fragments: [{
					id: "panel", slot: "sidebar.left", format: "text/html",
					source: "fragments/panel.html",
					bindings: [{ name: "val", path: "x" }],
				}],
			},
			{ fragmentSources: { "fragments/panel.html": '<div data-bind="val">?</div>' } },
		);
		const result = mod.fragments[0].getContent({ x: 99 });
		assert.ok(result.html.includes(">99<"));
		runtime.dispose();
	});
});

describe("updateBindings batch", () => {
	it("updates all fragments at once", () => {
		const runtime = xript.createRuntime(appManifest, {
			hostBindings: { log: () => {} },
		});
		const mod = runtime.loadMod({
			xript: "0.3", name: "batch", version: "1.0.0",
			fragments: [
				{
					id: "a", slot: "sidebar.left", format: "text/html",
					source: '<span data-bind="v">0</span>', inline: true,
					bindings: [{ name: "v", path: "x" }],
				},
				{
					id: "b", slot: "sidebar.left", format: "text/html",
					source: '<span data-bind="v">0</span>', inline: true,
					bindings: [{ name: "v", path: "y" }],
				},
			],
		});
		const results = mod.updateBindings({ x: 10, y: 20 });
		assert.equal(results.length, 2);
		assert.ok(results[0].html.includes(">10<"));
		assert.ok(results[1].html.includes(">20<"));
		runtime.dispose();
	});
});

describe("sandbox fragment API", () => {
	it("registers and fires fragment update handlers", async () => {
		const runtime = xript.createRuntime(appManifest, {
			hostBindings: { log: () => {} },
			capabilities: ["ui-mount"],
		});

		runtime.execute(`
			hooks.fragment.update("health-panel", function(bindings, fragment) {
				fragment.toggle(".warning", bindings.health < 50);
				fragment.addClass(".bar", bindings.health < 20 ? "critical" : "normal");
				fragment.setText(".hp-text", bindings.health + "/" + bindings.maxHealth);
			});
		`);

		const ops = runtime.fireFragmentHook("health-panel", "update", { health: 30, maxHealth: 100 });
		assert.equal(ops.length, 3);
		assert.equal(ops[0].op, "toggle");
		assert.equal(ops[0].selector, ".warning");
		assert.equal(ops[0].value, true);
		assert.equal(ops[1].op, "addClass");
		assert.equal(ops[1].value, "normal");
		assert.equal(ops[2].op, "setText");
		assert.equal(ops[2].value, "30/100");
		runtime.dispose();
	});

	it("registers mount/unmount/suspend/resume handlers", () => {
		const runtime = xript.createRuntime(appManifest, {
			hostBindings: { log: () => {} },
		});

		runtime.execute(`
			hooks.fragment.mount("my-panel", function(bindings, fragment) {
				fragment.setText(".status", "mounted");
			});
		`);

		const ops = runtime.fireFragmentHook("my-panel", "mount", {});
		assert.equal(ops.length, 1);
		assert.equal(ops[0].op, "setText");
		assert.equal(ops[0].value, "mounted");
		runtime.dispose();
	});

	it("returns empty array when no handlers registered", () => {
		const runtime = xript.createRuntime(appManifest, {
			hostBindings: { log: () => {} },
		});
		const ops = runtime.fireFragmentHook("nonexistent", "update", {});
		assert.equal(ops.length, 0);
		runtime.dispose();
	});

	it("supports replaceChildren for iteration", () => {
		const runtime = xript.createRuntime(appManifest, {
			hostBindings: { log: () => {} },
		});

		runtime.execute(`
			hooks.fragment.update("inv-panel", function(bindings, fragment) {
				var items = bindings.items || [];
				var html = items.map(function(item) { return "<li>" + item + "</li>"; });
				fragment.replaceChildren(".list", html);
			});
		`);

		const ops = runtime.fireFragmentHook("inv-panel", "update", { items: ["sword", "shield"] });
		assert.equal(ops.length, 1);
		assert.equal(ops[0].op, "replaceChildren");
		assert.equal(ops[0].value, "<li>sword</li><li>shield</li>");
		runtime.dispose();
	});
});

describe("mod entry script execution", () => {
	it("executes entry scripts from fragmentSources", () => {
		const logs = [];
		const runtime = xript.createRuntime(appManifest, {
			hostBindings: { log: (msg) => logs.push(msg) },
		});
		runtime.loadMod(
			{
				xript: "0.3", name: "scripted", version: "1.0.0",
				entry: "src/mod.js",
			},
			{ fragmentSources: { "src/mod.js": 'log("mod loaded")' } },
		);
		assert.equal(logs.length, 1);
		assert.equal(logs[0], "mod loaded");
		runtime.dispose();
	});
});

describe("dispose", () => {
	it("clears fragments on dispose", () => {
		const runtime = xript.createRuntime(appManifest, {
			hostBindings: { log: () => {} },
		});
		const mod = runtime.loadMod(validModManifest);
		assert.equal(mod.fragments.length, 1);
		mod.dispose();
		assert.equal(mod.fragments.length, 0);
		runtime.dispose();
	});
});
