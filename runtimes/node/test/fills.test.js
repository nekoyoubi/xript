import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRuntime, ModManifestValidationError } from "../dist/index.js";

const hostManifest = {
	xript: "0.7",
	name: "fills-host",
	capabilities: {
		ui: { description: "UI access" },
		transcribe: { description: "transcription" },
	},
	slots: [
		{ id: "sidebar.left", accepts: ["text/html"], multiple: true, description: "left panel" },
		{ id: "gated.panel", accepts: ["text/html"], capability: "ui", description: "gated panel" },
		{ id: "transcriber", accepts: ["application/x-xript-role"], description: "transcription provider" },
		{ id: "on-save", accepts: ["application/x-xript-hook"], description: "save event" },
	],
};

function makeRuntime(capabilities = []) {
	return createRuntime(hostManifest, { hostBindings: {}, capabilities });
}

const PANEL = `<div><p data-bind="status">…</p></div>`;

describe("fills — the canonical contribution surface loads (node)", () => {
	it("loads a fragment-format fill and resolves it through the slot", () => {
		const runtime = makeRuntime();
		const mod = runtime.loadMod(
			{
				xript: "0.7",
				name: "panel-mod",
				version: "1.0.0",
				fills: {
					"sidebar.left": [
						{ id: "info-panel", format: "text/html", source: "fragments/panel.html", bindings: [{ name: "status", path: "app.status" }] },
					],
				},
			},
			{ fragmentSources: { "fragments/panel.html": PANEL } },
		);
		assert.equal(mod.fragments.length, 1);
		assert.equal(mod.fragments[0].id, "info-panel");
		const contributions = runtime.resolveSlot("sidebar.left");
		assert.equal(contributions.length, 1);
		assert.equal(contributions[0].fragmentId, "info-panel");
		const results = mod.updateBindings({ app: { status: "online" } });
		assert.match(results[0].html, /online/);
	});

	it("synthesizes a stable id for an id-less fragment fill", () => {
		const runtime = makeRuntime();
		const mod = runtime.loadMod(
			{
				xript: "0.7",
				name: "anon-mod",
				version: "1.0.0",
				fills: { "sidebar.left": [{ format: "text/html", source: "p.html" }] },
			},
			{ fragmentSources: { "p.html": PANEL } },
		);
		assert.equal(mod.fragments[0].id, "sidebar.left-fill-0");
	});

	it("loads a role fill and resolves the provider", () => {
		const runtime = makeRuntime();
		runtime.loadMod({
			xript: "0.7",
			name: "whisper-mod",
			version: "1.0.0",
			entry: { script: "mod.js", exports: { doTranscribe: { description: "t" } } },
			fills: { transcriber: [{ fns: { transcribe: "doTranscribe" } }] },
		});
		const resolution = runtime.resolveRole("transcriber");
		assert.ok(resolution);
		assert.equal(resolution.addon, "whisper-mod");
		assert.deepEqual(resolution.fns, { transcribe: "doTranscribe" });
	});

	it("fires an event/hook fill's handler export with spread object data", () => {
		const runtime = makeRuntime();
		runtime.loadMod(
			{
				xript: "0.7",
				name: "hook-mod",
				version: "1.0.0",
				entry: { script: "mod.js", exports: { onSave: { description: "save handler" } } },
				fills: { "on-save": [{ handler: "onSave" }] },
			},
			{ fragmentSources: { "mod.js": `xript.exports.register("onSave", function(path, size) { return "saved " + path + " (" + size + ")"; });` } },
		);
		const results = runtime.fireHook("on-save", { data: { path: "/tmp/x", size: 12 } });
		assert.deepEqual(results, ["saved /tmp/x (12)"]);
	});

	it("runs export-backed handlers after in-sandbox registered handlers", () => {
		const runtime = makeRuntime();
		runtime.execute(`hooks["on-save"](function() { return "registered"; });`);
		runtime.loadMod(
			{
				xript: "0.7",
				name: "hook-mod",
				version: "1.0.0",
				entry: { script: "mod.js", exports: { onSave: { description: "h" } } },
				fills: { "on-save": [{ handler: "onSave" }] },
			},
			{ fragmentSources: { "mod.js": `xript.exports.register("onSave", function() { return "export"; });` } },
		);
		assert.deepEqual(runtime.fireHook("on-save"), ["registered", "export"]);
	});

	it("rejects a fill targeting an undeclared slot", () => {
		const runtime = makeRuntime();
		assert.throws(
			() => runtime.loadMod({ xript: "0.7", name: "m", version: "1.0.0", fills: { ghost: [{ format: "text/html", source: "p.html" }] } }),
			(error) => error instanceof ModManifestValidationError && /does not exist/.test(error.message),
		);
	});

	it("gates a fill on the slot's capability", () => {
		const runtime = makeRuntime();
		assert.throws(
			() =>
				runtime.loadMod(
					{ xript: "0.7", name: "m", version: "1.0.0", fills: { "gated.panel": [{ format: "text/html", source: "p.html" }] } },
					{ fragmentSources: { "p.html": PANEL } },
				),
			/requires capability 'ui'/,
		);
		const granted = makeRuntime(["ui"]);
		const mod = granted.loadMod(
			{ xript: "0.7", name: "m", version: "1.0.0", fills: { "gated.panel": [{ format: "text/html", source: "p.html" }] } },
			{ fragmentSources: { "p.html": PANEL } },
		);
		assert.equal(mod.fragments.length, 1);
	});

	it("rejects mixing fills with the deprecated surfaces", () => {
		const runtime = makeRuntime();
		assert.throws(
			() =>
				runtime.loadMod({
					xript: "0.7",
					name: "m",
					version: "1.0.0",
					fills: { "sidebar.left": [{ format: "text/html", source: "p.html" }] },
					fragments: [{ id: "x", slot: "sidebar.left", format: "text/html", source: "p.html" }],
				}),
			(error) => error instanceof ModManifestValidationError && /fills' alone/.test(error.message),
		);
	});
});
