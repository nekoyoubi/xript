import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHarnessSession, runSteps } from "../dist/index.js";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const cliPath = resolve(__dirname, "..", "dist", "cli.js");

const HOST = {
	xript: "0.7",
	name: "harness-host-app",
	capabilities: {
		fs: { description: "file access" },
		net: { description: "network access" },
	},
	bindings: {
		ping: { description: "liveness check", returns: "string" },
		fs: {
			description: "file namespace",
			members: {
				read: { description: "read a file", capability: "fs", params: [{ name: "path", type: "string" }], returns: "string" },
			},
		},
		fetchData: { description: "fetch remote data", capability: "net" },
	},
	events: [{ id: "tick", description: "fired each frame" }],
	hooks: { save: { description: "fired on save" } },
	slots: [{ id: "panel", accepts: ["text/html"], description: "a panel" }],
};

const MOD = {
	xript: "0.6",
	name: "probe-mod",
	version: "1.0.0",
	capabilities: ["fs"],
	entry: {
		script: "mod.js",
		format: "module",
		exports: { probe: { description: "reads a path through the stubbed fs" } },
	},
};

const MOD_SOURCE = `export function probe(path) { return fs.read(path); }`;

describe("harness session — binding stubs", () => {
	it("defaults every declared binding to a recording stub and grants all declared capabilities", async () => {
		const session = await createHarnessSession({ appManifest: HOST });
		try {
			assert.deepEqual(session.summary.capabilities, ["fs", "net"]);
			assert.deepEqual(
				session.summary.bindings.map((binding) => binding.name).sort(),
				["fetchData", "fs.read", "ping"],
			);
			assert.ok(session.summary.bindings.every((binding) => binding.stub === "record"));
			await session.loadMod(MOD, MOD_SOURCE);
			const result = await session.invoke("probe", ["/etc/motd"]);
			assert.equal(result, undefined);
			const journal = session.journal();
			const call = journal.find((entry) => entry.kind === "binding" && entry.binding === "fs.read");
			assert.ok(call, "fs.read call was journaled");
			assert.deepEqual(call.args, ["/etc/motd"]);
		} finally {
			session.dispose();
		}
	});

	it("answers from a returns stub", async () => {
		const session = await createHarnessSession({
			appManifest: HOST,
			harness: { bindings: { "fs.read": { returns: "stubbed content" } } },
		});
		try {
			await session.loadMod(MOD, MOD_SOURCE);
			assert.equal(await session.invoke("probe", ["x"]), "stubbed content");
		} finally {
			session.dispose();
		}
	});

	it("walks a sequence and repeats the last entry once exhausted", async () => {
		const session = await createHarnessSession({
			appManifest: HOST,
			harness: { bindings: { "fs.read": { sequence: [{ returns: "first" }, { throws: "gone" }] } } },
		});
		try {
			await session.loadMod(MOD, MOD_SOURCE);
			assert.equal(await session.invoke("probe", ["a"]), "first");
			await assert.rejects(() => session.invoke("probe", ["b"]), /gone/);
			await assert.rejects(() => session.invoke("probe", ["c"]), /gone/);
			const outcomes = session.journal().filter((entry) => entry.kind === "binding" && entry.binding === "fs.read");
			assert.equal(outcomes.length, 3);
			assert.equal(outcomes[0].returned, "first");
			assert.equal(outcomes[1].threw, "gone");
		} finally {
			session.dispose();
		}
	});

	it("runs a script stub host-side with args and call count", async () => {
		const session = await createHarnessSession({
			appManifest: HOST,
			harness: { bindings: { "fs.read": { script: "return calls + ':' + args[0];" } } },
		});
		try {
			await session.loadMod(MOD, MOD_SOURCE);
			assert.equal(await session.invoke("probe", ["a.txt"]), "0:a.txt");
			assert.equal(await session.invoke("probe", ["b.txt"]), "1:b.txt");
		} finally {
			session.dispose();
		}
	});

	it("applies the * default to unnamed bindings", async () => {
		const session = await createHarnessSession({
			appManifest: HOST,
			harness: { bindings: { "*": { returns: 42 } } },
		});
		try {
			const value = await session.execute("return await ping();");
			assert.equal(value, 42);
		} finally {
			session.dispose();
		}
	});

	it("honors an explicit capability list and journals the denial path", async () => {
		const session = await createHarnessSession({
			appManifest: HOST,
			harness: { capabilities: ["net"], bindings: { "fs.read": { returns: "never" } } },
		});
		try {
			await session.loadMod(MOD, MOD_SOURCE);
			await assert.rejects(() => session.invoke("probe", ["x"]), /capability/i);
			assert.equal(await session.execute("return await ping();"), undefined);
		} finally {
			session.dispose();
		}
	});
});

describe("harness session — events, hooks, and steps", () => {
	it("delivers an emitted host event to a sandbox subscriber", async () => {
		const session = await createHarnessSession({ appManifest: HOST });
		try {
			await session.execute(`events.on("tick", function(payload) { return "saw " + JSON.stringify(payload); })`);
			const results = session.emit("tick", 7);
			assert.deepEqual(results, ["saw 7"]);
		} finally {
			session.dispose();
		}
	});

	it("fires a declared hook with data", async () => {
		const session = await createHarnessSession({ appManifest: HOST });
		try {
			await session.execute(`hooks.save(function(path) { return "saved " + path; })`);
			const results = session.fireHook("save", { data: { path: "/tmp/x" } });
			assert.deepEqual(results, ["saved /tmp/x"]);
		} finally {
			session.dispose();
		}
	});

	it("runs a steps scenario, capturing per-step failures without halting", async () => {
		const session = await createHarnessSession({
			appManifest: HOST,
			harness: { bindings: { "fs.read": { returns: "from steps" } } },
		});
		try {
			const results = await runSteps(session, [
				{ action: "load-mod", manifest: MOD, sourceText: MOD_SOURCE },
				{ action: "invoke", export: "probe", args: ["s.txt"] },
				{ action: "invoke", export: "missing" },
				{ action: "emit", event: "tick", payload: 1 },
				{ action: "resolve-slot", slot: "panel" },
				{ action: "journal" },
			]);
			assert.equal(results.length, 6);
			assert.ok(results[0].ok);
			assert.equal(results[1].result, "from steps");
			assert.equal(results[2].ok, false);
			assert.ok(results[3].ok);
			assert.ok(results[4].ok);
			assert.ok(results[5].ok);
			assert.ok(results[5].result.some((entry) => entry.kind === "binding" && entry.binding === "fs.read"));
		} finally {
			session.dispose();
		}
	});
});

describe("cli run — harnessed batch mode", () => {
	it("runs a steps file against a harnessed host and prints summary, steps, and journal", async () => {
		const dir = await mkdtemp(join(tmpdir(), "xript-harness-cli-"));
		try {
			await writeFile(join(dir, "host.json"), JSON.stringify(HOST));
			await writeFile(join(dir, "harness.json"), JSON.stringify({ bindings: { "fs.read": { returns: "batch content" } } }));
			await writeFile(join(dir, "mod.json"), JSON.stringify(MOD));
			await writeFile(join(dir, "mod.js"), MOD_SOURCE);
			await writeFile(
				join(dir, "steps.json"),
				JSON.stringify({
					steps: [
						{ action: "load-mod", manifest: "./mod.json", source: "./mod.js" },
						{ action: "invoke", export: "probe", args: ["cli.txt"] },
						{ action: "emit", event: "tick" },
					],
				}),
			);
			const { stdout } = await execFileAsync("node", [
				cliPath,
				"run",
				"--app",
				join(dir, "host.json"),
				"--harness",
				join(dir, "harness.json"),
				"--steps",
				join(dir, "steps.json"),
			], { encoding: "utf-8" });
			const output = JSON.parse(stdout);
			assert.equal(output.summary.host, "harness-host-app");
			assert.equal(output.steps.length, 3);
			assert.equal(output.steps[1].result, "batch content");
			assert.ok(output.journal.some((entry) => entry.kind === "binding" && entry.binding === "fs.read"));
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("exits non-zero when a step fails", async () => {
		const dir = await mkdtemp(join(tmpdir(), "xript-harness-fail-"));
		try {
			await writeFile(join(dir, "host.json"), JSON.stringify(HOST));
			await writeFile(join(dir, "steps.json"), JSON.stringify({ steps: [{ action: "invoke", export: "nope" }] }));
			await assert.rejects(
				() => execFileAsync("node", [cliPath, "run", "--app", join(dir, "host.json"), "--steps", join(dir, "steps.json")], { encoding: "utf-8" }),
				(error) => {
					assert.equal(error.code, 1);
					const output = JSON.parse(error.stdout);
					assert.equal(output.steps[0].ok, false);
					return true;
				},
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("harness session — approved libraries", () => {
	const LIB_HOST = {
		xript: "0.7",
		name: "lib-harness-host",
		capabilities: { lib: { description: "shared libraries" } },
		libraries: {
			"@example/doc": { description: "doc helpers", capability: "lib.doc" },
		},
	};
	const LIB_MOD = {
		xript: "0.7",
		name: "lib-consumer",
		version: "1.0.0",
		capabilities: ["lib.doc"],
		entry: { script: "mod.js", format: "module", exports: { use: { description: "uses the lib" } } },
	};

	it("registers harness library sources so a mod can import them", async () => {
		const session = await createHarnessSession({
			appManifest: LIB_HOST,
			harness: {
				libraries: { "@example/doc": { source: `export function shout(s){ return s.toUpperCase() + "!"; }` } },
			},
		});
		try {
			assert.deepEqual(session.summary.libraries, [{ specifier: "@example/doc", registered: true }]);
			await session.loadMod(LIB_MOD, `import { shout } from "@example/doc";\nexport function use(s){ return shout(s); }`);
			assert.equal(await session.invoke("use", ["hi"]), "HI!");
		} finally {
			session.dispose();
		}
	});

	it("reports an unregistered declared library in the summary and fails the import", async () => {
		const session = await createHarnessSession({ appManifest: LIB_HOST });
		try {
			assert.deepEqual(session.summary.libraries, [{ specifier: "@example/doc", registered: false }]);
			await assert.rejects(
				() => session.loadMod(LIB_MOD, `import { shout } from "@example/doc";\nexport function use(){ return 1; }`),
				/no source was registered/,
			);
		} finally {
			session.dispose();
		}
	});
});
