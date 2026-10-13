import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, build, preview } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..");
const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
const require = createRequire(join(packageRoot, "package.json"));
const fixture = mkdtempSync(join(tmpdir(), "xript-vite-"));
const buildDir = join(fixture, "build-out");

const PAGE = `<!doctype html>
<html>
	<head><meta charset="utf-8" /><title>probe</title></head>
	<body><script type="module" src="/main.js"></script></body>
</html>
`;

const MAIN = `import { initXript, initXriptAsync } from "@xriptjs/runtime";

(async () => {
	try {
		const manifest = { xript: "0.9", name: "probe" };
		const sync = (await initXript()).createRuntime(manifest, { hostBindings: {} });
		const viaAsync = await (await initXriptAsync()).createRuntime(manifest, { hostBindings: {} });
		window.__xriptResult = {
			sync: sync.execute("1 + 1").value,
			async: (await viaAsync.executeAsync("return 1 + 1")).value,
		};
	} catch (error) {
		window.__xriptError = String(error && error.stack ? error.stack : error);
	}
})();
`;

const CONTROL_PAGE = PAGE.replace("/main.js", "/control.js");

const CONTROL = `import { initXript } from "@xriptjs/runtime";
import WASMFILE_SYNC from "@jitl/quickjs-wasmfile-release-sync";

(async () => {
	try {
		const runtime = (await initXript({ variant: WASMFILE_SYNC })).createRuntime({ xript: "0.9", name: "probe" }, { hostBindings: {} });
		window.__xriptResult = { sync: runtime.execute("1 + 1").value };
	} catch (error) {
		window.__xriptError = String(error && error.stack ? error.stack : error);
	}
})();
`;

function packageDir(name) {
	let dir = dirname(require.resolve(name));
	while (!existsSync(join(dir, "package.json")) || JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name !== name) {
		const parent = dirname(dir);
		if (parent === dir) throw new Error(`cannot locate ${name}`);
		dir = parent;
	}
	return dir;
}

/**
 * Installs the built package into a fixture outside this repo as a real `node_modules` dependency
 * rather than a workspace link, because Vite pre-bundles only what resolves under `node_modules`,
 * and pre-bundling is the step that separates a loader from a sibling `.wasm` asset. Its runtime
 * dependencies are linked in from this workspace's install.
 */
function writeFixture() {
	const modules = join(fixture, "node_modules");
	const installed = join(modules, "@xriptjs", "runtime");
	mkdirSync(installed, { recursive: true });
	cpSync(join(packageRoot, "dist"), join(installed, "dist"), { recursive: true });
	cpSync(join(packageRoot, "package.json"), join(installed, "package.json"));
	for (const name of Object.keys(packageJson.dependencies)) {
		const target = join(modules, ...name.split("/"));
		mkdirSync(dirname(target), { recursive: true });
		symlinkSync(packageDir(name), target, "junction");
	}
	writeFileSync(join(fixture, "package.json"), JSON.stringify({ name: "probe", private: true, type: "module" }));
	writeFileSync(join(fixture, "index.html"), PAGE);
	writeFileSync(join(fixture, "main.js"), MAIN);
	writeFileSync(join(fixture, "control.html"), CONTROL_PAGE);
	writeFileSync(join(fixture, "control.js"), CONTROL);
}

const quietConfig = { root: fixture, configFile: false, logLevel: "silent", clearScreen: false };

const WASM_REFERENCE = /["'`]([^"'`\s]*[\w-]\.wasm)(\?[^"'`]*)?["'`]/g;
const IMPORT_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g;

/**
 * Walks the module graph exactly as the dev server serves it to a browser, from the page's entry
 * outward, and returns every module URL plus every `.wasm` asset any of them names.
 */
async function crawl(origin, entry) {
	const seen = new Set();
	const wasm = new Set();
	const queue = [new URL(entry, origin).href];
	while (queue.length > 0) {
		const url = queue.shift();
		if (seen.has(url)) continue;
		seen.add(url);
		const response = await fetch(url);
		assert.equal(response.status, 200, `dev server failed to serve ${url}`);
		const source = await response.text();
		for (const match of source.matchAll(WASM_REFERENCE)) wasm.add(new URL(match[1], url).href);
		for (const match of source.matchAll(IMPORT_SPECIFIER)) {
			const specifier = match[1];
			if (!specifier.startsWith("/") && !specifier.startsWith(".") && !specifier.startsWith("http")) continue;
			const next = new URL(specifier, url);
			if (next.origin === new URL(origin).origin) queue.push(next.href);
		}
	}
	return { modules: [...seen], wasm: [...wasm] };
}

async function launchBrowser() {
	let chromium;
	try {
		({ chromium } = await import("playwright-core"));
	} catch {
		return null;
	}
	for (const options of [{ channel: "chrome" }, { channel: "msedge" }, {}]) {
		try {
			return await chromium.launch({ headless: true, ...options });
		} catch {}
	}
	return null;
}

async function evaluatePage(browser, url) {
	const page = await browser.newPage();
	const failed = [];
	page.on("response", (response) => {
		if (response.status() >= 400) failed.push(`${response.status()} ${response.url()}`);
	});
	try {
		await page.goto(url);
		await page.waitForFunction(() => window.__xriptResult || window.__xriptError, null, { timeout: 60_000 });
		const outcome = await page.evaluate(() => ({ result: window.__xriptResult, error: window.__xriptError }));
		return { ...outcome, failed };
	} finally {
		await page.close();
	}
}

describe("@xriptjs/runtime under Vite with no optimizeDeps config", { timeout: 180_000 }, () => {
	let server;
	let origin;
	let browser;

	before(async () => {
		writeFixture();
		server = await createServer({ ...quietConfig, server: { port: 0, host: "127.0.0.1" } });
		await server.listen();
		origin = server.resolvedUrls.local[0];
		browser = await launchBrowser();
	});

	after(async () => {
		await browser?.close();
		await server?.close();
		for (const name of Object.keys(packageJson.dependencies)) {
			unlinkSync(join(fixture, "node_modules", ...name.split("/")));
		}
		rmSync(fixture, { recursive: true, force: true });
	});

	it("still detects a sibling .wasm asset when the wasmfile variant is forced (control)", async () => {
		const { wasm } = await crawl(origin, "/control.js");
		assert.ok(wasm.length > 0, "the crawl must see the wasmfile variant's .wasm reference");
	});

	it("still fails in the browser when the wasmfile variant is forced (control)", async (t) => {
		if (!browser) return t.skip("no Chromium-family browser available to playwright-core");
		const { error } = await evaluatePage(browser, new URL("/control.html", origin).href);
		assert.match(error ?? "", /expected magic word 00 61 73 6d/);
	});

	it("serves a module graph that names no sibling .wasm asset", async () => {
		const { modules, wasm } = await crawl(origin, "/main.js");
		assert.ok(
			modules.some((url) => url.includes("/node_modules/.vite/deps/")),
			"expected the runtime to be pre-bundled into .vite/deps",
		);
		assert.deepEqual(wasm, [], `the dev graph requires .wasm fetches: ${wasm.join(", ")}`);
	});

	it("evaluates 1 + 1 in a headless browser against the dev server", async (t) => {
		if (!browser) return t.skip("no Chromium-family browser available to playwright-core");
		const { result, error, failed } = await evaluatePage(browser, origin);
		assert.equal(error, undefined, error);
		assert.deepEqual(result, { sync: 2, async: 2 });
		assert.deepEqual(failed.filter((line) => line.includes(".wasm")), []);
	});

	it("produces a production build with the WASM inlined", async () => {
		await build({ ...quietConfig, build: { outDir: buildDir, emptyOutDir: true } });
		const assets = readdirSync(join(buildDir, "assets"));
		assert.deepEqual(assets.filter((name) => name.endsWith(".wasm")), []);
		const bundled = assets
			.filter((name) => name.endsWith(".js"))
			.map((name) => readFileSync(join(buildDir, "assets", name), "utf8"))
			.join("\n");
		assert.match(bundled, /AGFzbQ/, "expected the WASM binary inlined as base64");
	});

	it("evaluates 1 + 1 in a headless browser against the production build", async (t) => {
		if (!browser) return t.skip("no Chromium-family browser available to playwright-core");
		const previewServer = await preview({
			...quietConfig,
			build: { outDir: buildDir },
			preview: { port: 0, host: "127.0.0.1" },
		});
		try {
			const { result, error } = await evaluatePage(browser, previewServer.resolvedUrls.local[0]);
			assert.equal(error, undefined, error);
			assert.deepEqual(result, { sync: 2, async: 2 });
		} finally {
			await new Promise((resolve) => previewServer.httpServer.close(resolve));
		}
	});
});
