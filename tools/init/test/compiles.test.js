import { describe, it } from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { generateProjectFiles, generateModProjectFiles } from "../dist/index.js";

/**
 * Type-checks a scaffold the way an adopter's editor does.
 *
 * The suite asserted what the generator emitted as *strings* and never whether those strings
 * were valid TypeScript, so a freshly scaffolded app failed `tsc` four ways — including its own
 * host bindings not satisfying `HostBindings` — while every test passed. This closes that class:
 * it compiles the real output against the real runtime types.
 */
async function typeCheck(files) {
	const dir = await mkdtemp(join(tmpdir(), "xript-scaffold-"));
	try {
		for (const [rel, body] of Object.entries(files)) {
			const abs = join(dir, rel);
			await mkdir(dirname(abs), { recursive: true });
			await writeFile(abs, body, "utf-8");
		}
		// The generated project imports the runtime and node builtins by name; point both at
		// this repo rather than installing, so the check needs no network and no lockfile.
		await mkdir(join(dir, "node_modules/@xriptjs"), { recursive: true });
		await symlink(resolve("../../runtimes/js"), join(dir, "node_modules/@xriptjs/runtime"), "junction").catch(() => {});
		await symlink(resolve("../../node_modules/@types"), join(dir, "node_modules/@types"), "junction").catch(() => {});

		const cfg = ts.getParsedCommandLineOfConfigFile(join(dir, "tsconfig.json"), {}, ts.sys);
		const program = ts.createProgram(cfg.fileNames, { ...cfg.options, noEmit: true });
		return ts.getPreEmitDiagnostics(program)
			.filter((d) => d.file)
			.map((d) => {
				const { line } = d.file.getLineAndCharacterOfPosition(d.start);
				const file = d.file.fileName.split(/[\/]/).pop();
				return `${file}:${line + 1} TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`;
			});
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

describe("a scaffolded typescript project compiles", () => {
	for (const tier of [2, 3, 4]) {
		it(`the app scaffold type-checks at tier ${tier}`, async () => {
			const errors = await typeCheck(generateProjectFiles({ name: "probe", tier, language: "typescript" }));
			assert.deepEqual(errors, [], `tier ${tier} app scaffold does not compile`);
		});
	}

	it("the mod scaffold type-checks", async () => {
		const errors = await typeCheck(generateModProjectFiles({ name: "probe-mod", tier: 2, language: "typescript" }));
		assert.deepEqual(errors, [], "mod scaffold does not compile");
	});
});
