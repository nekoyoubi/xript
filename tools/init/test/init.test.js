import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateProjectFiles, generateModProjectFiles, writeProject } from "../dist/index.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// The scaffold targets the version of the package that generated it, so these assert
// consistency with that package rather than a literal that needs editing every release.
const { createRequire } = await import("node:module");
const SCAFFOLD_VERSION = createRequire(import.meta.url)("../package.json").version;
const SPEC_LINE = SCAFFOLD_VERSION.split(".").slice(0, 2).join(".");

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
		assert.equal(manifest.$schema, `https://xript.dev/schema/manifest/v${SPEC_LINE}.json`);
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
		assert.ok(Array.isArray(manifest.slots));
		assert.ok(manifest.slots.some((slot) => slot.id === "onStart" && slot.accepts.includes("application/x-xript-hook")));
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

	it("tier 4 TypeScript project includes mod files", () => {
		const files = generateProjectFiles({ name: "my-app", tier: 4, language: "typescript" });
		const paths = Object.keys(files).sort();
		assert.deepEqual(paths, [
			"fragments/panel.html",
			"manifest.json",
			"mod-manifest.json",
			"package.json",
			"src/demo.ts",
			"src/host.ts",
			"tsconfig.json",
		]);
	});

	it("tier 4 JavaScript project includes mod files", () => {
		const files = generateProjectFiles({ name: "my-app", tier: 4, language: "javascript" });
		const paths = Object.keys(files).sort();
		assert.deepEqual(paths, [
			"fragments/panel.html",
			"manifest.json",
			"mod-manifest.json",
			"package.json",
			"src/demo.js",
			"src/host.js",
		]);
	});

	it("tier 4 manifest has slots, bindings, hooks, and capabilities", () => {
		const files = generateProjectFiles({ name: "test", tier: 4, language: "javascript" });
		const manifest = JSON.parse(files["manifest.json"]);
		assert.ok(manifest.bindings);
		assert.ok(manifest.bindings.counter);
		assert.ok(Array.isArray(manifest.slots));
		assert.ok(manifest.slots.some((slot) => slot.id === "onStart" && slot.accepts.includes("application/x-xript-hook")));
		assert.ok(manifest.capabilities);
		assert.ok(manifest.capabilities["modify-state"]);
		assert.ok(manifest.capabilities["ui-mount"]);
		assert.ok(Array.isArray(manifest.slots));
		assert.ok(manifest.slots.length > 0);
	});

	it("tier 4 mod manifest targets sidebar slot", () => {
		const files = generateProjectFiles({ name: "test", tier: 4, language: "javascript" });
		const manifest = JSON.parse(files["mod-manifest.json"]);
		assert.equal(manifest.xript, SPEC_LINE);
		assert.ok(manifest.fills);
		assert.ok(Array.isArray(manifest.fills["sidebar.left"]));
		assert.equal(manifest.fills["sidebar.left"][0].format, "text/html");
	});

	it("tier 4 host uses fireHook", () => {
		const files = generateProjectFiles({ name: "test", tier: 4, language: "javascript" });
		assert.ok(files["src/host.js"].includes("fireHook"));
	});

	it("tier 4 demo loads a mod", () => {
		const files = generateProjectFiles({ name: "test", tier: 4, language: "javascript" });
		assert.ok(files["src/demo.js"].includes("loadMod"));
	});

	it("tier 4 fragment HTML includes data-bind", () => {
		const files = generateProjectFiles({ name: "test", tier: 4, language: "javascript" });
		assert.ok(files["fragments/panel.html"].includes("data-bind"));
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
			"demo/host-manifest.json",
			"demo/steps.json",
			"fragments/panel.html",
			"mod-manifest.json",
			"package.json",
			"src/mod.js",
		]);
	});

	it("generates TypeScript mod project with tsconfig and ambient types", () => {
		const files = generateModProjectFiles({ name: "my-mod", tier: 2, language: "typescript" });
		const paths = Object.keys(files).sort();
		assert.deepEqual(paths, [
			"demo/host-manifest.json",
			"demo/steps.json",
			"fragments/panel.html",
			"mod-manifest.json",
			"package.json",
			"src/mod.ts",
			"src/xript-env.d.ts",
			"tsconfig.json",
		]);
	});

	it("mod tsconfig emits ESM (module ESNext, not Node16)", () => {
		const files = generateModProjectFiles({ name: "my-mod", tier: 2, language: "typescript" });
		const tsconfig = JSON.parse(files["tsconfig.json"]);
		assert.equal(tsconfig.compilerOptions.module, "ESNext");
		assert.equal(tsconfig.compilerOptions.moduleResolution, "Bundler");
		assert.notEqual(tsconfig.compilerOptions.module, "Node16");
	});

	it("mod manifest uses the object entry form with format module", () => {
		const files = generateModProjectFiles({ name: "my-mod", tier: 2, language: "typescript" });
		const manifest = JSON.parse(files["mod-manifest.json"]);
		assert.equal(typeof manifest.entry, "object");
		assert.equal(manifest.entry.format, "module");
		// The manifest names the artifact a host loads, which for the TypeScript scaffold is
		// the compiled module, not the source the author edits.
		assert.equal(manifest.entry.script, "dist/mod.js");
		assert.ok(manifest.entry.exports && Object.keys(manifest.entry.exports).length > 0);
	});

	it("a javascript mod names its source directly, having nothing to build", () => {
		const files = generateModProjectFiles({ name: "my-mod", tier: 2, language: "javascript" });
		const manifest = JSON.parse(files["mod-manifest.json"]);
		assert.equal(manifest.entry.script, "src/mod.js");
	});

	it("the manifest entry and the demo steps name the same artifact", () => {
		for (const language of ["typescript", "javascript"]) {
			const files = generateModProjectFiles({ name: "my-mod", tier: 2, language });
			const manifest = JSON.parse(files["mod-manifest.json"]);
			const steps = JSON.parse(files["demo/steps.json"]);
			const loaded = steps.steps.find((step) => step.action === "load-mod").sourcePath;
			assert.equal(
				loaded.replace(/^\.\.\//, ""),
				manifest.entry.script,
				`${language}: the demo loads a different file than the manifest declares`,
			);
		}
	});

	it("mod entry uses a top-level export wired to the example export name", () => {
		const files = generateModProjectFiles({ name: "my-mod", tier: 2, language: "typescript" });
		const manifest = JSON.parse(files["mod-manifest.json"]);
		const exportName = Object.keys(manifest.entry.exports)[0];
		const entry = files["src/mod.ts"];
		assert.ok(entry.includes(`export function ${exportName}(`), "entry has the declared top-level export");
		assert.ok(entry.includes('/// <reference path="./xript-env.d.ts" />'), "entry references ambient types");
		assert.ok(entry.includes("hooks.fragment.update"), "entry still shows the hook side-effect");
	});

	it("emits an ambient xript-env.d.ts that declares the xript global", () => {
		const files = generateModProjectFiles({ name: "my-mod", tier: 2, language: "typescript" });
		const ambient = files["src/xript-env.d.ts"];
		assert.ok(ambient.includes("declare global {"));
		assert.ok(ambient.includes("const xript: {"));
		assert.ok(ambient.includes("register(name: string, fn:"));
		assert.ok(ambient.includes("export interface Exports {"));
	});

	it("ambient types declare the typed events subscription surface", () => {
		const files = generateModProjectFiles({ name: "my-mod", tier: 2, language: "typescript" });
		const ambient = files["src/xript-env.d.ts"];
		assert.ok(ambient.includes("interface XriptEvents {"));
		assert.ok(ambient.includes("type XriptEventId = keyof XriptEvents;"));
		assert.ok(ambient.includes("namespace events {"));
		assert.ok(ambient.includes("function on<K extends XriptEventId>(id: K, handler: (payload: XriptEvents[K]) => void): void;"));
	});

	it("ambient types declare capability scope and reference types", () => {
		const files = generateModProjectFiles({ name: "my-mod", tier: 2, language: "typescript" });
		const ambient = files["src/xript-env.d.ts"];
		assert.ok(ambient.includes("type XriptCapability ="));
		assert.ok(ambient.includes("type XriptCapabilityRef ="));
		assert.ok(ambient.includes("(string & {})"));
	});

	it("mod entry demonstrates a typed events.on subscription", () => {
		const files = generateModProjectFiles({ name: "my-mod", tier: 2, language: "typescript" });
		assert.ok(files["src/mod.ts"].includes('events.on("app.status-changed"'));
	});

	it("scaffolds no CommonJS artifacts in the entry", () => {
		const files = generateModProjectFiles({ name: "my-mod", tier: 2, language: "typescript" });
		const entry = files["src/mod.ts"];
		assert.ok(!/\brequire\s*\(/.test(entry));
		assert.ok(!/\bmodule\s*\.\s*exports\b/.test(entry));
	});

	it("mod manifest is valid JSON with required fields", () => {
		const files = generateModProjectFiles({ name: "cool-mod", tier: 2, language: "javascript" });
		const manifest = JSON.parse(files["mod-manifest.json"]);
		assert.equal(manifest.xript, SPEC_LINE);
		assert.equal(manifest.name, "cool-mod");
		assert.equal(manifest.version, "0.1.0");
		assert.equal(manifest.title, "Cool Mod");
		assert.ok(manifest.entry);
		assert.ok(manifest.fills);
		assert.ok(manifest.fills["sidebar.left"].length > 0);
		assert.ok(Array.isArray(manifest.capabilities));
	});

	it("mod manifest fragment targets sidebar.left slot", () => {
		const files = generateModProjectFiles({ name: "my-mod", tier: 2, language: "javascript" });
		const manifest = JSON.parse(files["mod-manifest.json"]);
		const fill = manifest.fills["sidebar.left"][0];
		assert.equal(fill.format, "text/html");
		assert.ok(fill.bindings);
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

	it("derives the family from the mod name prefix", () => {
		const files = generateModProjectFiles({ name: "acme-tools", tier: 2, language: "javascript" });
		const manifest = JSON.parse(files["mod-manifest.json"]);
		assert.equal(manifest.family, "acme");
	});

	it("omits family when the name has no prefix segment", () => {
		const files = generateModProjectFiles({ name: "standalone", tier: 2, language: "javascript" });
		const manifest = JSON.parse(files["mod-manifest.json"]);
		assert.equal(manifest.family, undefined);
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

describe("a scaffolded typescript project type-checks", () => {
	// Every one of these was a real error on a freshly scaffolded app: it did not compile.
	it("imports the emitted module, not the .ts source", () => {
		const files = generateProjectFiles({ name: "app", tier: 2, language: "typescript" });
		const demo = files["src/demo.ts"];
		assert.ok(!demo.includes('"./host.ts"'), "a .ts specifier needs allowImportingTsExtensions");
		assert.ok(demo.includes('"./host.js"'));
	});

	it("narrows a caught error rather than reading .message off unknown", () => {
		for (const tier of [2, 3, 4]) {
			const files = generateProjectFiles({ name: "app", tier, language: "typescript" });
			for (const [path, body] of Object.entries(files)) {
				if (!path.endsWith(".ts")) continue;
				assert.ok(
					!/\$\{e\.message\}/.test(body),
					`${path} (tier ${tier}) reads .message off a catch binding, which is \`unknown\` under strict`,
				);
			}
		}
	});

	it("depends on @types/node, having imported node: builtins", () => {
		const files = generateProjectFiles({ name: "app", tier: 2, language: "typescript" });
		const pkg = JSON.parse(files["package.json"]);
		const usesNodeBuiltin = Object.entries(files).some(([p, b]) => p.endsWith(".ts") && b.includes('"node:'));
		if (usesNodeBuiltin) assert.ok(pkg.devDependencies["@types/node"], "node: imports need @types/node");
	});
});
