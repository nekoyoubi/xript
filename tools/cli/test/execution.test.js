import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describeManifest } from "../dist/describe.js";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(__dirname, "../dist/cli.js");

const host = {
	xript: "0.8",
	name: "intent-host",
	bindings: {
		getTick: { description: "Reads the tick.", execution: { duration: "instant" } },
		fetch: { description: "Fetches.", async: true, execution: { duration: "long" } },
		poll: { description: "Polls." },
	},
	hooks: { onSave: { description: "Fires on save.", execution: { duration: "unbounded" } } },
	slots: [{ id: "left", accepts: ["text/html"], description: "Left." }],
};

async function run(...args) {
	try {
		const { stdout, stderr } = await execFileAsync("node", [CLI, ...args]);
		return { stdout, stderr, exitCode: 0 };
	} catch (err) {
		return { stdout: err.stdout || "", stderr: err.stderr || "", exitCode: err.code };
	}
}

async function writeFile_(name, contents) {
	const dir = await mkdtemp(join(tmpdir(), "xript-cli-sanitize-"));
	const path = join(dir, name);
	await writeFile(path, contents, "utf-8");
	return path;
}

async function writeManifest(manifest, name = "manifest.json") {
	const dir = await mkdtemp(join(tmpdir(), "xript-cli-execution-"));
	const path = join(dir, name);
	await writeFile(path, JSON.stringify(manifest), "utf-8");
	return path;
}

describe("xript describe — execution intent", () => {
	test("summarizes the surface per lane", () => {
		const { summary } = describeManifest(host);
		assert.equal(summary.execution.instant, 1);
		assert.equal(summary.execution.brief, 2);
		assert.equal(summary.execution.long, 1);
		assert.equal(summary.execution.unbounded, 1);
		assert.equal(summary.execution.declared, 3);
		assert.equal(summary.execution.undeclared, 2);
		assert.equal(summary.execution.summary, "1 instant, 2 brief, 1 long, 1 unbounded (3 of 5 declared)");
	});

	test("prints the host-binding thread contract whenever the manifest has any binding", async () => {
		const path = await writeManifest(host);
		const { stdout, exitCode } = await run("describe", path, "--summary");
		assert.equal(exitCode, 0);
		assert.ok(stdout.includes("MUST be reentrant and thread-safe"));
		assert.ok(stdout.includes("xript does not and cannot serialize calls into host code"));
	});

	test("omits the contract for a manifest with no bindings", () => {
		const { footer } = describeManifest({ xript: "0.8", name: "bindingless", slots: [{ id: "a", accepts: ["text/html"] }] });
		assert.equal(footer, undefined);
	});

	test("does not print each doc page's title twice", async () => {
		const { docs } = describeManifest({
			xript: "0.8",
			name: "twice-host",
			title: "Twice Host",
			bindings: { log: { description: "Logs." } },
		});
		assert.ok(!/# Twice Host API Reference\s*\n\s*# Twice Host API Reference/.test(docs), "index title rendered twice");
		assert.ok(!/# log\(\)\s*\n\s*# log\(\)/.test(docs), "binding page title rendered twice");
		assert.ok(docs.includes("# Twice Host API Reference"), "the title is still present once");
		assert.ok(docs.includes("# log()"), "the binding heading is still present once");
	});
});

describe("xript lint — execution findings", () => {
	test("reports the declared-intent findings", async () => {
		const path = await writeManifest({
			xript: "0.8",
			name: "lint-host",
			capabilities: { net: { description: "Network." } },
			bindings: {
				grind: { description: "Grinds.", execution: { duration: "long" } },
				call: { description: "Calls.", capability: "net.http" },
			},
		});
		const { stdout } = await run("lint", path);
		// A binding cannot declare `limits` — the schema refuses the key — so a long one
		// is told to route the call rather than to widen a budget it has no way to write.
		assert.ok(stdout.includes("execution-long-binding-blocks"));
		assert.ok(!stdout.includes("execution-long-no-limits"));
		assert.ok(stdout.includes("execution-missing-on-networked"));
	});
});

describe("xript typegen --intent", () => {
	test("emits the routing table only when asked", async () => {
		const path = await writeManifest(host);
		const withFlag = await run("typegen", path, "--intent");
		assert.ok(withFlag.stdout.includes("export declare const xriptExecution"));
		assert.ok(withFlag.stdout.includes("MUST be reentrant and thread-safe"));
		const without = await run("typegen", path);
		assert.ok(!without.stdout.includes("xriptExecution"));
	});

	test("lists it in the help", async () => {
		const { stdout } = await run("typegen", "--help");
		assert.ok(stdout.includes("--intent"));
	});
});

describe("xript score — declared-intent signal", () => {
	test("reports declared-intent coverage and folds it into the headline", async () => {
		const path = await writeManifest(host);
		const { stdout } = await run("score", path, "--json");
		const result = JSON.parse(stdout);
		assert.equal(result.intent.declared.length, 3);
		assert.equal(result.intent.undeclared.length, 2);
		assert.equal(result.signals["declared-intent"], 3 / 5);
	});
});

describe("xript sanitize — reporting what it removed", () => {
	// `--quiet` documented itself as "no diagnostics", so the default documented itself as having
	// them, and printed none: stripping a script tag said nothing at all. A silent drop is the
	// failure mode this contract exists to end.
	test("reports removals by default, on stderr so a redirect still yields only markup", async () => {
		const path = await writeFile_("hostile.html", '<div onclick="x()"><script>y()</script><p>ok</p></div>');
		const { stdout, stderr } = await run("sanitize", path);
		assert.ok(stderr.includes("stripped dangerous element"), `stderr was: ${stderr}`);
		assert.match(stderr, /removed \d+ item\(s\)/, `stderr was: ${stderr}`);
		assert.ok(!stdout.includes("stripped"), "diagnostics must not land on stdout");
		assert.ok(stdout.includes("<p>ok</p>"));
	});

	test("stays silent under --quiet", async () => {
		const path = await writeFile_("hostile2.html", '<div onclick="x()"><p>ok</p></div>');
		const { stdout, stderr } = await run("sanitize", path, "--quiet");
		assert.equal(stderr.trim(), "");
		assert.ok(stdout.includes("<p>ok</p>"));
	});

	test("says nothing when nothing was removed", async () => {
		const path = await writeFile_("clean.html", "<p>fine</p>");
		const { stderr } = await run("sanitize", path);
		assert.equal(stderr.trim(), "");
	});
});
