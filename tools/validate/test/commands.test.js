import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
	commandDefects,
	commandFillViews,
	crossValidate,
	diffScores,
	isCommandSlot,
	lintManifests,
	scoreManifests,
	validateManifest,
	COMMAND_SLOT_ACCEPT,
} from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(await readFile(resolve(here, "..", "..", "..", "spec", "command-tests.json"), "utf-8"));

const host = {
	xript: "0.8",
	name: "example-editor",
	capabilities: {
		editor: { description: "Editor surface." },
		"editor.text": { description: "Document text." },
		"editor-destructive": { description: "Irreversible document edits." },
	},
	slots: [
		{
			id: "palette.commands",
			accepts: [COMMAND_SLOT_ACCEPT],
			description: "Named actions offered in the command palette.",
			capability: "write:editor.text",
			multiple: true,
		},
	],
};

const mod = {
	xript: "0.8",
	name: "quote-tools",
	version: "1.0.0",
	entry: {
		script: "src/main.js",
		format: "module",
		exports: {
			wrapSelection: { description: "Wrap the selection in a delimiter pair." },
			stripFormatting: { description: "Strip formatting.", capability: "write:editor-destructive" },
		},
	},
	capabilities: ["write:editor.text", "write:editor-destructive"],
	fills: {
		"palette.commands": [
			{
			id: "wrap.double",
			title: "Wrap in double quotes",
			handler: "wrapSelection",
			args: { open: '"', close: '"' },
			input: {
				type: "object",
				properties: { open: { type: "string" }, close: { type: "string" } },
				required: ["open", "close"],
				additionalProperties: false,
			},
		},
			{ id: "strip.formatting", title: "Strip all formatting", handler: "stripFormatting", priority: -10 },
		],
	},
};

const clone = (value) => JSON.parse(JSON.stringify(value));

function withFills(fills) {
	const next = clone(mod);
	next.fills = { "palette.commands": fills };
	return next;
}

function codes(result, severity) {
	return result.findings.filter((f) => f.severity === severity).map((f) => f.code);
}

describe("command slot — branch ordering", () => {
	it("claims a slot that accepts only the command type", () => {
		assert.equal(isCommandSlot({ accepts: [COMMAND_SLOT_ACCEPT] }), true);
	});

	it("yields to a role accept, which is checked first", () => {
		assert.equal(isCommandSlot({ accepts: [COMMAND_SLOT_ACCEPT, "application/x-xript-role"] }), false);
	});

	it("yields to a hook accept, which is checked second", () => {
		assert.equal(isCommandSlot({ accepts: [COMMAND_SLOT_ACCEPT, "application/x-xript-hook"] }), false);
	});

	it("claims the fill ahead of the fragment sniff", () => {
		assert.equal(isCommandSlot({ accepts: [COMMAND_SLOT_ACCEPT, "text/html"] }), true);
	});

	it("leaves a non-command slot alone", () => {
		assert.equal(isCommandSlot({ accepts: ["application/json"] }), false);
		assert.equal(isCommandSlot(undefined), false);
		assert.equal(isCommandSlot({}), false);
	});

	it("agrees with the shared corpus on every branch-order case", () => {
		for (const testCase of corpus.branchOrder) {
			assert.equal(
				isCommandSlot({ accepts: testCase.accepts }),
				testCase.expected === "command",
				testCase.description,
			);
		}
	});
});

describe("command slot — fill defects over the shared corpus", () => {
	for (const testCase of corpus.normalize) {
		it(testCase.description, () => {
			const defects = commandDefects(testCase.fills, testCase.slot);
			if (testCase.expected.ok) {
				assert.deepEqual(defects, [], `expected no defects, got ${JSON.stringify(defects)}`);
				assert.equal(commandFillViews(testCase.fills).length, testCase.expected.commands.length);
			} else {
				assert.ok(defects.length > 0, "expected a defect");
				assert.equal(defects[0].code, testCase.expected.error.code);
				assert.equal(defects[0].index, testCase.expected.error.fill);
			}
		});
	}
});

describe("command slot — handler enumeration", () => {
	it("reports a handler absent from a non-empty entry.exports", () => {
		const defects = commandDefects([{ id: "wrap", handler: "nope" }], "palette.commands", new Set(["wrapSelection"]));
		assert.equal(defects.length, 1);
		assert.equal(defects[0].code, "command-handler-unknown");
	});

	it("stays quiet when the mod enumerates no exports — the runtime is authoritative", () => {
		assert.deepEqual(commandDefects([{ id: "wrap", handler: "nope" }], "palette.commands", null), []);
	});
});

describe("command slot — crossValidate", () => {
	it("accepts a well-formed command fill", async () => {
		const result = await crossValidate(host, mod);
		assert.equal(result.valid, true, JSON.stringify(result.errors));
	});

	it("hard-errors on a per-fill capability and names the export to move it to", async () => {
		const result = await crossValidate(
			host,
			withFills([{ id: "strip.formatting", handler: "stripFormatting", capability: "write:editor-destructive" }]),
		);
		assert.equal(result.valid, false);
		const error = result.errors.find((e) => e.keyword === "command-fill-capability");
		assert.ok(error, JSON.stringify(result.errors));
		assert.equal(error.path, "/fills/palette.commands/0/capability");
		assert.match(error.message, /entry\.exports\.stripFormatting\.capability/);
	});

	it("errors on a fill with no handler", async () => {
		const result = await crossValidate(host, withFills([{ id: "wrap.double" }]));
		assert.equal(result.valid, false);
		assert.ok(result.errors.some((e) => e.keyword === "command-missing-handler"));
	});

	it("errors on a malformed id", async () => {
		const result = await crossValidate(host, withFills([{ id: "Wrap_Double", handler: "wrapSelection" }]));
		assert.equal(result.valid, false);
		assert.ok(result.errors.some((e) => e.keyword === "command-invalid-id"));
	});

	it("errors on a duplicate id within one (mod, slot)", async () => {
		const result = await crossValidate(
			host,
			withFills([
				{ id: "wrap.double", handler: "wrapSelection" },
				{ id: "wrap.double", handler: "stripFormatting" },
			]),
		);
		assert.equal(result.valid, false);
		const error = result.errors.find((e) => e.keyword === "command-duplicate-id");
		assert.ok(error);
		assert.equal(error.path, "/fills/palette.commands/1/id");
	});

	it("errors on non-object bound args", async () => {
		const result = await crossValidate(host, withFills([{ id: "wrap.double", handler: "wrapSelection", args: [1] }]));
		assert.ok(result.errors.some((e) => e.keyword === "command-args-not-object"));
	});

	it("errors on a bound key a closed input does not declare", async () => {
		const result = await crossValidate(
			host,
			withFills([
				{
					id: "wrap.double",
					handler: "wrapSelection",
					args: { open: '"', delimiter: '"' },
					input: { type: "object", properties: { open: { type: "string" } }, additionalProperties: false },
				},
			]),
		);
		const error = result.errors.find((e) => e.keyword === "command-unbound-arg");
		assert.ok(error);
		assert.equal(error.path, "/fills/palette.commands/0/args/delimiter");
	});

	it("does not run the fragment format check over a command fill", async () => {
		const result = await crossValidate(
			host,
			withFills([{ id: "render.badge", handler: "wrapSelection", format: "text/html", source: "<b>hi</b>" }]),
		);
		assert.equal(result.valid, true, JSON.stringify(result.errors));
	});

	it("still enforces the slot's capability gate on a command slot", async () => {
		const ungranted = clone(mod);
		ungranted.capabilities = [];
		ungranted.entry.exports.stripFormatting = { description: "Strip formatting." };
		const result = await crossValidate(host, ungranted);
		assert.ok(result.errors.some((e) => e.keyword === "cross-fill-capability"));
	});

	it("still enforces the slot's payload contract on a command slot", async () => {
		const bounded = clone(host);
		bounded.slots[0].payload = { required: ["group"] };
		const result = await crossValidate(bounded, mod);
		assert.ok(result.errors.some((e) => e.keyword === "cross-fill-payload"));
	});
});

describe("command slot — lint", () => {
	it("stays quiet on a well-formed command surface", () => {
		const result = lintManifests(host, [mod]);
		const commandFindings = result.findings.filter((f) => f.code.startsWith("command-"));
		assert.deepEqual(commandFindings, []);
	});

	it("warns on a command slot that is not multiple", () => {
		const singular = clone(host);
		delete singular.slots[0].multiple;
		const result = lintManifests(singular, [mod]);
		assert.ok(codes(result, "warn").includes("command-slot-singular"));
	});

	it("warns on an ungated command slot, in place of the generic ungated-slot info", () => {
		const open = clone(host);
		delete open.slots[0].capability;
		const result = lintManifests(open, [mod]);
		assert.ok(codes(result, "warn").includes("command-slot-ungated"));
		assert.ok(!codes(result, "info").includes("ungated-slot"));
	});

	it("errors on a per-fill capability", () => {
		const result = lintManifests(host, [
			withFills([{ id: "strip.formatting", handler: "stripFormatting", capability: "write:editor-destructive" }]),
		]);
		assert.ok(codes(result, "error").includes("command-fill-capability"));
	});

	it("errors on a handler that names no enumerated export", () => {
		const result = lintManifests(host, [withFills([{ id: "wrap.double", handler: "missingExport" }])]);
		assert.ok(codes(result, "error").includes("command-handler-unknown"));
	});

	it("notes bound args with no declared input", () => {
		const result = lintManifests(host, [
			withFills([{ id: "wrap.double", handler: "wrapSelection", args: { open: '"' } }]),
		]);
		assert.ok(codes(result, "info").includes("command-opaque-args"));
	});

	it("notes a gated slot whose commands all carry identical authority", () => {
		const result = lintManifests(host, [
			withFills([
				{ id: "wrap.double", handler: "wrapSelection" },
				{ id: "wrap.paren", handler: "wrapSelection" },
			]),
		]);
		assert.ok(codes(result, "info").includes("command-uniform-authority"));
	});

	it("stays quiet on uniform authority once one handler differentiates", () => {
		const result = lintManifests(host, [mod]);
		assert.ok(!codes(result, "info").includes("command-uniform-authority"));
	});

	it("notes a bare id declared by two mods, without dropping or renaming either", () => {
		const other = clone(mod);
		other.name = "prose-tools";
		const result = lintManifests(host, [mod, other]);
		const collision = result.findings.find((f) => f.code === "command-id-collision");
		assert.ok(collision);
		assert.equal(collision.severity, "info");
		assert.match(collision.message, /quote-tools, prose-tools|prose-tools, quote-tools/);
	});
});

describe("command slot — score", () => {
	it("reports the command surface alongside the headline without moving it", async () => {
		const withoutCommands = clone(host);
		withoutCommands.slots[0].accepts = ["text/html"];
		const plain = await scoreManifests(withoutCommands, []);
		const commanded = await scoreManifests(host, [mod]);
		assert.equal(commanded.headline, plain.headline);
		assert.deepEqual(commanded.commands.slots, ["palette.commands"]);
		assert.deepEqual(commanded.commands.gated, ["palette.commands"]);
		assert.deepEqual(commanded.commands.singular, []);
		assert.deepEqual(commanded.commands.unreachable, []);
		assert.deepEqual(commanded.commands.constrained, []);
	});

	it("counts an unfilled command slot as unreachable", async () => {
		const result = await scoreManifests(host, []);
		assert.deepEqual(result.commands.unreachable, ["palette.commands"]);
	});

	it("counts a payload-bounded command slot as constrained", async () => {
		const bounded = clone(host);
		bounded.slots[0].payload = { required: ["input", "output"] };
		const result = await scoreManifests(bounded, []);
		assert.deepEqual(result.commands.constrained, ["palette.commands"]);
	});

	it("names the command surface in the disclaimer", async () => {
		const result = await scoreManifests(host, [mod]);
		assert.match(result.disclaimer, /command slot is a slot/);
	});

	it("reports a gained command slot and a lost gate in score-diff", async () => {
		const before = clone(host);
		before.slots[0].accepts = ["text/html"];
		const baseline = await scoreManifests(before, []);
		const current = await scoreManifests(host, []);
		const diff = diffScores(baseline, current);
		assert.deepEqual(diff.commands.gained, ["palette.commands"]);

		const ungated = clone(host);
		delete ungated.slots[0].capability;
		const weakened = diffScores(current, await scoreManifests(ungated, []));
		assert.deepEqual(weakened.commands.ungated, ["palette.commands"]);
	});
});

describe("command slot — schema reservation", () => {
	it("refuses a host that declares the command type in its formats block", async () => {
		const bad = clone(host);
		bad.formats = { [COMMAND_SLOT_ACCEPT]: { syntax: "j5ml", nodes: { Panel: {} } } };
		const result = await validateManifest(bad);
		assert.equal(result.valid, false);
	});

	it("accepts a host that names the command type in a slot's accepts", async () => {
		const result = await validateManifest(host);
		assert.equal(result.valid, true, JSON.stringify(result.errors));
	});
});
