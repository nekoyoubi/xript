import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "../dist/index.js";
import { loadGuidanceIndex, loadGuidanceTopic, loadSpecResource } from "../dist/index.js";

async function connectedClient(configure) {
	const server = await createServer("0.0.0-test");
	const client = new Client({ name: "test", version: "0.0.0" }, configure?.capabilities ? { capabilities: configure.capabilities } : undefined);
	if (configure?.onRoots) {
		client.setRequestHandler(ListRootsRequestSchema, configure.onRoots);
	}
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
	return { client, server };
}

function textOf(result) {
	return result.content.map((part) => part.text).join("\n");
}

describe("content loader", () => {
	it("lists guidance topics", async () => {
		const topics = await loadGuidanceIndex();
		const ids = topics.map((topic) => topic.id);
		assert.ok(ids.includes("when-to-use"));
		assert.ok(ids.includes("surfaces"));
		assert.ok(ids.includes("mod-zero"));
		assert.ok(ids.includes("hosting"));
		assert.ok(ids.includes("host-fragments"));
		assert.ok(ids.includes("host-capabilities"));
		assert.ok(ids.includes("host-slots"));
		assert.ok(ids.includes("host-roles"));
		assert.ok(ids.includes("host-hooks"));
		assert.ok(ids.includes("host-safety"));
	});

	it("loads a guidance topic body", async () => {
		const loaded = await loadGuidanceTopic("surfaces");
		assert.ok(loaded);
		assert.match(loaded.body, /extensibility surface/i);
	});

	it("returns null for an unknown topic", async () => {
		assert.equal(await loadGuidanceTopic("nope"), null);
	});

	it("loads a spec resource from synced content", async () => {
		const loaded = await loadSpecResource("manifest");
		assert.ok(loaded);
		assert.ok(loaded.body.length > 0);
	});
});

describe("mcp server surface", () => {
	it("registers the tool catalog", async () => {
		const { client } = await connectedClient();
		const { tools } = await client.listTools();
		const names = tools.map((tool) => tool.name);
		for (const expected of ["xript_server_info", "xript_validate", "xript_cross_validate", "xript_typegen", "xript_docgen", "xript_sanitize", "xript_scaffold", "xript_scan", "xript_manifest_describe", "xript_run", "xript_score", "xript_score_diff", "xript_lint", "xript_guide"]) {
			assert.ok(names.includes(expected), `missing tool ${expected}`);
		}
	});

	it("reports a build stamp through server_info so staleness is visible", async () => {
		const { client } = await connectedClient();
		const result = await client.callTool({ name: "xript_server_info", arguments: {} });
		const info = JSON.parse(textOf(result));
		assert.equal(info.name, "xript");
		assert.equal(typeof info.version, "string");
		assert.ok(info.builtAt === "unknown" || !Number.isNaN(Date.parse(info.builtAt)), "builtAt is a timestamp");
	});

	it("registers spec and guidance resources", async () => {
		const { client } = await connectedClient();
		const { resources } = await client.listResources();
		const uris = resources.map((resource) => resource.uri);
		assert.ok(uris.includes("xript://spec/manifest"));
		assert.ok(uris.includes("xript://guidance/surfaces"));
	});

	it("registers advisory prompts", async () => {
		const { client } = await connectedClient();
		const { prompts } = await client.listPrompts();
		const names = prompts.map((prompt) => prompt.name);
		for (const expected of ["adopt-xript", "is-this-xript-native", "choose-a-surface", "author-a-mod"]) {
			assert.ok(names.includes(expected), `missing prompt ${expected}`);
		}
	});
});

describe("tools", () => {
	it("guide lists topics when called with no argument", async () => {
		const { client } = await connectedClient();
		const result = await client.callTool({ name: "xript_guide", arguments: {} });
		assert.match(textOf(result), /when-to-use/);
	});

	it("guide returns a topic body", async () => {
		const { client } = await connectedClient();
		const result = await client.callTool({ name: "xript_guide", arguments: { topic: "mod-zero" } });
		assert.match(textOf(result), /first mod/i);
	});

	it("validate accepts a minimal manifest", async () => {
		const { client } = await connectedClient();
		const result = await client.callTool({ name: "xript_validate", arguments: { manifest: JSON.stringify({ xript: "0.3", name: "demo" }) } });
		assert.match(textOf(result), /valid/);
		assert.notEqual(result.isError, true);
	});

	it("validate reports invalid JSON as an error", async () => {
		const { client } = await connectedClient();
		const result = await client.callTool({ name: "xript_validate", arguments: { manifest: "{ not json" } });
		assert.equal(result.isError, true);
	});

	it("run loads a mod and invokes an export", async () => {
		const { client } = await connectedClient();
		const result = await client.callTool({
			name: "xript_run",
			arguments: {
				modManifest: JSON.stringify({ xript: "0.5", name: "m", version: "1.0.0", entry: { script: "mod.js", format: "module" } }),
				source: "export function add(a, b) { return a + b; }",
				invokeExport: "add",
				invokeArgs: "[2, 3]",
			},
		});
		const parsed = JSON.parse(textOf(result));
		assert.equal(parsed.loaded, true);
		assert.equal(parsed.result, 5);
	});

	it("scores a host's extensibility", async () => {
		const { client } = await connectedClient();
		const host = JSON.stringify({
			xript: "0.3",
			name: "h",
			slots: [
				{ id: "used", accepts: ["text/html"], capability: "capA", multiple: false },
				{ id: "dead", accepts: ["text/html"], capability: "capA", multiple: false },
			],
			capabilities: { capA: { description: "Cap A." } },
		});
		const mod = JSON.stringify({ xript: "0.3", name: "m", version: "1.0.0", capabilities: ["capA"], fragments: [{ id: "f", slot: "used", format: "text/html", source: "f.html" }] });
		const result = await client.callTool({ name: "xript_score", arguments: { host, mods: [mod] } });
		const parsed = JSON.parse(textOf(result));
		assert.equal(parsed.slots.score, 0.5);
		assert.deepEqual(parsed.slots.unused, ["dead"]);
	});

	it("diffs a score against a baseline", async () => {
		const { client } = await connectedClient();
		const host = JSON.stringify({
			xript: "0.3",
			name: "h",
			slots: [
				{ id: "a", accepts: ["text/html"], capability: "ui", description: "A." },
				{ id: "b", accepts: ["text/html"], capability: "ui", description: "B." },
			],
			capabilities: { ui: { description: "UI." } },
		});
		const modA = JSON.stringify({ xript: "0.3", name: "ma", version: "1.0.0", capabilities: ["ui"], fills: { a: [{ format: "text/html" }] } });
		const modB = JSON.stringify({ xript: "0.3", name: "mb", version: "1.0.0", capabilities: ["ui"], fills: { b: [{ format: "text/html" }] } });
		const baselineResult = await client.callTool({ name: "xript_score", arguments: { host, mods: [modA] } });
		const baseline = textOf(baselineResult);
		const diffResult = await client.callTool({ name: "xript_score_diff", arguments: { baseline, host, mods: [modA, modB] } });
		const diff = JSON.parse(textOf(diffResult));
		assert.equal(diff.headline.delta, 0, "the capacity headline is unaffected by how many slots the mods fill");
		assert.equal(diff.direction, "unchanged");
		assert.deepEqual(diff.slots.gained, ["b"]);
	});

	it("lints a host/mod fit and reports findings", async () => {
		const { client } = await connectedClient();
		const host = JSON.stringify({
			xript: "0.3",
			name: "h",
			slots: [{ id: "panel", accepts: ["text/html"], capability: "capA", description: "A panel." }],
			capabilities: { capA: { description: "Cap A." } },
		});
		const mod = JSON.stringify({ xript: "0.3", name: "m", version: "1.0.0", capabilities: ["capA"], fills: { ghost: [{ format: "text/html" }] } });
		const result = await client.callTool({ name: "xript_lint", arguments: { host, mods: [mod] } });
		const parsed = JSON.parse(textOf(result));
		assert.ok(parsed.findings.some((f) => f.code === "filled-but-undeclared"));
		assert.ok(parsed.counts.error >= 1);
		assert.equal(result.isError, true);
	});

	it("accepts a manifest file path instead of inline content", async () => {
		const dir = mkdtempSync(join(tmpdir(), "xript-path-"));
		const hostPath = join(dir, "host.json");
		writeFileSync(
			hostPath,
			JSON.stringify({
				xript: "0.3",
				name: "h",
				slots: [{ id: "s", accepts: ["text/html"], capability: "capA", description: "S." }],
				capabilities: { capA: { description: "A." } },
			}),
		);
		const { client } = await connectedClient();
		const result = await client.callTool({ name: "xript_lint", arguments: { host: hostPath } });
		const parsed = JSON.parse(textOf(result));
		assert.ok(parsed.findings.some((f) => f.code === "dead-slot"), "read the host from the path and linted it");
	});

	it("resolves extends before scoring so inherited surface lifts capacity", async () => {
		const dir = mkdtempSync(join(tmpdir(), "xript-extends-"));
		writeFileSync(
			join(dir, "base.json"),
			JSON.stringify({
				xript: "0.3",
				name: "base",
				slots: [{ id: "inherited", accepts: ["text/html"], capability: "capA", description: "Inherited." }],
				capabilities: { capA: { description: "A." } },
			}),
		);
		const childPath = join(dir, "host.json");
		writeFileSync(childPath, JSON.stringify({ xript: "0.3", name: "h", extends: "./base.json" }));
		const { client } = await connectedClient();
		const result = await client.callTool({ name: "xript_score", arguments: { host: childPath } });
		const parsed = JSON.parse(textOf(result));
		assert.ok(parsed.capacity.exposed.includes("slots"), "the inherited slot was resolved into the scored surface and counts toward capacity");
		assert.ok(parsed.capacity.exposed.includes("capabilities"));
		assert.deepEqual(parsed.slots.unused, [], "inherited slots are informational-coverage-excluded, never penalized");
	});

	it("accepts a mod manifest that declares a license", async () => {
		const { client } = await connectedClient();
		const result = await client.callTool({
			name: "xript_validate",
			arguments: { manifest: JSON.stringify({ xript: "0.3", name: "m", version: "1.0.0", license: "Proprietary", capabilities: ["ui"], entry: "main.js" }) },
		});
		assert.equal(result.isError ?? false, false, "a mod license validates");
		assert.match(textOf(result), /valid ✓/);
	});

	it("reads a guidance resource", async () => {
		const { client } = await connectedClient();
		const result = await client.readResource({ uri: "xript://guidance/surfaces" });
		assert.match(result.contents[0].text, /binding/i);
	});

	it("scan rejects a relative directory path when no roots are offered", async () => {
		const { client } = await connectedClient();
		const result = await client.callTool({ name: "xript_scan", arguments: { dir: "src/" } });
		assert.equal(result.isError, true);
		assert.match(textOf(result), /absolute/i);
	});

	it("scan resolves a relative path against a client-provided root", async () => {
		const root = mkdtempSync(join(tmpdir(), "xript-scan-"));
		const { client } = await connectedClient({
			capabilities: { roots: {} },
			onRoots: () => ({ roots: [{ uri: pathToFileURL(root).href, name: "workspace" }] }),
		});
		const result = await client.callTool({ name: "xript_scan", arguments: { dir: "." } });
		assert.notEqual(result.isError, true);
		assert.doesNotMatch(textOf(result), /absolute/i);
	});
});

describe("mcp harnessed host sessions", () => {
	const HOST = {
		xript: "0.7",
		name: "mcp-harness-host",
		capabilities: { fs: { description: "file access" } },
		bindings: {
			fs: { description: "files", members: { read: { description: "read", capability: "fs", returns: "string" } } },
		},
		events: [{ id: "tick", description: "frame" }],
	};
	const MOD = {
		xript: "0.6",
		name: "mcp-probe",
		version: "1.0.0",
		capabilities: ["fs"],
		entry: { script: "mod.js", format: "module", exports: { probe: { description: "p" } } },
	};
	const MOD_SOURCE = "export function probe(path) { return fs.read(path); }";

	it("registers the session tool family", async () => {
		const { client } = await connectedClient();
		const { tools } = await client.listTools();
		const names = tools.map((tool) => tool.name);
		for (const expected of ["xript_host_load", "xript_host_step", "xript_host_journal", "xript_host_list", "xript_host_unload"]) {
			assert.ok(names.includes(expected), `missing tool ${expected}`);
		}
	});

	it("drives a full load → step → journal → unload session", async () => {
		const { client } = await connectedClient();
		const loaded = await client.callTool({
			name: "xript_host_load",
			arguments: {
				manifest: JSON.stringify(HOST),
				harness: JSON.stringify({ bindings: { "fs.read": { returns: "session content" } } }),
			},
		});
		assert.notEqual(loaded.isError, true, textOf(loaded));
		const { hostId, summary } = JSON.parse(textOf(loaded));
		assert.equal(summary.host, "mcp-harness-host");
		assert.deepEqual(summary.capabilities, ["fs"]);

		const listed = await client.callTool({ name: "xript_host_list", arguments: {} });
		assert.ok(JSON.parse(textOf(listed)).some((entry) => entry.id === hostId));

		const modLoad = await client.callTool({
			name: "xript_host_step",
			arguments: { hostId, action: "load-mod", manifest: JSON.stringify(MOD), source: MOD_SOURCE },
		});
		assert.notEqual(modLoad.isError, true, textOf(modLoad));

		const invoked = await client.callTool({
			name: "xript_host_step",
			arguments: { hostId, action: "invoke", exportName: "probe", args: ["mcp.txt"] },
		});
		assert.notEqual(invoked.isError, true, textOf(invoked));
		assert.equal(JSON.parse(textOf(invoked)), "session content");

		const emitted = await client.callTool({
			name: "xript_host_step",
			arguments: { hostId, action: "emit", event: "tick", payload: 3 },
		});
		assert.notEqual(emitted.isError, true, textOf(emitted));

		const journal = await client.callTool({ name: "xript_host_journal", arguments: { hostId } });
		const entries = JSON.parse(textOf(journal));
		assert.ok(entries.some((entry) => entry.kind === "binding" && entry.binding === "fs.read" && entry.returned === "session content"));

		const unloaded = await client.callTool({ name: "xript_host_unload", arguments: { hostId } });
		assert.notEqual(unloaded.isError, true);

		const gone = await client.callTool({ name: "xript_host_journal", arguments: { hostId } });
		assert.equal(gone.isError, true);
	});

	it("errors cleanly on an unknown session id", async () => {
		const { client } = await connectedClient();
		const result = await client.callTool({ name: "xript_host_step", arguments: { hostId: "host-999", action: "invoke", exportName: "x" } });
		assert.equal(result.isError, true);
		assert.match(textOf(result), /xript_host_load/);
	});
});
