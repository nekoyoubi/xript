import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	CapabilityDeniedError,
	CommandInputError,
	ModManifestValidationError,
	createModInstance,
	createRuntime,
	resolveRole,
	resolveRoleAll,
	resolveSlotContributions,
} from "../dist/index.js";

const HOST = {
	xript: "0.8",
	name: "commands-host",
	capabilities: {
		editor: { description: "Editor surface" },
		"editor.text": { description: "Document text" },
		"editor-destructive": { description: "Irreversible document edits" },
	},
	slots: [
		{
			id: "palette.commands",
			accepts: ["application/x-xript-command"],
			description: "Named actions in the command palette",
			capability: "write:editor.text",
			multiple: true,
		},
		{ id: "sidebar", accepts: ["text/html"], description: "sidebar", multiple: true },
		{ id: "transcriber", accepts: ["application/x-xript-role"], description: "transcription provider" },
	],
};

const QUOTE_TOOLS = {
	xript: "0.8",
	name: "quote-tools",
	version: "1.0.0",
	entry: {
		format: "script",
		script: "main.js",
		exports: {
			wrapSelection: { description: "Wrap the selection" },
			stripFormatting: { description: "Strip formatting", capability: "write:editor-destructive" },
		},
	},
	capabilities: ["write:editor.text"],
	fills: {
		"palette.commands": [
			{ id: "wrap.double", title: "Wrap in double quotes", handler: "wrapSelection", args: { open: '"', close: '"' } },
			{ id: "wrap.paren", title: "Wrap in parentheses", handler: "wrapSelection", args: { open: "(", close: ")" } },
			{ id: "wrap.custom", handler: "wrapSelection" },
			{ id: "strip.formatting", handler: "stripFormatting", priority: -10 },
		],
	},
};

const QUOTE_SOURCE = `
xript.exports.register("wrapSelection", function (args) {
	return (args.open || "") + "X" + (args.close || "");
});
xript.exports.register("stripFormatting", function () { return "stripped"; });
`;

function makeRuntime(capabilities = ["write:editor.text"], extra = {}) {
	return createRuntime(HOST, { hostBindings: {}, capabilities, ...extra });
}

function loadQuoteTools(runtime) {
	return runtime.loadMod(QUOTE_TOOLS, { fragmentSources: { "main.js": QUOTE_SOURCE } });
}

describe("command fills leave dataFills (v0.8.0 behaviour change)", () => {
	it("delivers command fills on commandFills, not in the opaque data bag", () => {
		const runtime = makeRuntime();
		const mod = loadQuoteTools(runtime);

		assert.equal(mod.data["palette.commands"], undefined);
		assert.equal(mod.commandFills.length, 4);
		assert.deepEqual(
			mod.commandFills.map((c) => c.id),
			["wrap.double", "wrap.paren", "wrap.custom", "strip.formatting"],
		);
		runtime.dispose();
	});

	it("still delivers an opaque fill on a non-reserved slot as data", () => {
		const runtime = makeRuntime();
		const mod = runtime.loadMod({
			xript: "0.8",
			name: "data-mod",
			version: "1.0.0",
			fills: { sidebar: [{ id: "wrap.double", handler: "wrapSelection" }] },
		});

		assert.equal(mod.commandFills.length, 0);
		assert.equal(mod.data.sidebar.length, 1);
		runtime.dispose();
	});

	it("normalization gets strict: a malformed command fill now fails to load", () => {
		const runtime = makeRuntime();
		assert.throws(
			() => runtime.loadMod({
				xript: "0.8",
				name: "sloppy",
				version: "1.0.0",
				fills: { "palette.commands": [{ title: "no id, no handler" }] },
			}),
			ModManifestValidationError,
		);
		runtime.dispose();
	});
});

describe("command normalization defaults", () => {
	it("falls title back to the id and defaults the rest", () => {
		const runtime = makeRuntime();
		loadQuoteTools(runtime);
		const custom = runtime.resolveCommand("quote-tools:wrap.custom");

		assert.equal(custom.title, "wrap.custom");
		assert.deepEqual(custom.args, {});
		assert.deepEqual(custom.keywords, []);
		assert.equal(custom.priority, 0);
		assert.equal(custom.exposed, true);
		runtime.dispose();
	});

	it("reports authority informationally: slot gate, plus the handler's export gate", () => {
		const runtime = makeRuntime(["write:editor.text", "write:editor-destructive"]);
		loadQuoteTools(runtime);

		const wrap = runtime.resolveCommand("quote-tools:wrap.double");
		assert.deepEqual(wrap.capabilities, ["write:editor.text"]);
		assert.equal(wrap.capability, "write:editor.text");

		const strip = runtime.resolveCommand("quote-tools:strip.formatting");
		assert.deepEqual(strip.capabilities, ["write:editor.text", "write:editor-destructive"]);
		assert.equal(strip.capability, "write:editor-destructive");
		runtime.dispose();
	});

	it("rejects a per-fill capability rather than ignoring it", () => {
		const runtime = makeRuntime();
		let error = null;
		try {
			runtime.loadMod({
				xript: "0.8",
				name: "gated",
				version: "1.0.0",
				fills: {
					"palette.commands": [
						{ id: "strip.formatting", handler: "stripFormatting", capability: "write:editor-destructive" },
					],
				},
			});
		} catch (thrown) {
			error = thrown;
		}
		assert.ok(error instanceof ModManifestValidationError);
		assert.equal(error.issues[0].code, "command-fill-capability");
		assert.match(error.issues[0].message, /entry\.exports\.stripFormatting\.capability/);
		runtime.dispose();
	});
});

describe("resolveCommands ordering and cardinality", () => {
	it("orders by priority descending, then id, then owning mod", () => {
		const runtime = makeRuntime();
		loadQuoteTools(runtime);

		assert.deepEqual(
			runtime.resolveCommands("palette.commands").map((c) => c.id),
			["wrap.custom", "wrap.double", "wrap.paren", "strip.formatting"],
		);
		runtime.dispose();
	});

	it("flags a bare-id collision across mods without renaming or dropping either", () => {
		const runtime = makeRuntime();
		loadQuoteTools(runtime);
		runtime.loadMod({
			xript: "0.8",
			name: "alpha-tools",
			version: "1.0.0",
			entry: { format: "script", script: "a.js", exports: { wrapSelection: { description: "a rival wrap" } } },
			fills: { "palette.commands": [{ id: "wrap.double", handler: "wrapSelection" }] },
		}, { fragmentSources: { "a.js": `xript.exports.register("wrapSelection", function () { return "alpha"; });` } });

		const doubles = runtime.resolveCommands("palette.commands").filter((c) => c.id === "wrap.double");
		assert.deepEqual(doubles.map((c) => c.qualifiedId), ["alpha-tools:wrap.double", "quote-tools:wrap.double"]);
		assert.ok(doubles.every((c) => c.collides));
		runtime.dispose();
	});

	it("resolves a bare id to the ordering winner and a qualified id to its owner", () => {
		const runtime = makeRuntime();
		loadQuoteTools(runtime);
		runtime.loadMod({
			xript: "0.8",
			name: "alpha-tools",
			version: "1.0.0",
			fills: { "palette.commands": [{ id: "wrap.double", handler: "wrapSelection" }] },
		});

		assert.equal(runtime.resolveCommand("wrap.double").mod, "alpha-tools");
		assert.equal(runtime.resolveCommand("quote-tools:wrap.double").mod, "quote-tools");
		assert.equal(runtime.resolveCommand("nope"), null);
		runtime.dispose();
	});

	it("honours a command preference for a bare-id lookup", () => {
		const runtime = makeRuntime(["write:editor.text"], { commandPreferences: { "wrap.double": "quote-tools" } });
		loadQuoteTools(runtime);
		runtime.loadMod({
			xript: "0.8",
			name: "alpha-tools",
			version: "1.0.0",
			fills: { "palette.commands": [{ id: "wrap.double", handler: "wrapSelection" }] },
		});

		assert.equal(runtime.resolveCommand("wrap.double").mod, "quote-tools");
		runtime.dispose();
	});
});

describe("invokeCommand", () => {
	it("merges bound arguments under the caller's and calls the handler with one object", () => {
		const runtime = makeRuntime();
		loadQuoteTools(runtime);

		const wrap = runtime.resolveCommand("quote-tools:wrap.double");
		assert.equal(runtime.invokeCommand(wrap), '"X"');
		assert.equal(runtime.invokeCommand(wrap, { open: "[" }), "[X\"");
		runtime.dispose();
	});

	it("enforces the handler's export capability at call time, not at load time", () => {
		const runtime = makeRuntime(["write:editor.text"]);
		loadQuoteTools(runtime);

		const strip = runtime.resolveCommand("quote-tools:strip.formatting");
		assert.ok(strip, "the command still resolves — exposure is not authority");
		assert.throws(() => runtime.invokeCommand(strip), CapabilityDeniedError);
		runtime.dispose();
	});

	it("routes into the declaring mod's namespace, so a shared export name is never ambiguous", () => {
		const runtime = makeRuntime();
		loadQuoteTools(runtime);
		runtime.loadMod({
			xript: "0.8",
			name: "alpha-tools",
			version: "1.0.0",
			entry: { format: "script", script: "a.js", exports: { wrapSelection: { description: "a rival wrap" } } },
			fills: { "palette.commands": [{ id: "alpha.wrap", handler: "wrapSelection" }] },
		}, { fragmentSources: { "a.js": `xript.exports.register("wrapSelection", function () { return "ALPHA"; });` } });

		assert.equal(runtime.invokeCommand(runtime.resolveCommand("alpha-tools:alpha.wrap")), "ALPHA");
		assert.equal(runtime.invokeCommand(runtime.resolveCommand("quote-tools:wrap.paren")), "(X)");
		runtime.dispose();
	});

	it("propagates a failing handler rather than swallowing it the way a hook does", () => {
		const runtime = makeRuntime();
		runtime.loadMod({
			xript: "0.8",
			name: "boom",
			version: "1.0.0",
			entry: { format: "script", script: "b.js", exports: { explode: { description: "throws" } } },
			fills: { "palette.commands": [{ id: "explode", handler: "explode" }] },
		}, { fragmentSources: { "b.js": `xript.exports.register("explode", function () { throw new Error("nope"); });` } });

		assert.throws(() => runtime.invokeCommand(runtime.resolveCommand("boom:explode")));
		runtime.dispose();
	});

	it("runs a host-supplied input validator, and only for a command that declares input", () => {
		const seen = [];
		const runtime = makeRuntime(["write:editor.text"], {
			validateInput: (input, args, command) => {
				seen.push(command.id);
				return typeof args.open === "string" ? [] : ["'open' must be a string"];
			},
		});
		runtime.loadMod({
			xript: "0.8",
			name: "typed",
			version: "1.0.0",
			entry: { format: "script", script: "t.js", exports: { wrapSelection: { description: "wrap" } } },
			fills: {
				"palette.commands": [
					{
						id: "wrap.custom",
						handler: "wrapSelection",
						input: { type: "object", properties: { open: { type: "string" } } },
					},
					{ id: "wrap.untyped", handler: "wrapSelection" },
				],
			},
		}, { fragmentSources: { "t.js": `xript.exports.register("wrapSelection", function (a) { return a.open; });` } });

		assert.equal(runtime.invokeCommand(runtime.resolveCommand("typed:wrap.custom"), { open: "<" }), "<");
		assert.throws(() => runtime.invokeCommand(runtime.resolveCommand("typed:wrap.custom")), CommandInputError);
		runtime.invokeCommand(runtime.resolveCommand("typed:wrap.untyped"), { open: "<" });

		assert.deepEqual(seen, ["wrap.custom", "wrap.custom"]);
		runtime.dispose();
	});
});

describe("resolution is deterministic, not load-order dependent", () => {
	function roleMod(name) {
		return createModInstance(
			{ xript: "0.8", name, version: "1.0.0", contributions: { provides: [{ role: "transcriber", fns: { run: "go" } }] } },
			{},
		);
	}

	it("resolveRoleAll orders providers by mod name, whichever order the host loaded them in", () => {
		const forward = [roleMod("alpha-tools"), roleMod("zeta-tools")];
		const reversed = [roleMod("zeta-tools"), roleMod("alpha-tools")];

		const expected = ["alpha-tools", "zeta-tools"];
		assert.deepEqual(resolveRoleAll("transcriber", forward).map((r) => r.addon), expected);
		assert.deepEqual(resolveRoleAll("transcriber", reversed).map((r) => r.addon), expected);
	});

	it("resolveRole picks the same provider either way, and a preference still wins", () => {
		const forward = [roleMod("alpha-tools"), roleMod("zeta-tools")];
		const reversed = [roleMod("zeta-tools"), roleMod("alpha-tools")];

		assert.equal(resolveRole("transcriber", forward).addon, "alpha-tools");
		assert.equal(resolveRole("transcriber", reversed).addon, "alpha-tools");
		assert.equal(resolveRole("transcriber", reversed, { transcriber: "zeta-tools" }).addon, "zeta-tools");
	});

	it("resolveSlotContributions breaks a synthesized-id tie by owning mod name", () => {
		const slots = [{ id: "sidebar", accepts: ["text/html"], multiple: true }];
		const fragmentMod = (name) => createModInstance(
			{
				xript: "0.8",
				name,
				version: "1.0.0",
				fragments: [{ id: "sidebar-fill-0", slot: "sidebar", format: "text/html", source: "<b>hi</b>", inline: true }],
			},
			{},
		);

		const forward = resolveSlotContributions("sidebar", [fragmentMod("alpha"), fragmentMod("zeta")], slots);
		const reversed = resolveSlotContributions("sidebar", [fragmentMod("zeta"), fragmentMod("alpha")], slots);

		assert.deepEqual(forward.map((c) => c.modName), ["alpha", "zeta"]);
		assert.deepEqual(reversed.map((c) => c.modName), ["alpha", "zeta"]);
	});
});
