import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateProjectFiles, generateModProjectFiles, writeProject } from "../dist/index.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("generateProjectFiles", () => {
	it("generates tier 2 TypeScript project", () => {
		const files = generateProjectFiles({ name: "my-app", tier: 2, language: "typescript" });
		const paths = Object.keys(files).sort();
		assert.deepEqual(paths, [
			"manifest.json",
			"package.json",
			"src/demo.ts",
			"src/host.ts",
			"tsconfig.json",
		]);
	});

	it("generates tier 2 JavaScript project", () => {
		const files = generateProjectFiles({ name: "my-app", tier: 2, language: "javascript" });
		const paths = Object.keys(files).sort();
		assert.deepEqual(paths, [
			"manifest.json",
			"package.json",
			"src/demo.js",
			"src/host.js",
		]);
	});

	it("generates tier 3 TypeScript project", () => {
		const files = generateProjectFiles({ name: "my-app", tier: 3, language: "typescript" });
		const paths = Object.keys(files).sort();
		assert.deepEqual(paths, [
			"manifest.json",
			"package.json",
			"src/demo.ts",
			"src/host.ts",
			"tsconfig.json",
		]);
	});

	it("generates tier 3 JavaScript project", () => {
		const files = generateProjectFiles({ name: "my-app", tier: 3, language: "javascript" });
		const paths = Object.keys(files).sort();
		assert.deepEqual(paths, [
			"manifest.json",
			"package.json",
			"src/demo.js",
			"src/host.js",
		]);
	});

	it("manifest includes $schema reference", () => {
		const files = generateProjectFiles({ name: "test", tier: 2, language: "javascript" });
		const manifest = JSON.parse(files["manifest.json"]);
		assert.equal(manifest.$schema, "https://xript.dev/schema/manifest/v0.1.json");
	});

	it("manifest uses project name", () => {
		const files = generateProjectFiles({ name: "cool-project", tier: 2, language: "javascript" });
		const manifest = JSON.parse(files["manifest.json"]);
		assert.equal(manifest.name, "cool-project");
		assert.equal(manifest.title, "Cool Project");
	});

	it("tier 2 manifest has bindings but no hooks or capabilities", () => {
		const files = generateProjectFiles({ name: "test", tier: 2, language: "javascript" });
		const manifest = JSON.parse(files["manifest.json"]);
		assert.ok(manifest.bindings);
		assert.ok(manifest.bindings.log);
		assert.ok(manifest.bindings.greet);
		assert.equal(manifest.hooks, undefined);
		assert.equal(manifest.capabilities, undefined);
	});

	it("tier 3 manifest has bindings, hooks, and capabilities", () => {
		const files = generateProjectFiles({ name: "test", tier: 3, language: "javascript" });
		const manifest = JSON.parse(files["manifest.json"]);
		assert.ok(manifest.bindings);
		assert.ok(manifest.bindings.counter);
		assert.ok(manifest.bindings.counter.members);
		assert.ok(manifest.hooks);
		assert.ok(manifest.hooks.onStart);
		assert.ok(manifest.capabilities);
		assert.ok(manifest.capabilities["modify-state"]);
	});

	it("tier 3 host uses fireHook", () => {
		const files = generateProjectFiles({ name: "test", tier: 3, language: "javascript" });
		assert.ok(files["src/host.js"].includes("fireHook"));
	});

	it("tier 3 demo registers a hook handler", () => {
		const files = generateProjectFiles({ name: "test", tier: 3, language: "javascript" });
		assert.ok(files["src/demo.js"].includes("hooks.onStart"));
	});

	it("TypeScript project includes tsconfig.json", () => {
		const files = generateProjectFiles({ name: "test", tier: 2, language: "typescript" });
		assert.ok(files["tsconfig.json"]);
		const tsconfig = JSON.parse(files["tsconfig.json"]);
		assert.equal(tsconfig.compilerOptions.target, "ES2022");
	});

	it("TypeScript package.json includes tsx and typescript devDeps", () => {
		const files = generateProjectFiles({ name: "test", tier: 2, language: "typescript" });
		const pkg = JSON.parse(files["package.json"]);
		assert.ok(pkg.devDependencies.tsx);
		assert.ok(pkg.devDependencies.typescript);
	});

	it("JavaScript package.json has no devDependencies", () => {
		const files = generateProjectFiles({ name: "test", tier: 2, language: "javascript" });
		const pkg = JSON.parse(files["package.json"]);
		assert.equal(pkg.devDependencies, undefined);
	});

	it("package.json includes demo script", () => {
		const files = generateProjectFiles({ name: "test", tier: 2, language: "javascript" });
		const pkg = JSON.parse(files["package.json"]);
		assert.ok(pkg.scripts.demo);
		assert.ok(pkg.scripts.demo.includes("demo.js"));
	});

	it("TypeScript demo script uses tsx", () => {
		const files = generateProjectFiles({ name: "test", tier: 2, language: "typescript" });
		const pkg = JSON.parse(files["package.json"]);
		assert.ok(pkg.scripts.demo.includes("npx tsx"));
		assert.ok(pkg.scripts.demo.includes("demo.ts"));
	});

	it("host imports from @xriptjs/runtime", () => {
		const files = generateProjectFiles({ name: "test", tier: 2, language: "javascript" });
		assert.ok(files["src/host.js"].includes('@xriptjs/runtime'));
	});

	it("title-cases hyphenated names", () => {
		const files = generateProjectFiles({ name: "my-cool-app", tier: 2, language: "javascript" });
		const manifest = JSON.parse(files["manifest.json"]);
		assert.equal(manifest.title, "My Cool App");
	});

	it("title-cases underscored names", () => {
		const files = generateProjectFiles({ name: "my_cool_app", tier: 2, language: "javascript" });
		const manifest = JSON.parse(files["manifest.json"]);
		assert.equal(manifest.title, "My Cool App");
	});

	it("manifest has limits", () => {
		const files = generateProjectFiles({ name: "test", tier: 2, language: "javascript" });
		const manifest = JSON.parse(files["manifest.json"]);
		assert.ok(manifest.limits);
		assert.equal(manifest.limits.timeout_ms, 1000);
	});
});

describe("writeProject", () => {
	it("writes files to disk", async () => {
		const dir = await mkdtemp(join(tmpdir(), "xript-init-test-"));
		try {
			const result = await writeProject(dir, { name: "test", tier: 2, language: "javascript" });
			assert.equal(result.directory, dir);
			assert.ok(result.files.includes("manifest.json"));
			assert.ok(result.files.includes("package.json"));
			assert.ok(result.files.includes("src/demo.js"));
			assert.ok(result.files.includes("src/host.js"));

			const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf-8"));
			assert.equal(manifest.name, "test");
		} finally {
			await rm(dir, { recursive: true });
		}
	});
});

describe("generateModProjectFiles", () => {
	it("generates mod project files with --mod flag via generateProjectFiles", () => {
		const files = generateProjectFiles({ name: "my-mod", tier: 2, language: "javascript", type: "mod" });
		const paths = Object.keys(files).sort();
		assert.deepEqual(paths, [
			"fragments/panel.html",
			"mod-manifest.json",
			"package.json",
			"src/mod.js",
		]);
	});

	it("generates TypeScript mod project with tsconfig", () => {
		const files = generateModProjectFiles({ name: "my-mod", tier: 2, language: "typescript" });
		const paths = Object.keys(files).sort();
		assert.deepEqual(paths, [
			"fragments/panel.html",
			"mod-manifest.json",
			"package.json",
			"src/mod.ts",
			"tsconfig.json",
		]);
	});

	it("mod manifest is valid JSON with required fields", () => {
		const files = generateModProjectFiles({ name: "cool-mod", tier: 2, language: "javascript" });
		const manifest = JSON.parse(files["mod-manifest.json"]);
		assert.equal(manifest.xript, "0.3");
		assert.equal(manifest.name, "cool-mod");
		assert.equal(manifest.version, "0.1.0");
		assert.equal(manifest.title, "Cool Mod");
		assert.ok(manifest.entry);
		assert.ok(Array.isArray(manifest.fragments));
		assert.ok(manifest.fragments.length > 0);
		assert.ok(Array.isArray(manifest.capabilities));
	});

	it("mod manifest fragment targets sidebar.left slot", () => {
		const files = generateModProjectFiles({ name: "my-mod", tier: 2, language: "javascript" });
		const manifest = JSON.parse(files["mod-manifest.json"]);
		const fragment = manifest.fragments[0];
		assert.equal(fragment.slot, "sidebar.left");
		assert.equal(fragment.format, "text/html");
		assert.ok(fragment.bindings);
	});

	it("fragment HTML file includes data-bind and data-if", () => {
		const files = generateModProjectFiles({ name: "my-mod", tier: 2, language: "javascript" });
		const html = files["fragments/panel.html"];
		assert.ok(html.includes("data-bind"));
		assert.ok(html.includes("data-if"));
	});

	it("mod entry script references hooks.fragment.update", () => {
		const files = generateModProjectFiles({ name: "my-mod", tier: 2, language: "javascript" });
		const script = files["src/mod.js"];
		assert.ok(script.includes("hooks.fragment.update"));
	});
});

describe("writeProject (mod)", () => {
	it("writes mod files to disk", async () => {
		const dir = await mkdtemp(join(tmpdir(), "xript-init-mod-test-"));
		try {
			const result = await writeProject(dir, { name: "test-mod", tier: 2, language: "javascript", type: "mod" });
			assert.equal(result.directory, dir);
			assert.ok(result.files.includes("mod-manifest.json"));
			assert.ok(result.files.includes("package.json"));
			assert.ok(result.files.includes("src/mod.js"));
			assert.ok(result.files.includes("fragments/panel.html"));

			const manifest = JSON.parse(await readFile(join(dir, "mod-manifest.json"), "utf-8"));
			assert.equal(manifest.name, "test-mod");
		} finally {
			await rm(dir, { recursive: true });
		}
	});
});
