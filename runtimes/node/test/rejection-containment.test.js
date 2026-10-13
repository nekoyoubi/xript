import { describe, it } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { execFileSync } from "node:child_process";

import { createRuntime, ImportDeniedError } from "../dist/index.js";

const distIndexUrl = new URL("../dist/index.js", import.meta.url).href;

const hasVmModules = typeof vm.SourceTextModule === "function";

/**
 * The Node runtime runs sandbox code in a `vm` context that shares the host's V8 isolate and
 * its process-level unhandled-rejection reporting, so a floating rejected promise in the
 * sandbox would otherwise reach `process` and, under Node's default policy, crash the host.
 * Host survival is a property of the process, so each case runs in a dedicated child under the
 * default rejection policy (the test runner installs its own `unhandledRejection` listener, so
 * an in-process check cannot observe the real process outcome). The child prints `SURVIVED`
 * and exits zero only when the floating rejection was contained.
 */
describe("floating sandbox rejections cannot crash the host", () => {
	function survives(sandboxCode) {
		const script = `
			const { createRuntime } = await import(${JSON.stringify(distIndexUrl)});
			const rt = createRuntime({ xript: "0.8", name: "p" }, {});
			rt.execute(${JSON.stringify(sandboxCode)});
			setTimeout(() => { process.stdout.write("SURVIVED"); rt.dispose(); }, 40);
		`;
		const out = execFileSync(process.execPath, ["--experimental-vm-modules", "--input-type=module", "-e", script], {
			encoding: "utf8",
		});
		return out.trim();
	}

	it("a floating Promise.reject is contained", () => {
		assert.equal(survives("Promise.reject(new Error('floating'))"), "SURVIVED");
	});

	it("a rejected promise returned as the result value is contained", () => {
		assert.equal(survives("Promise.reject(new Error('result-value'))"), "SURVIVED");
	});

	it("an un-awaited async body that throws is contained", () => {
		assert.equal(survives("(async () => { throw new Error('async-floating'); })()"), "SURVIVED");
	});

	it("a bare dynamic import is contained", () => {
		assert.equal(survives("void import('node:fs')"), "SURVIVED");
	});

	it("a host that awaits a returned rejected promise still observes the rejection", async () => {
		const rt = createRuntime({ xript: "0.8", name: "p" }, {});
		try {
			const result = rt.execute("Promise.reject(new Error('observed'))");
			await assert.rejects(Promise.resolve(result.value), /observed/);
		} finally {
			rt.dispose();
		}
	});
});

describe("rejection sink lifecycle", () => {
	// Run in a dedicated process: the sink is process-global, so a shared test process where
	// other suites hold sandboxes alive would perturb the count non-deterministically.
	it("installs one shared listener and removes it when the last sandbox is disposed", () => {
		const script = `
			const { createRuntime } = await import(${JSON.stringify(distIndexUrl)});
			const count = () => process.listenerCount("unhandledRejection");
			const before = count();
			const a = createRuntime({ xript: "0.8", name: "a" }, {});
			const d1 = count();
			const b = createRuntime({ xript: "0.8", name: "b" }, {});
			const d2 = count();
			a.dispose();
			const e1 = count();
			b.dispose();
			const e2 = count();
			process.stdout.write(JSON.stringify({ before, d1, d2, e1, e2 }));
		`;
		const out = execFileSync(process.execPath, ["--experimental-vm-modules", "--input-type=module", "-e", script], {
			encoding: "utf8",
		});
		assert.deepEqual(JSON.parse(out), { before: 0, d1: 1, d2: 1, e1: 1, e2: 0 });
	});
});

describe("dynamic import is denied in module mode", { skip: hasVmModules ? false : "requires --experimental-vm-modules" }, () => {
	const modManifest = (name) => ({
		xript: "0.5",
		name,
		version: "1.0.0",
		entry: { script: "mod.js", format: "module" },
	});

	it("denies a literal dynamic import at load time", async () => {
		const rt = createRuntime({ xript: "0.5", name: "module-host", slots: [] }, { hostBindings: {} });
		try {
			await assert.rejects(
				rt.loadModAsync(modManifest("m"), {
					fragmentSources: { "mod.js": "export async function go(){ await import('node:fs'); return 'loaded'; }" },
					entryErrors: "throw",
				}),
				(e) => e instanceof ImportDeniedError,
			);
		} finally {
			rt.dispose();
		}
	});

	// A computed specifier slips past the static source scan, so this exercises the runtime's
	// `importModuleDynamically` refusal rather than the scan.
	it("denies a computed dynamic import at call time", async () => {
		const rt = createRuntime({ xript: "0.5", name: "module-host", slots: [] }, { hostBindings: {} });
		try {
			await rt.loadModAsync(modManifest("m2"), {
				fragmentSources: { "mod.js": "export async function go(){ const s = ['node',':','fs'].join(''); await import(s); return 'loaded'; }" },
				entryErrors: "throw",
			});
			await assert.rejects(rt.invokeModExportAsync("m2", "go", []), (e) => e instanceof ImportDeniedError || /import/i.test(e.message));
		} finally {
			rt.dispose();
		}
	});
});
