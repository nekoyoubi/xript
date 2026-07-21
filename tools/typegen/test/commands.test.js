import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateTypes, generateAmbientTypes, schemaToType, callArgsType, modCommands, commandSlots } from "../dist/index.js";

const HOST = {
	xript: "0.8",
	name: "example-editor",
	capabilities: {
		editor: { description: "Editor surface" },
		"editor.text": { description: "Document text" },
		"editor-destructive": { description: "Irreversible document edits" },
	},
	slots: [
		{
			id: "palette.commands",
			accepts: ["application/x-xript-command"],
			description: "Named actions offered in the command palette",
			capability: "write:editor.text",
			multiple: true,
		},
		{ id: "sidebar.left", accepts: ["text/html"] },
	],
};

const WRAP_INPUT = {
	type: "object",
	properties: { open: { type: "string" }, close: { type: "string" } },
	required: ["open", "close"],
	additionalProperties: false,
};

const MOD = {
	xript: "0.8",
	name: "quote-tools",
	entry: {
		script: "src/main.js",
		format: "module",
		exports: {
			wrapSelection: { description: "Wrap the selection in a delimiter pair" },
			stripFormatting: { description: "Remove all inline formatting", capability: "write:editor-destructive" },
		},
	},
	capabilities: ["write:editor.text", "write:editor-destructive"],
	fills: {
		"palette.commands": [
			{ id: "wrap.double", title: "Wrap in double quotes", handler: "wrapSelection", args: { open: '"', close: '"' }, input: WRAP_INPUT },
			{
				id: "wrap.custom",
				title: "Wrap in…",
				handler: "wrapSelection",
				input: WRAP_INPUT,
				output: { type: "object", properties: { changed: { type: "boolean" } } },
			},
			{ id: "strip.formatting", title: "Strip all formatting", handler: "stripFormatting", priority: -10 },
		],
	},
};

describe("schemaToType", () => {
	it("maps the primitive types", () => {
		assert.equal(schemaToType({ type: "string" }), "string");
		assert.equal(schemaToType({ type: "integer" }), "number");
		assert.equal(schemaToType({ type: "number" }), "number");
		assert.equal(schemaToType({ type: "boolean" }), "boolean");
		assert.equal(schemaToType({ type: "null" }), "null");
	});

	it("maps an object schema with required and optional members", () => {
		assert.equal(
			schemaToType({ type: "object", properties: { a: { type: "string" }, b: { type: "number" } }, required: ["a"] }),
			"{ a: string; b?: number }",
		);
	});

	it("maps arrays, enums, consts, and unions", () => {
		assert.equal(schemaToType({ type: "array", items: { type: "string" } }), "string[]");
		assert.equal(schemaToType({ enum: ["text", "code"] }), '"text" | "code"');
		assert.equal(schemaToType({ const: 3 }), "3");
		assert.equal(schemaToType({ oneOf: [{ type: "string" }, { type: "number" }] }), "string | number");
		assert.equal(schemaToType({ type: ["string", "null"] }), "string | null");
	});

	it("quotes a property name that is not an identifier", () => {
		assert.equal(schemaToType({ type: "object", properties: { "a-b": { type: "string" } }, required: ["a-b"] }), '{ "a-b": string }');
	});

	it("degrades to unknown rather than any", () => {
		assert.equal(schemaToType({ $ref: "#/$defs/Thing" }), "unknown");
		assert.equal(schemaToType(undefined), "unknown");
		assert.equal(schemaToType({ type: "object" }), "Record<string, unknown>");
		assert.equal(schemaToType(false), "never");
	});
});

describe("command slot detection", () => {
	it("finds the host's command slots and ignores the rest", () => {
		assert.deepEqual(commandSlots(HOST.slots).map((s) => s.id), ["palette.commands"]);
	});

	it("does not claim a slot that also accepts a reserved kind checked ahead of it", () => {
		const slots = [
			{ id: "a", accepts: ["application/x-xript-role", "application/x-xript-command"] },
			{ id: "b", accepts: ["application/x-xript-hook", "application/x-xript-command"] },
		];
		assert.deepEqual(commandSlots(slots), []);
	});
});

describe("mod command collection", () => {
	it("reads the slot kind off the host when one is supplied", () => {
		assert.deepEqual(modCommands(MOD.fills, HOST.slots).map((c) => c.id), ["wrap.double", "wrap.custom", "strip.formatting"]);
	});

	it("ignores fills aimed at a slot that is not a command slot", () => {
		const fills = { "sidebar.left": [{ id: "x", handler: "run" }] };
		assert.deepEqual(modCommands(fills, HOST.slots), []);
	});

	it("sniffs the fill shape when no host is supplied", () => {
		assert.deepEqual(modCommands(MOD.fills).map((c) => c.id), ["wrap.double", "wrap.custom", "strip.formatting"]);
	});

	it("does not mistake a hook, role, or fragment fill for a command", () => {
		const fills = {
			"on.save": [{ handler: "onSave" }],
			"storage.provider": [{ fns: { get: "readIt" } }],
			"sidebar.left": [{ format: "text/html", source: "panel.html", id: "panel" }],
		};
		assert.deepEqual(modCommands(fills), []);
	});

	it("skips a fill carrying the banned per-fill capability", () => {
		const fills = { "palette.commands": [{ id: "a", handler: "run", capability: "write:editor.text" }] };
		assert.deepEqual(modCommands(fills, HOST.slots), []);
	});

	it("keeps the first of two fills sharing an id", () => {
		const fills = { "palette.commands": [{ id: "a", handler: "one" }, { id: "a", handler: "two" }] };
		assert.deepEqual(modCommands(fills, HOST.slots).map((c) => c.handler), ["one"]);
	});
});

describe("call-time argument types", () => {
	it("relaxes a bound key to optional and drops the argument requirement", () => {
		const [wrapDouble] = modCommands(MOD.fills, HOST.slots);
		assert.deepEqual(callArgsType(wrapDouble), { type: "{ open?: string; close?: string }", optional: true });
	});

	it("keeps an unbound required key required", () => {
		const wrapCustom = modCommands(MOD.fills, HOST.slots)[1];
		assert.deepEqual(callArgsType(wrapCustom), { type: "{ open: string; close: string }", optional: false });
	});

	it("infers an optional shape from bound values when no input is declared", () => {
		const commands = modCommands({ "palette.commands": [{ id: "a", handler: "run", args: { n: 1, on: true, name: "x" } }] }, HOST.slots);
		assert.deepEqual(callArgsType(commands[0]), { type: "{ n?: number; on?: boolean; name?: string }", optional: true });
	});

	it("falls back to an open record when the command declares neither", () => {
		const commands = modCommands({ "palette.commands": [{ id: "a", handler: "run" }] }, HOST.slots);
		assert.deepEqual(callArgsType(commands[0]), { type: "Record<string, unknown>", optional: true });
	});
});

describe("host command slot types", () => {
	it("emits a slot contract interface, the id union, and the handler type", () => {
		const result = generateTypes(HOST);
		assert.match(result, /declare namespace xript \{/);
		assert.match(result, /namespace commandSlots \{/);
		assert.match(result, /interface PaletteCommands \{/);
		assert.match(result, /readonly slot: "palette\.commands";/);
		assert.match(result, /readonly capability: "write:editor\.text";/);
		assert.match(result, /readonly multiple: true;/);
		assert.match(result, /type CommandSlotId = "palette\.commands";/);
		assert.match(result, /declare type XriptCommandHandler<A = Record<string, unknown>, R = unknown> = \(args: A\) => R \| Promise<R>;/);
	});

	it("reports an ungated slot's capability as undefined and a singular slot as multiple: false", () => {
		const result = generateTypes({
			xript: "0.8",
			name: "h",
			slots: [{ id: "acts", accepts: ["application/x-xript-command"] }],
		});
		assert.match(result, /readonly capability: undefined;/);
		assert.match(result, /readonly multiple: false;/);
	});

	it("renders a payload-constrained slot's fill contract", () => {
		const result = generateTypes({
			xript: "0.8",
			name: "h",
			slots: [
				{
					id: "format.transformer",
					accepts: ["application/x-xript-command"],
					multiple: true,
					payload: { required: ["input", "output"], properties: { group: { enum: ["text", "code"] }, input: {}, output: {} } },
				},
			],
		});
		assert.match(result, /readonly fill: \{ group\?: "text" \| "code"; input: unknown; output: unknown \};/);
	});

	it("omits the command block for a host with no command slot", () => {
		const result = generateTypes({ xript: "0.8", name: "h", slots: [{ id: "sidebar", accepts: ["text/html"] }] });
		assert.ok(!result.includes("commandSlots"));
		assert.ok(!result.includes("XriptCommandHandler"));
	});

	it("emits the command block into ambient output too", () => {
		const result = generateAmbientTypes(HOST);
		assert.match(result, /namespace commandSlots \{/);
		assert.ok(!result.includes("declare namespace commandSlots"));
	});
});

describe("mod command catalog", () => {
	it("types each command by its own signature with bound keys relaxed", () => {
		const result = generateTypes(MOD, { host: HOST });
		assert.match(result, /declare namespace commands \{/);
		assert.match(result, /"wrap\.double": \(args\?: \{ open\?: string; close\?: string \}\) => unknown;/);
		assert.match(result, /"wrap\.custom": \(args: \{ open: string; close: string \}\) => \{ changed\?: boolean \};/);
		assert.match(result, /"strip\.formatting": \(args\?: Record<string, unknown>\) => unknown;/);
		assert.match(result, /type Id = keyof Catalog;/);
	});

	it("carries the handler's export capability into the command's doc comment", () => {
		const result = generateTypes(MOD, { host: HOST });
		assert.match(result, /Requires capability: `write:editor-destructive`[\s\S]*?"strip\.formatting"/);
	});

	it("names the slot and the bound arguments in the doc comment", () => {
		const result = generateTypes(MOD, { host: HOST });
		assert.match(result, /Fills slot `palette\.commands` through the `wrapSelection` export\. Bound arguments: `open`, `close`\./);
	});

	it("generates the same catalog without a host manifest", () => {
		assert.equal(generateTypes(MOD), generateTypes(MOD, { host: HOST }));
	});

	it("omits the catalog for a mod contributing no commands", () => {
		const result = generateTypes({
			xript: "0.8",
			name: "m",
			fills: { "sidebar.left": [{ format: "text/html", source: "panel.html" }] },
		});
		assert.ok(!result.includes("namespace commands"));
	});

	it("stops treating a mod's capability requirements as declared scopes", () => {
		const result = generateTypes(MOD, { host: HOST });
		assert.ok(!result.includes('type XriptCapability = "0"'));
	});
});
