import { test, describe, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(__dirname, "../dist/cli.js");

async function run(...args) {
	try {
		const { stdout, stderr } = await execFileAsync("node", [CLI, ...args]);
		return { stdout, stderr, exitCode: 0 };
	} catch (err) {
		return { stdout: err.stdout || "", stderr: err.stderr || "", exitCode: err.code };
	}
}

const HOST = {
	xript: "0.8",
	name: "example-editor",
	capabilities: {
		editor: { description: "Editor surface" },
		"editor.text": { description: "Document text" },
		"editor-destructive": { description: "Irreversible edits" },
	},
	slots: [
		{
			id: "palette.commands",
			accepts: ["application/x-xript-command"],
			description: "Named actions offered in the command palette",
			capability: "write:editor.text",
			multiple: true,
		},
	],
};

const WEAKENED = {
	...HOST,
	slots: [
		{ id: "palette.commands", accepts: ["application/x-xript-command"], description: "d" },
		{ id: "menu.commands", accepts: ["application/x-xript-command"], multiple: true, capability: "write:editor.text" },
	],
};

const MOD = {
	xript: "0.8",
	name: "quote-tools",
	version: "1.0.0",
	entry: {
		script: "src/main.js",
		format: "module",
		exports: {
			wrapSelection: { description: "Wrap the selection" },
			stripFormatting: { description: "Strip formatting", capability: "write:editor-destructive" },
		},
	},
	capabilities: ["write:editor.text", "write:editor-destructive"],
	fills: {
		"palette.commands": [
			{ id: "wrap.double", title: "Wrap in double quotes", handler: "wrapSelection", args: { open: '"', close: '"' } },
			{ id: "strip.formatting", title: "Strip all formatting", handler: "stripFormatting" },
		],
	},
};

let dir;
let hostPath;
let weakenedPath;
let modPath;
let baselinePath;

before(async () => {
	dir = await mkdtemp(join(tmpdir(), "xript-commands-"));
	hostPath = join(dir, "host.json");
	weakenedPath = join(dir, "weakened.json");
	modPath = join(dir, "mod.json");
	baselinePath = join(dir, "baseline.json");
	await writeFile(hostPath, JSON.stringify(HOST), "utf-8");
	await writeFile(weakenedPath, JSON.stringify(WEAKENED), "utf-8");
	await writeFile(modPath, JSON.stringify(MOD), "utf-8");
	const { stdout } = await run("score", hostPath, modPath, "--json");
	await writeFile(baselinePath, stdout, "utf-8");
});

after(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("xript score — command slots", () => {
	test("reports command slots beside the headline without adding a capacity surface", async () => {
		const { stdout, exitCode } = await run("score", hostPath, modPath);
		assert.equal(exitCode, 0);
		assert.match(stdout, /command slots \(informational — a command slot is a slot, already counted\)/);
		assert.match(stdout, /declared: palette\.commands/);
		assert.match(stdout, /gated: palette\.commands/);
		assert.ok(!stdout.includes("exposed: slots, capabilities, commands"));
	});

	test("names command slots in the disclaimer the way it names formats", async () => {
		const { stdout } = await run("score", hostPath, modPath);
		assert.match(stdout, /a command slot is a slot, already counted, so it refines the slot surface rather than adding a sixth one/);
	});

	test("carries the command surface into --json", async () => {
		const { stdout } = await run("score", hostPath, modPath, "--json");
		const result = JSON.parse(stdout);
		assert.deepEqual(result.commands, {
			slots: ["palette.commands"],
			constrained: [],
			gated: ["palette.commands"],
			singular: [],
			unreachable: [],
		});
		assert.ok(!result.capacity.exposed.includes("commands"));
		assert.ok(!result.capacity.absent.includes("commands"));
	});

	test("omits the section for a host with no command slot", async () => {
		const plain = join(dir, "plain.json");
		await writeFile(plain, JSON.stringify({ xript: "0.8", name: "h", slots: [{ id: "s", accepts: ["text/html"] }] }), "utf-8");
		const { stdout } = await run("score", plain);
		assert.ok(!stdout.includes("command slots"));
	});
});

describe("xript score-diff — command slots", () => {
	test("reports a weakened command surface that the headline does not move", async () => {
		const { stdout, exitCode } = await run("score-diff", baselinePath, weakenedPath, modPath);
		assert.equal(exitCode, 0);
		assert.match(stdout, /command slots:/);
		assert.match(stdout, /gained: menu\.commands/);
		assert.match(stdout, /newly ungated: palette\.commands/);
		assert.match(stdout, /narrowed to one command: palette\.commands/);
	});

	test("stays quiet when nothing about the command surface moved", async () => {
		const { stdout } = await run("score-diff", baselinePath, hostPath, modPath);
		assert.ok(!stdout.includes("command slots:"));
	});
});

describe("xript score-diff — a baseline that is not a saved score", () => {
	test("names the mistake when handed a manifest instead of a score", async () => {
		const { stderr, exitCode } = await run("score-diff", hostPath, hostPath);
		assert.equal(exitCode, 1);
		assert.ok(!stderr.includes("Cannot read properties"), "leaked an internal TypeError");
		assert.match(stderr, /is not a saved score/);
		assert.match(stderr, /xript score .* --json/);
	});

	test("names the mistake when the baseline is not JSON at all", async () => {
		const notJson = join(dir, "notjson.md");
		await writeFile(notJson, "# not a score\n", "utf-8");
		const { stderr, exitCode } = await run("score-diff", notJson, hostPath);
		assert.equal(exitCode, 1);
		assert.match(stderr, /is not valid JSON/);
		assert.match(stderr, /xript score .* --json/);
	});

	test("names the mistake when the baseline file is missing", async () => {
		const { stderr, exitCode } = await run("score-diff", join(dir, "absent.json"), hostPath);
		assert.equal(exitCode, 1);
		assert.ok(!stderr.includes("ENOENT"), "leaked a raw errno artifact");
		assert.match(stderr, /could not be read/);
		assert.match(stderr, /xript score .* --json/);
	});

	test("still accepts a real saved score", async () => {
		const { stdout, exitCode } = await run("score-diff", baselinePath, hostPath);
		assert.equal(exitCode, 0);
		assert.match(stdout, /moddability/);
	});
});

describe("xript lint — command findings", () => {
	test("flags a singular, ungated command slot", async () => {
		const { stdout, exitCode } = await run("lint", weakenedPath);
		assert.equal(exitCode, 0);
		assert.match(stdout, /\[command-slot-singular\] command slot "palette\.commands"/);
		assert.match(stdout, /\[command-slot-ungated\] command slot "palette\.commands"/);
	});

	test("errors on a fill carrying its own capability", async () => {
		const bad = join(dir, "bad.json");
		await writeFile(
			bad,
			JSON.stringify({
				xript: "0.8",
				name: "bad",
				entry: { script: "m.js", format: "module", exports: { run: { description: "r" } } },
				capabilities: ["write:editor.text"],
				fills: { "palette.commands": [{ id: "a", handler: "run", capability: "write:editor.text" }] },
			}),
			"utf-8",
		);
		const { stdout, exitCode } = await run("lint", hostPath, bad);
		assert.equal(exitCode, 1);
		assert.match(stdout, /\[command-fill-capability\]/);
		assert.match(stdout, /move it to entry\.exports\.run\.capability/);
	});

	test("reports a bare id shared across mods without calling it an error", async () => {
		const other = join(dir, "other.json");
		await writeFile(
			other,
			JSON.stringify({
				xript: "0.8",
				name: "other",
				version: "1.0.0",
				entry: { script: "m.js", format: "module", exports: { go: { description: "g" } } },
				capabilities: ["write:editor.text"],
				fills: { "palette.commands": [{ id: "wrap.double", handler: "go" }] },
			}),
			"utf-8",
		);
		const { stdout, exitCode } = await run("lint", hostPath, modPath, other);
		assert.equal(exitCode, 0);
		assert.match(stdout, /\[command-id-collision\] command id "wrap\.double"/);
	});
});

describe("xript typegen — commands", () => {
	test("emits the host's command slot contracts", async () => {
		const { stdout, exitCode } = await run("typegen", hostPath);
		assert.equal(exitCode, 0);
		assert.match(stdout, /namespace commandSlots \{/);
		assert.match(stdout, /type CommandSlotId = "palette\.commands";/);
		assert.match(stdout, /declare type XriptCommandHandler</);
	});

	test("emits a mod's command catalog", async () => {
		const { stdout, exitCode } = await run("typegen", modPath, "--host", hostPath);
		assert.equal(exitCode, 0);
		assert.match(stdout, /declare namespace commands \{/);
		assert.match(stdout, /"wrap\.double": \(args\?: \{ open\?: string; close\?: string \}\) => unknown;/);
		assert.match(stdout, /type Id = keyof Catalog;/);
	});

	test("rejects --host without a path", async () => {
		const { stderr, exitCode } = await run("typegen", modPath, "--host");
		assert.equal(exitCode, 1);
		assert.match(stderr, /--host requires a manifest path/);
	});
});

describe("xript docgen — commands", () => {
	test("writes a Commands section for the host", async () => {
		const out = join(dir, "host-docs");
		const { exitCode } = await run("docgen", hostPath, "--output", out);
		assert.equal(exitCode, 0);
		const { readFile } = await import("node:fs/promises");
		const index = await readFile(join(out, "index.md"), "utf-8");
		assert.match(index, /## Commands/);
		assert.match(index, /\| `palette\.commands` \| `write:editor\.text` \| Yes \| open \(no `payload` constraint\) \|/);
	});

	test("writes a mod's command catalog with the Requires column resolved against the host", async () => {
		const out = join(dir, "mod-docs");
		const { exitCode } = await run("docgen", modPath, "--output", out, "--host", hostPath);
		assert.equal(exitCode, 0);
		const { readFile } = await import("node:fs/promises");
		const index = await readFile(join(out, "index.md"), "utf-8");
		assert.match(index, /\| Id \| Title \| Handler \| Requires \| Bound args \| Input \| Output \|/);
		assert.match(index, /`wrap\.double`[^\n]*`write:editor\.text`/);
		assert.match(index, /`strip\.formatting`[^\n]*`write:editor-destructive`/);
	});
});
