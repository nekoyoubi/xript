import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import RELEASE_SYNC from "@jitl/quickjs-wasmfile-release-sync";
import RELEASE_ASYNC from "@jitl/quickjs-wasmfile-release-asyncify";
import { initXript, initXriptAsync, QUICKJS_CORE_VERSION, QuickJSVariantMismatchError } from "../dist/index.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const require = createRequire(import.meta.url);
const manifest = { xript: "0.9", name: "probe" };

function installedVersion(name) {
	let dir = dirname(require.resolve(name));
	while (true) {
		const candidate = join(dir, "package.json");
		if (existsSync(candidate)) {
			const found = JSON.parse(readFileSync(candidate, "utf8"));
			if (found.name === name) return found.version;
		}
		const parent = dirname(dir);
		if (parent === dir) throw new Error(`no package.json found for ${name}`);
		dir = parent;
	}
}

/**
 * A variant whose FFI registers every host function under callback id 0, which is how a
 * core/variant version skew presents: the core looks up a callback the variant never registered.
 */
function skewed(real) {
	return {
		type: real.type,
		importModuleLoader: real.importModuleLoader,
		importFFI: async () => {
			const FFI = await real.importFFI();
			return class SkewedFFI extends FFI {
				constructor(module) {
					super(module);
					const newFunction = this.QTS_NewFunction;
					this.QTS_NewFunction = (ctx, _id, name) => newFunction(ctx, 0, name);
				}
			};
		},
	};
}

describe("QuickJS variant pinning", () => {
	it("pins the core and every @jitl variant to the same exact version", () => {
		const pinned = Object.entries({ ...pkg.dependencies, ...pkg.devDependencies }).filter(
			([name]) => name === "quickjs-emscripten-core" || name.startsWith("@jitl/quickjs-"),
		);
		assert.ok(pinned.length >= 5);
		for (const [name, range] of pinned) {
			assert.equal(range, QUICKJS_CORE_VERSION, `${name} must be pinned to exactly ${QUICKJS_CORE_VERSION}`);
		}
	});

	it("resolves the installed core and variants at the pinned version", () => {
		for (const name of Object.keys(pkg.dependencies).filter(
			(n) => n === "quickjs-emscripten-core" || n.startsWith("@jitl/quickjs-"),
		)) {
			const installed = installedVersion(name);
			assert.equal(installed, QUICKJS_CORE_VERSION, `${name} installed at ${installed}`);
		}
	});

	it("maps the browser condition to the singlefile loaders and everything else to wasmfile", () => {
		for (const key of ["#quickjs-sync", "#quickjs-async"]) {
			const entry = pkg.imports[key];
			assert.match(entry.browser, /\.browser\.js$/);
			assert.doesNotMatch(entry.default, /\.browser\.js$/);
			assert.doesNotMatch(entry.workerd, /\.browser\.js$/);
			assert.deepEqual(pkg.exports[`./${key.slice(1)}`], entry);
		}
		const syncBrowser = readFileSync(new URL("../dist/quickjs-sync.browser.js", import.meta.url), "utf8");
		const asyncBrowser = readFileSync(new URL("../dist/quickjs-async.browser.js", import.meta.url), "utf8");
		assert.match(syncBrowser, /@jitl\/quickjs-singlefile-browser-release-sync/);
		assert.match(asyncBrowser, /@jitl\/quickjs-singlefile-browser-release-asyncify/);
	});
});

describe("QuickJS variant compatibility check", () => {
	it("accepts the default variants", async () => {
		const runtime = (await initXript()).createRuntime(manifest, { hostBindings: { add: (a, b) => a + b } });
		assert.equal(runtime.execute("1 + 1").value, 2);
		runtime.dispose();
		const asyncRuntime = await (await initXriptAsync()).createRuntime(manifest, { hostBindings: {} });
		assert.equal((await asyncRuntime.executeAsync("return 1 + 1")).value, 2);
		asyncRuntime.dispose();
	});

	it("rejects a skewed sync variant at init with the version rule", async () => {
		await assert.rejects(initXript({ variant: skewed(RELEASE_SYNC) }), (error) => {
			assert.ok(error instanceof QuickJSVariantMismatchError);
			assert.match(error.message, new RegExp(`quickjs-emscripten-core@${QUICKJS_CORE_VERSION.replace(/\./g, "\\.")}`));
			assert.match(error.message, /exactly/);
			return true;
		});
	});

	it("rejects a skewed asyncify variant before a runtime is built on it", async () => {
		const factory = await initXriptAsync({ variant: skewed(RELEASE_ASYNC) });
		await assert.rejects(factory.createRuntime(manifest, { hostBindings: {} }), QuickJSVariantMismatchError);
	});

	it("does not cache a failed variant", async () => {
		const variant = skewed(RELEASE_SYNC);
		await assert.rejects(initXript({ variant }), QuickJSVariantMismatchError);
		await assert.rejects(initXript({ variant }), QuickJSVariantMismatchError);
	});
});
