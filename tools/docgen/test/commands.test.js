import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateDocs, summarizeSchema, modCommands, commandSlots } from "../dist/index.js";

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
			wrapSelection: { description: "Wrap the selection" },
			stripFormatting: { description: "Strip formatting", capability: "write:editor-destructive" },
		},
	},
	fills: {
		"palette.commands": [
			{ id: "wrap.double", title: "Wrap in double quotes", handler: "wrapSelection", args: { open: '"', close: '"' } },
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

function index(result) {
	return result.pages.find((page) => page.slug === "index").content;
}

describe("summarizeSchema", () => {
	it("names an object schema's properties, marking the optional ones", () => {
		assert.equal(summarizeSchema(WRAP_INPUT), "`{open, close}`");
		assert.equal(summarizeSchema({ type: "object", properties: { changed: { type: "boolean" } } }), "`{changed?}`");
	});

	it("falls back to the type, the enum, or a dash", () => {
		assert.equal(summarizeSchema({ type: "string" }), "`string`");
		assert.equal(summarizeSchema({ enum: ["a", "b"] }), '`"a" | "b"`');
		assert.equal(summarizeSchema(undefined), "—");
	});
});

describe("host command slots", () => {
	it("renders a Commands section with the fill contract", () => {
		const content = index(generateDocs(HOST));
		assert.match(content, /## Commands/);
		assert.match(content, /\| Slot \| Capability \| Multiple \| Fill contract \|/);
		assert.match(content, /\| `palette\.commands` \| `write:editor\.text` \| Yes \| open \(no `payload` constraint\) \|/);
	});

	it("folds command slots out of the UI Slots table", () => {
		const content = index(generateDocs(HOST));
		assert.match(content, /## UI Slots/);
		const table = content.slice(content.indexOf("## UI Slots"), content.indexOf("## Capabilities"));
		assert.ok(!table.includes("palette.commands"));
		assert.match(table, /`sidebar\.left`/);
	});

	it("omits the UI Slots table entirely when every slot is a command slot", () => {
		const content = index(generateDocs({ xript: "0.8", name: "h", slots: [HOST.slots[0]] }));
		assert.match(content, /## Commands/);
		assert.ok(!content.includes("## UI Slots"));
	});

	it("warns that a slot without multiple resolves to exactly one command", () => {
		const content = index(generateDocs({ xript: "0.8", name: "h", slots: [{ id: "acts", accepts: ["application/x-xript-command"] }] }));
		assert.match(content, /resolves to exactly \*\*one\*\* command across every loaded mod/);
	});

	it("describes a payload-constrained fill contract", () => {
		const content = index(
			generateDocs({
				xript: "0.8",
				name: "h",
				slots: [
					{
						id: "format.transformer",
						accepts: ["application/x-xript-command"],
						multiple: true,
						payload: { required: ["input", "output"], properties: { group: { enum: ["text", "code"] } } },
					},
				],
			}),
		);
		assert.match(content, /requires `input`, `output`; narrows `group`/);
	});

	it("omits the Commands section for a host with no command slot", () => {
		const content = index(generateDocs({ xript: "0.8", name: "h", slots: [{ id: "sidebar", accepts: ["text/html"] }] }));
		assert.ok(!content.includes("## Commands"));
	});

	it("states that authority never lives on the fill", () => {
		const content = index(generateDocs(HOST));
		assert.match(content, /A fill carrying its own `capability` is rejected at load\./);
	});
});

describe("mod command catalog", () => {
	it("renders a table grouped by slot with the Requires column", () => {
		const content = index(generateDocs(MOD, { host: HOST }));
		assert.match(content, /## Commands/);
		assert.match(content, /### `palette\.commands`/);
		assert.match(content, /\| Id \| Title \| Handler \| Requires \| Bound args \| Input \| Output \|/);
		assert.match(content, /\| `wrap\.double` \| Wrap in double quotes \| `wrapSelection` \| `write:editor\.text` \| `open`, `close` \| — \| — \|/);
		assert.match(content, /\| `wrap\.custom` \| Wrap in… \| `wrapSelection` \| `write:editor\.text` \| — \| `\{open, close\}` \| `\{changed\?\}` \|/);
		assert.match(content, /\| `strip\.formatting` \| Strip all formatting \| `stripFormatting` \| `write:editor-destructive` \| — \| — \| — \|/);
	});

	it("reports the slot's gate when the handler declares no export capability", () => {
		const content = index(generateDocs(MOD, { host: HOST }));
		const row = content.split("\n").find((line) => line.startsWith("| `wrap.double`"));
		assert.ok(row.includes("`write:editor.text`"));
	});

	it("leaves Requires blank when neither gate exists", () => {
		const host = { xript: "0.8", name: "h", slots: [{ id: "acts", accepts: ["application/x-xript-command"], multiple: true }] };
		const mod = { xript: "0.8", name: "m", fills: { acts: [{ id: "a", title: "A", handler: "run" }] } };
		const content = index(generateDocs(mod, { host }));
		assert.match(content, /\| `a` \| A \| `run` \| — \| — \| — \| — \|/);
	});

	it("notes an unexposed command without implying it is denied", () => {
		const host = { xript: "0.8", name: "h", slots: [{ id: "acts", accepts: ["application/x-xript-command"], multiple: true }] };
		const mod = { xript: "0.8", name: "m", fills: { acts: [{ id: "a", handler: "run", exposed: false }] } };
		const content = index(generateDocs(mod, { host }));
		assert.match(content, /`a` declare[\s\S]*?authority is capability, never exposure/);
	});

	it("sniffs command fills when no host manifest is supplied, reporting only the export gate", () => {
		const content = index(generateDocs(MOD));
		assert.match(content, /\| `wrap\.double` \| Wrap in double quotes \| `wrapSelection` \| — \| `open`, `close` \| — \| — \|/);
		assert.match(content, /\| `strip\.formatting` \| Strip all formatting \| `stripFormatting` \| `write:editor-destructive` \| — \| — \| — \|/);
	});

	it("omits the Commands section for a mod contributing only fragments", () => {
		const content = index(
			generateDocs({ xript: "0.8", name: "m", fills: { "sidebar.left": [{ format: "text/html", source: "p.html" }] } }),
		);
		assert.ok(!content.includes("## Commands"));
	});

	it("stops rendering a mod's capability requirements as declared scopes", () => {
		const content = index(generateDocs({ ...MOD, capabilities: ["write:editor.text"] }, { host: HOST }));
		assert.ok(!content.includes("## Capabilities"));
	});
});

describe("command collection helpers", () => {
	it("exposes the host's command slots", () => {
		assert.deepEqual(commandSlots(HOST.slots).map((slot) => slot.id), ["palette.commands"]);
	});

	it("carries titles, groups, and keywords through", () => {
		const [command] = modCommands({ acts: [{ id: "a", handler: "run", group: "text", keywords: ["x"] }] });
		assert.equal(command.title, "a");
		assert.equal(command.group, "text");
		assert.deepEqual(command.keywords, ["x"]);
	});
});
