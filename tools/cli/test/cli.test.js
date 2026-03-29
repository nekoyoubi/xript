import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(__dirname, "../dist/cli.js");
const FIXTURES = resolve(__dirname, "../../validate/test");
const EXAMPLE_MANIFEST = resolve(__dirname, "../../../examples/expression-evaluator/manifest.json");

async function run(...args) {
	try {
		const { stdout, stderr } = await execFileAsync("node", [CLI, ...args]);
		return { stdout, stderr, exitCode: 0 };
	} catch (err) {
		return { stdout: err.stdout || "", stderr: err.stderr || "", exitCode: err.code };
	}
}

describe("xript CLI dispatcher", () => {
	test("--help shows usage", async () => {
		const { stdout, exitCode } = await run("--help");
		assert.equal(exitCode, 0);
		assert.ok(stdout.includes("Usage: xript <command>"));
		assert.ok(stdout.includes("validate"));
		assert.ok(stdout.includes("typegen"));
		assert.ok(stdout.includes("docgen"));
		assert.ok(stdout.includes("init"));
		assert.ok(stdout.includes("sanitize"));
		assert.ok(stdout.includes("scan"));
	});

	test("--version prints version", async () => {
		const { stdout, exitCode } = await run("--version");
		assert.equal(exitCode, 0);
		assert.match(stdout.trim(), /^\d+\.\d+\.\d+$/);
	});

	test("no arguments shows help and exits 1", async () => {
		const { stdout, exitCode } = await run();
		assert.equal(exitCode, 1);
		assert.ok(stdout.includes("Usage: xript <command>"));
	});

	test("unknown command exits 1", async () => {
		const { stderr, exitCode } = await run("bogus");
		assert.equal(exitCode, 1);
		assert.ok(stderr.includes("Unknown command: bogus"));
	});
});

describe("xript validate", () => {
	test("validates a valid manifest", async () => {
		const { stdout, exitCode } = await run("validate", EXAMPLE_MANIFEST);
		assert.equal(exitCode, 0);
		assert.ok(stdout.includes("\u2713"));
	});

	test("reports invalid manifest", async () => {
		const { stderr, exitCode } = await run("validate", resolve(__dirname, "../package.json"));
		assert.equal(exitCode, 1);
		assert.ok(stderr.includes("\u2717"));
	});

	test("shows help", async () => {
		const { stdout, exitCode } = await run("validate", "--help");
		assert.equal(exitCode, 0);
		assert.ok(stdout.includes("xript validate"));
	});
});

describe("xript typegen", () => {
	test("generates types to stdout", async () => {
		const { stdout, exitCode } = await run("typegen", EXAMPLE_MANIFEST);
		assert.equal(exitCode, 0);
		assert.ok(stdout.includes("declare"));
	});

	test("shows help", async () => {
		const { stdout, exitCode } = await run("typegen", "--help");
		assert.equal(exitCode, 0);
		assert.ok(stdout.includes("xript typegen"));
	});
});

describe("xript docgen", () => {
	test("shows help", async () => {
		const { stdout, exitCode } = await run("docgen", "--help");
		assert.equal(exitCode, 0);
		assert.ok(stdout.includes("xript docgen"));
	});

	test("requires --output", async () => {
		const { stderr, exitCode } = await run("docgen", EXAMPLE_MANIFEST);
		assert.equal(exitCode, 1);
		assert.ok(stderr.includes("--output is required"));
	});
});

describe("xript init", () => {
	test("shows help", async () => {
		const { stdout, exitCode } = await run("init", "--help");
		assert.equal(exitCode, 0);
		assert.ok(stdout.includes("xript init"));
	});
});

describe("xript sanitize", () => {
	test("shows help", async () => {
		const { stdout, exitCode } = await run("sanitize", "--help");
		assert.equal(exitCode, 0);
		assert.ok(stdout.includes("xript sanitize"));
	});
});

describe("xript scan", () => {
	test("shows help", async () => {
		const { stdout, exitCode } = await run("scan", "--help");
		assert.equal(exitCode, 0);
		assert.ok(stdout.includes("xript scan"));
	});

	test("requires source directory", async () => {
		const { stderr, exitCode } = await run("scan");
		assert.equal(exitCode, 1);
		assert.ok(stderr.includes("source directory is required"));
	});

	test("--write without --manifest exits 1", async () => {
		const { stderr, exitCode } = await run("scan", "src/", "--write");
		assert.equal(exitCode, 1);
		assert.ok(stderr.includes("--write requires --manifest"));
	});
});
