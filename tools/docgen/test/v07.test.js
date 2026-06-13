import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateDocs } from "../dist/index.js";

function findPage(result, slug) {
	return result.pages.find((p) => p.slug === slug);
}

describe("scoped and moded capability descriptions", () => {
	it("describes a bare binding capability as write access to its scope", () => {
		const result = generateDocs({
			xript: "0.7",
			name: "test",
			bindings: { writeAddon: { description: "Writes an addon.", capability: "fs.addon" } },
		});
		const page = findPage(result, "bindings/writeAddon");
		assert.ok(page);
		assert.match(page.content, /## Requires Capability/);
		assert.match(page.content, /Requires capability: `fs\.addon`/);
		assert.match(page.content, /write access to the `fs\.addon` scope/);
		assert.match(page.content, /any dotted ancestor/);
	});

	it("describes a read-prefixed binding capability as read access to the bare scope", () => {
		const result = generateDocs({
			xript: "0.7",
			name: "test",
			bindings: { readAddon: { description: "Reads an addon.", capability: "read:fs.addon" } },
		});
		const page = findPage(result, "bindings/readAddon");
		assert.match(page.content, /Requires capability: `read:fs\.addon`/);
		assert.match(page.content, /read access to the `fs\.addon` scope/);
	});

	it("describes a write-prefixed binding capability as write access to the bare scope", () => {
		const result = generateDocs({
			xript: "0.7",
			name: "test",
			bindings: { runCommand: { description: "Runs a command.", capability: "write:run.command" } },
		});
		const page = findPage(result, "bindings/runCommand");
		assert.match(page.content, /Requires capability: `write:run\.command`/);
		assert.match(page.content, /write access to the `run\.command` scope/);
	});

	it("describes a moded namespace member capability", () => {
		const result = generateDocs({
			xript: "0.7",
			name: "test",
			bindings: {
				player: {
					description: "Player functions.",
					members: {
						setHealth: { description: "Sets health.", capability: "write:player.stats" },
					},
				},
			},
		});
		const page = findPage(result, "bindings/player");
		assert.match(page.content, /Requires capability: `write:player\.stats`/);
		assert.match(page.content, /write access to the `player\.stats` scope/);
	});

	it("describes a moded hook capability preserving dotted segments", () => {
		const result = generateDocs({
			xript: "0.7",
			name: "test",
			hooks: { onRun: { description: "Run hook.", capability: "read:run.command.shell" } },
		});
		const page = findPage(result, "hooks/onRun");
		assert.match(page.content, /Requires capability: `read:run\.command\.shell`/);
		assert.match(page.content, /read access to the `run\.command\.shell` scope/);
	});
});

describe("capabilities table with scope awareness", () => {
	it("renders a Scope column and marks nested vs top-level scopes", () => {
		const result = generateDocs({
			xript: "0.7",
			name: "test",
			capabilities: {
				run: { description: "Run things.", risk: "medium" },
				"run.command": { description: "Run a command.", risk: "high" },
			},
		});
		const index = findPage(result, "index");
		assert.match(index.content, /\| Capability \| Scope \| Description \| Risk \|/);
		assert.match(index.content, /\| `run` \| top-level \|/);
		assert.match(index.content, /\| `run\.command` \| nested \(depth 2\) \|/);
	});

	it("explains scope subsumption when any capability is dotted", () => {
		const result = generateDocs({
			xript: "0.7",
			name: "test",
			capabilities: { "run.command": { description: "Run a command." } },
		});
		const index = findPage(result, "index");
		assert.match(index.content, /grant on a parent scope also satisfies/);
		assert.match(index.content, /does not subsume the unrelated sibling `runner`|not the unrelated sibling `runner`/);
	});

	it("omits the subsumption note when no capability is dotted", () => {
		const result = generateDocs({
			xript: "0.7",
			name: "test",
			capabilities: { storage: { description: "Storage." } },
		});
		const index = findPage(result, "index");
		assert.ok(!index.content.includes("grant on a parent scope also satisfies"));
	});

	it("notes that declared keys are scope-only", () => {
		const result = generateDocs({
			xript: "0.7",
			name: "test",
			capabilities: { storage: { description: "Storage." } },
		});
		const index = findPage(result, "index");
		assert.match(index.content, /Declared capability keys are scope-only/);
		assert.match(index.content, /`write` ⊒ `read`/);
	});
});

describe("Capability Requirements grouping", () => {
	it("groups gate sites under the capability they require", () => {
		const result = generateDocs({
			xript: "0.7",
			name: "test",
			capabilities: { "fs.addon": { description: "Filesystem addon access." } },
			bindings: {
				readAddon: { description: "Reads.", capability: "read:fs.addon" },
			},
			hooks: {
				onAddonChange: { description: "Addon changed.", capability: "fs.addon" },
			},
		});
		const index = findPage(result, "index");
		assert.match(index.content, /## Capability Requirements/);
		assert.match(index.content, /### `fs\.addon`/);
		assert.match(index.content, /\[`readAddon\(\)`\]\(\.\/bindings\/readAddon\.md\) \*\(binding\)\*/);
		assert.match(index.content, /\[`onAddonChange`\]\(\.\/hooks\/onAddonChange\.md\) \*\(hook\)\*/);
	});

	it("lists slot and event gate sites in the grouping", () => {
		const result = generateDocs({
			xript: "0.7",
			name: "test",
			capabilities: { "ui.mount": { description: "Mount UI." } },
			slots: [{ id: "main.overlay", accepts: ["text/html"], capability: "ui.mount" }],
			events: [{ id: "ui.opened", description: "UI opened.", capability: "read:ui.mount" }],
		});
		const index = findPage(result, "index");
		assert.match(index.content, /### `ui\.mount`/);
		assert.match(index.content, /`main\.overlay` \*\(slot\)\*/);
		assert.match(index.content, /`ui\.opened` \*\(event\)\*/);
	});

	it("surfaces subsumed requirements under an ancestor scope grant", () => {
		const result = generateDocs({
			xript: "0.7",
			name: "test",
			capabilities: {
				run: { description: "Run things." },
				"run.command": { description: "Run a command." },
			},
			bindings: {
				runAnything: { description: "Runs.", capability: "run" },
				runCommand: { description: "Runs a command.", capability: "run.command" },
			},
		});
		const index = findPage(result, "index");
		const runSection = index.content.slice(index.content.indexOf("### `run`"));
		assert.match(runSection, /A grant on `run` also satisfies, by scope subsumption/);
		assert.match(runSection, /\[`runCommand\(\)`\]\(\.\/bindings\/runCommand\.md\) \*\(binding\)\* — requires `run\.command`/);
	});

	it("does not treat an unrelated sibling scope as subsumed", () => {
		const result = generateDocs({
			xript: "0.7",
			name: "test",
			capabilities: {
				run: { description: "Run things." },
				runner: { description: "Runner management." },
			},
			bindings: {
				runAnything: { description: "Runs.", capability: "run" },
				manageRunner: { description: "Manages runner.", capability: "runner" },
			},
		});
		const index = findPage(result, "index");
		const runHeader = "### `run`\n";
		const runStart = index.content.indexOf(runHeader);
		const runnerStart = index.content.indexOf("### `runner`");
		const runSection = index.content.slice(runStart, runnerStart);
		assert.ok(!runSection.includes("manageRunner"));
	});

	it("omits the Capability Requirements section when nothing is gated", () => {
		const result = generateDocs({
			xript: "0.7",
			name: "test",
			capabilities: { storage: { description: "Storage." } },
			bindings: { log: { description: "Logs." } },
		});
		const index = findPage(result, "index");
		assert.ok(!index.content.includes("## Capability Requirements"));
	});
});

describe("event subscription and capability gating docs", () => {
	it("documents the events.on subscription verb and its capability gate", () => {
		const result = generateDocs({
			xript: "0.7",
			name: "host",
			events: [{ id: "tick", description: "Heartbeat." }],
		});
		const index = findPage(result, "index");
		assert.match(index.content, /events\.on\(/);
		assert.match(index.content, /events\.subscribe/);
		assert.match(index.content, /capability-gated per event at registration time/);
	});

	it("adds a Capability column to the events table when any event is gated", () => {
		const result = generateDocs({
			xript: "0.7",
			name: "host",
			events: [
				{ id: "tab.opened", description: "Tab opened.", capability: "read:tabs" },
				{ id: "app.ready", description: "App ready." },
			],
		});
		const index = findPage(result, "index");
		assert.match(index.content, /\| Event \| Payload \| Capability \| Description \|/);
		assert.match(index.content, /\| `tab\.opened` \| — \| `read:tabs` \| Tab opened\. \|/);
		assert.match(index.content, /\| `app\.ready` \| — \| — \| App ready\. \|/);
	});

	it("keeps the three-column events table when no event is gated", () => {
		const result = generateDocs({
			xript: "0.7",
			name: "host",
			events: [{ id: "tick", description: "Heartbeat." }],
		});
		const index = findPage(result, "index");
		assert.match(index.content, /\| Event \| Payload \| Description \|/);
		assert.ok(!index.content.includes("| Event | Payload | Capability | Description |"));
	});
});

describe("libraries section", () => {
	it("renders a Libraries table on the index page", () => {
		const result = generateDocs({
			xript: "0.7",
			name: "library-host",
			libraries: {
				"@example/doc": { description: "Doc helpers.", capability: "lib.doc", version: "^1.0.0" },
				"open-lib": { description: "Ungated helpers." },
			},
		});
		const index = findPage(result, "index");
		assert.ok(index);
		assert.match(index.content, /## Libraries/);
		assert.match(index.content, /`@example\/doc` \| `\^1\.0\.0` \| `lib\.doc` \| Doc helpers\./);
		assert.match(index.content, /`open-lib` \| — \| — \| Ungated helpers\./);
	});
});

describe("event-typed slot hook folding", () => {
	it("lists an event-typed slot in the Hooks section", () => {
		const result = generateDocs({
			xript: "0.7",
			name: "h",
			slots: [{ id: "on-save", accepts: ["application/x-xript-hook"], description: "save hook" }],
		});
		const index = findPage(result, "index");
		assert.match(index.content, /## Hooks/);
		assert.match(index.content, /on-save/);
	});
});
