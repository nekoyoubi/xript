import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { generateModProjectFiles, generateProjectFiles } from "@xriptjs/init";
import { validateManifestVersioned } from "@xriptjs/validate";
import { createServer, loadGuidanceIndex, loadGuidanceTopic } from "../dist/index.js";

const execFileAsync = promisify(execFile);
const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "../dist/cli.js");
const VERSIONS = ["0.6", "0.7", "0.8", "0.9"];

async function run(...args) {
	try {
		const { stdout, stderr } = await execFileAsync("node", [CLI, ...args]);
		return { stdout, stderr, exitCode: 0 };
	} catch (err) {
		return { stdout: err.stdout || "", stderr: err.stderr || "", exitCode: err.code };
	}
}

async function connectedClient() {
	const server = await createServer("0.0.0-test");
	const client = new Client({ name: "test", version: "0.0.0" });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
	return client;
}

const textOf = (result) => result.content.map((part) => part.text).join("\n");

const host = (xript) => ({
	xript,
	name: "probe",
	bindings: { log: { description: "Logs.", params: [{ name: "parts", type: "string", variadic: true }] } },
});

let dir;
let host08;
let host09;

before(async () => {
	dir = await mkdtemp(join(tmpdir(), "xript-cli-versions-"));
	host08 = join(dir, "host-08.json");
	host09 = join(dir, "host-09.json");
	await writeFile(host08, JSON.stringify(host("0.8")));
	await writeFile(host09, JSON.stringify(host("0.9")));
});

after(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("cli --spec", () => {
	it("validate answers for the declared version and names it", async () => {
		const declared = await run("validate", host08);
		assert.equal(declared.exitCode, 1);
		assert.match(declared.stderr, /\(xript 0\.8\)/);
		const pinned = await run("validate", host08, "--spec", "0.9");
		assert.equal(pinned.exitCode, 0);
		assert.match(pinned.stdout, /\(xript 0\.9\)/);
	});

	it("validate refuses a version it does not speak", async () => {
		const { exitCode, stderr } = await run("validate", host09, "--spec", "0.5");
		assert.equal(exitCode, 1);
		assert.match(stderr, /does not speak|not a manifest version/);
	});

	it("typegen still generates, warning on stderr when the manifest breaks its version's schema", async () => {
		const { stdout, stderr, exitCode } = await run("typegen", host08);
		assert.equal(exitCode, 0);
		assert.match(stdout, /declare function log\(\.\.\.parts: string\[\]\): void;/);
		assert.match(stderr, /not valid against xript 0\.8/);
		const clean = await run("typegen", host09);
		assert.equal(clean.stderr, "");
	});

	it("lint reports a schema-version finding against the declared version", async () => {
		const { stdout, exitCode } = await run("lint", host08);
		assert.equal(exitCode, 1);
		assert.match(stdout, /\[schema-version\] host is not valid against xript 0\.8/);
		assert.doesNotMatch((await run("lint", host09)).stdout, /schema-version/);
	});

	it("init scaffolds manifests that declare the requested version", async () => {
		const target = join(dir, "scaffold");
		const { exitCode } = await run("init", target, "--yes", "--spec", "0.7");
		assert.equal(exitCode, 0);
		const manifest = JSON.parse(await readFile(join(target, "manifest.json"), "utf-8"));
		assert.equal(manifest.xript, "0.7");
		assert.equal(manifest.$schema, "https://xript.dev/schema/manifest/v0.7.json");
	});

	it("guide leads a changed topic with the requested version's note", async () => {
		const { stdout, exitCode } = await run("guide", "host-formats", "--spec", "0.7");
		assert.equal(exitCode, 0);
		assert.match(stdout, /^> \*\*In xript 0\.7:\*\*/);
	});
});

describe("mcp version argument", () => {
	it("server_info reports the toolchain version and the manifest versions it speaks", async () => {
		const client = await connectedClient();
		const info = JSON.parse(textOf(await client.callTool({ name: "xript_server_info", arguments: {} })));
		assert.equal(info.toolchainVersion, "0.0.0-test");
		assert.deepEqual(info.manifestVersions, VERSIONS);
		assert.equal(info.defaultManifestVersion, "0.9");
		assert.match(info.versionConvention, /version/);
	});

	it("validate answers for the declared version, or the requested one", async () => {
		const client = await connectedClient();
		const declared = await client.callTool({ name: "xript_validate", arguments: { manifest: JSON.stringify(host("0.8")) } });
		assert.equal(declared.isError, true);
		assert.match(textOf(declared), /target xript 0\.8 \(from the manifest's xript field\)/);
		const pinned = await client.callTool({ name: "xript_validate", arguments: { manifest: JSON.stringify(host("0.8")), version: "0.9" } });
		assert.notEqual(pinned.isError, true);
		assert.match(textOf(pinned), /target xript 0\.9 \(requested explicitly\)/);
	});

	it("validate refuses a version it does not speak", async () => {
		const client = await connectedClient();
		const result = await client.callTool({ name: "xript_validate", arguments: { manifest: JSON.stringify(host("0.9")), version: "0.4" } });
		assert.equal(result.isError, true);
	});

	it("cross_validate checks both manifests against the target version", async () => {
		const client = await connectedClient();
		const mod = { xript: "0.8", name: "m", version: "1.0.0" };
		const result = await client.callTool({
			name: "xript_cross_validate",
			arguments: { appManifest: JSON.stringify(host("0.8")), modManifest: JSON.stringify(mod) },
		});
		assert.equal(result.isError, true);
		assert.match(textOf(result), /app manifest:/);
		const pinned = await client.callTool({
			name: "xript_cross_validate",
			arguments: { appManifest: JSON.stringify(host("0.8")), modManifest: JSON.stringify(mod), version: "0.9" },
		});
		assert.notEqual(pinned.isError, true, textOf(pinned));
	});

	it("typegen and docgen return the output first and the version note second", async () => {
		const client = await connectedClient();
		for (const name of ["xript_typegen", "xript_docgen"]) {
			const result = await client.callTool({ name, arguments: { manifest: JSON.stringify(host("0.8")) } });
			assert.equal(result.content.length, 2);
			assert.match(result.content[1].text, /^target: xript 0\.8/);
			assert.match(result.content[1].text, /not valid against xript 0\.8/);
			const clean = await client.callTool({ name, arguments: { manifest: JSON.stringify(host("0.8")), version: "0.9" } });
			assert.equal(clean.content[1].text, "target: xript 0.9 (requested explicitly)");
		}
	});

	it("lint and manifest_describe answer for the target version", async () => {
		const client = await connectedClient();
		const lint = JSON.parse(textOf(await client.callTool({ name: "xript_lint", arguments: { host: JSON.stringify(host("0.8")) } })));
		assert.ok(lint.findings.some((finding) => finding.code === "schema-version"));
		const pinned = JSON.parse(textOf(await client.callTool({ name: "xript_lint", arguments: { host: JSON.stringify(host("0.8")), version: "0.9" } })));
		assert.ok(!pinned.findings.some((finding) => finding.code === "schema-version"));
		const describe = await client.callTool({ name: "xript_manifest_describe", arguments: { manifest: JSON.stringify(host("0.9")) } });
		assert.match(textOf(describe), /## Target version\s+target: xript 0\.9/);
	});

	it("scaffold writes the requested version into every manifest", async () => {
		const client = await connectedClient();
		const files = JSON.parse(textOf(await client.callTool({ name: "xript_scaffold", arguments: { name: "app", type: "app", tier: 2, version: "0.8" } })));
		assert.equal(JSON.parse(files["manifest.json"]).xript, "0.8");
		const refused = await client.callTool({ name: "xript_scaffold", arguments: { name: "app", type: "app", tier: 2, version: "1.0" } });
		assert.equal(refused.isError, true);
	});

	it("guide carries a version's note when asked and the full history when not", async () => {
		const client = await connectedClient();
		const pinned = textOf(await client.callTool({ name: "xript_guide", arguments: { topic: "authoring", version: "0.6" } }));
		assert.match(pinned, /^> \*\*In xript 0\.6:\*\*/);
		const history = textOf(await client.callTool({ name: "xript_guide", arguments: { topic: "authoring" } }));
		assert.match(history, /## Across versions/);
		for (const version of VERSIONS) assert.match(history, new RegExp(`- \\*\\*${version.replace(".", "\\.")}:\\*\\*`));
	});
});

describe("scaffolds at every version", () => {
	it("validate against the schema of the version they declare", async () => {
		for (const version of VERSIONS) {
			const sets = [
				...[2, 3, 4].map((tier) => generateProjectFiles({ name: "app", tier, language: "typescript", specVersion: version })),
				generateModProjectFiles({ name: "app", tier: 2, language: "typescript", specVersion: version }),
			];
			for (const files of sets) {
				for (const [path, body] of Object.entries(files)) {
					if (!/(^|\/)(manifest|mod-manifest|host-manifest)\.json$/.test(path)) continue;
					const manifest = JSON.parse(body);
					const result = await validateManifestVersioned(manifest);
					assert.equal(result.target.version, version, `${path} at ${version}`);
					assert.equal(result.valid, true, `${path} at ${version}: ${JSON.stringify(result.errors)}`);
				}
			}
		}
	});
});

describe("guide topics", () => {
	it("carry no em-dash, with or without a version", async () => {
		for (const topic of await loadGuidanceIndex()) {
			for (const version of [undefined, ...VERSIONS]) {
				const loaded = await loadGuidanceTopic(topic.id, version);
				assert.ok(!loaded.body.includes("—"), `${topic.id} (${version ?? "default"}) contains U+2014`);
			}
			assert.ok(!topic.summary.includes("—") && !topic.title.includes("—"), `${topic.id} index entry contains U+2014`);
		}
	});
});
