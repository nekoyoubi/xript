import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const cliPath = resolve(__dirname, "..", "dist", "cli.js");

const run = (args, opts = {}) =>
	execFileAsync("node", [cliPath, ...args], { encoding: "utf-8", ...opts });

describe("cli typegen --ambient (wave 3)", () => {
	it("emits an ambient declare global file to stdout", async () => {
		const dir = await mkdtemp(join(tmpdir(), "xript-cli-ambient-"));
		try {
			const manifestPath = join(dir, "mod-manifest.json");
			await writeFile(
				manifestPath,
				JSON.stringify({
					xript: "0.3",
					name: "my-mod",
					version: "1.0.0",
					entry: {
						script: "src/mod.ts",
						format: "module",
						exports: { transcribe: { description: "x", params: [{ name: "u", type: "string" }], returns: "string" } },
					},
				}),
			);
			const { stdout } = await run(["typegen", manifestPath, "--ambient"]);
			assert.match(stdout, /declare global \{/);
			assert.match(stdout, /const xript: \{/);
			assert.match(stdout, /interface Exports \{/);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("writes the ambient file to disk with -o", async () => {
		const dir = await mkdtemp(join(tmpdir(), "xript-cli-ambient-o-"));
		try {
			const manifestPath = join(dir, "mod-manifest.json");
			const outPath = join(dir, "xript-env.d.ts");
			await writeFile(
				manifestPath,
				JSON.stringify({
					xript: "0.3",
					name: "my-mod",
					version: "1.0.0",
					entry: { script: "src/mod.ts", format: "module", exports: { go: { description: "g" } } },
				}),
			);
			await run(["typegen", manifestPath, "--ambient", "-o", outPath]);
			const written = await readFile(outPath, "utf-8");
			assert.match(written, /declare global \{/);
			assert.match(written, /export \{\};/);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("lists --ambient in typegen help", async () => {
		const { stdout } = await run(["typegen", "--help"]);
		assert.match(stdout, /--ambient/);
	});
});
