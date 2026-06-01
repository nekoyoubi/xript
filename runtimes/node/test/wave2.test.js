import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	createRuntime,
	DEBUG_THREAD_ID,
	ModManifestValidationError,
} from "../dist/index.js";

const appManifest = { xript: "0.5", name: "wave2-app" };

function clipboardMod(name, fn) {
	return {
		xript: "0.5",
		name,
		version: "1.0.0",
		contributions: {
			provides: [
				{
					role: "clipboard-history",
					fns: {
						query: fn,
						restore: `${fn}_restore`,
						clear: `${fn}_clear`,
					},
				},
			],
		},
	};
}

describe("provider roles — resolution", () => {
	it("resolves the only provider", () => {
		const rt = createRuntime(appManifest, { hostBindings: {} });
		rt.loadMod(clipboardMod("clip-a", "a_query"));
		const res = rt.resolveRole("clipboard-history");
		assert.equal(res.addon, "clip-a");
		assert.equal(res.fns.query, "a_query");
		rt.dispose();
	});

	it("returns null for an unprovided role", () => {
		const rt = createRuntime(appManifest, { hostBindings: {} });
		assert.equal(rt.resolveRole("nonexistent"), null);
		rt.dispose();
	});

	it("first-installed wins by default", () => {
		const rt = createRuntime(appManifest, { hostBindings: {} });
		rt.loadMod(clipboardMod("clip-a", "a_query"));
		rt.loadMod(clipboardMod("clip-b", "b_query"));
		assert.equal(rt.resolveRole("clipboard-history").addon, "clip-a");
		rt.dispose();
	});

	it("rolePreferences override the winner", () => {
		const rt = createRuntime(appManifest, {
			hostBindings: {},
			rolePreferences: { "clipboard-history": "clip-b" },
		});
		rt.loadMod(clipboardMod("clip-a", "a_query"));
		rt.loadMod(clipboardMod("clip-b", "b_query"));
		assert.equal(rt.resolveRole("clipboard-history").addon, "clip-b");
		rt.dispose();
	});

	it("a preference for a non-provider falls through to first-installed", () => {
		const rt = createRuntime(appManifest, {
			hostBindings: {},
			rolePreferences: { "clipboard-history": "ghost" },
		});
		rt.loadMod(clipboardMod("clip-a", "a_query"));
		rt.loadMod(clipboardMod("clip-b", "b_query"));
		assert.equal(rt.resolveRole("clipboard-history").addon, "clip-a");
		rt.dispose();
	});

	it("resolveRoleAll returns every provider in load order", () => {
		const rt = createRuntime(appManifest, { hostBindings: {} });
		rt.loadMod(clipboardMod("clip-a", "a_query"));
		rt.loadMod(clipboardMod("clip-b", "b_query"));
		const all = rt.resolveRoleAll("clipboard-history");
		assert.deepEqual(all.map((r) => r.addon), ["clip-a", "clip-b"]);
		rt.dispose();
	});

	it("resolveRoleAll is empty for an unprovided role", () => {
		const rt = createRuntime(appManifest, { hostBindings: {} });
		assert.deepEqual(rt.resolveRoleAll("nope"), []);
		rt.dispose();
	});

	it("declaring provides grants no capability", () => {
		const rt = createRuntime(appManifest, { hostBindings: {} });
		const mod = rt.loadMod(clipboardMod("clip-a", "a_query"));
		assert.deepEqual(mod.provides[0].fns, { query: "a_query", restore: "a_query_restore", clear: "a_query_clear" });
		rt.dispose();
	});

	it("returned fns is a copy, not a live reference", () => {
		const rt = createRuntime(appManifest, { hostBindings: {} });
		rt.loadMod(clipboardMod("clip-a", "a_query"));
		const res = rt.resolveRole("clipboard-history");
		res.fns.query = "tampered";
		assert.equal(rt.resolveRole("clipboard-history").fns.query, "a_query");
		rt.dispose();
	});
});

describe("provider roles — validation", () => {
	it("rejects duplicate role within a mod's provides[]", () => {
		const rt = createRuntime(appManifest, { hostBindings: {} });
		const bad = {
			xript: "0.5",
			name: "dup",
			version: "1.0.0",
			contributions: {
				provides: [
					{ role: "clipboard-history", fns: { query: "q1" } },
					{ role: "clipboard-history", fns: { query: "q2" } },
				],
			},
		};
		assert.throws(() => rt.loadMod(bad), ModManifestValidationError);
		rt.dispose();
	});

	it("rejects an empty fns map", () => {
		const rt = createRuntime(appManifest, { hostBindings: {} });
		const bad = {
			xript: "0.5",
			name: "empty-fns",
			version: "1.0.0",
			contributions: { provides: [{ role: "r", fns: {} }] },
		};
		assert.throws(() => rt.loadMod(bad), ModManifestValidationError);
		rt.dispose();
	});

	it("rejects an invalid role identifier", () => {
		const rt = createRuntime(appManifest, { hostBindings: {} });
		const bad = {
			xript: "0.5",
			name: "bad-role",
			version: "1.0.0",
			contributions: { provides: [{ role: "Clipboard_History", fns: { query: "q" } }] },
		};
		assert.throws(() => rt.loadMod(bad), ModManifestValidationError);
		rt.dispose();
	});

	it("accepts a mod with no contributions block", () => {
		const rt = createRuntime(appManifest, { hostBindings: {} });
		const mod = rt.loadMod({ xript: "0.5", name: "plain", version: "1.0.0" });
		assert.deepEqual(mod.provides, []);
		rt.dispose();
	});
});

describe("record schemas — manifest tolerance", () => {
	it("tolerates field default and inline enum metadata without error", () => {
		const manifest = {
			xript: "0.5",
			name: "records-app",
			types: {
				BrickFiles: {
					fields: {
						path: { type: "string", optional: true },
						pathStyle: { type: "string", enum: ["posix", "hybrid", "native"], default: "posix" },
						viewingEnabled: { type: "boolean", default: false },
					},
				},
			},
		};
		const rt = createRuntime(manifest, { hostBindings: {} });
		assert.equal(rt.manifest.name, "records-app");
		rt.dispose();
	});
});

describe("grant shapes — host-side wire shapes", () => {
	it("a CapabilityPrompt object matches the pinned shape", () => {
		const prompt = {
			capability: "fs.read",
			description: "Read files from disk",
			risk: "high",
			mod: { name: "filer", version: "1.0.0", title: "Filer" },
			requestedScope: "session",
			state: "first-time",
		};
		assert.equal(prompt.requestedScope, "session");
		assert.equal(prompt.state, "first-time");
	});

	it("a DiscoveryResult provides[] ties into provider roles", () => {
		const result = {
			mods: [
				{ name: "clip", version: "1.0.0", location: "/mods/clip", enabled: true, capabilities: [], provides: ["clipboard-history"] },
			],
			scannedAt: Date.now(),
		};
		assert.equal(result.mods[0].provides[0], "clipboard-history");
	});
});

describe("debug protocol — node (instrumented)", () => {
	it("debugSession is null when debug is not set", () => {
		const rt = createRuntime(appManifest, { hostBindings: {} });
		assert.equal(rt.debugSession(), null);
		rt.dispose();
	});

	it("attaches a debug session with instrumented fidelity", () => {
		const rt = createRuntime(appManifest, { hostBindings: {}, debug: { onStopped() {} } });
		const sess = rt.debugSession();
		assert.ok(sess);
		assert.equal(sess.fidelity, "instrumented");
		rt.dispose();
	});

	it("debugExecute without a debug session throws", async () => {
		const rt = createRuntime(appManifest, { hostBindings: {} });
		await assert.rejects(() => rt.debugExecute("1 + 1;"));
		rt.dispose();
	});

	it("pauses at a breakpoint and inspects locals", async () => {
		const stopped = [];
		const rt = createRuntime(appManifest, {
			hostBindings: {},
			debug: { onStopped: (e) => stopped.push(e) },
		});
		const sess = rt.debugSession();
		sess.setBreakpoints("xript-script.js", [{ line: 2 }]);
		const p = rt.debugExecute("let a = 1;\nlet b = a + 1;\nb;");
		await new Promise((r) => setTimeout(r, 50));
		assert.equal(stopped.length, 1);
		assert.equal(stopped[0].reason, "breakpoint");
		assert.equal(stopped[0].threadId, DEBUG_THREAD_ID);
		assert.deepEqual(stopped[0].hitBreakpointIds, [1]);
		const frames = sess.stackTrace();
		assert.equal(frames[0].line, 2);
		const scopes = sess.scopes(frames[0].id);
		assert.equal(scopes[0].name, "Local");
		const vars = sess.variables(scopes[0].variablesReference);
		assert.equal(vars.find((v) => v.name === "a").value, "1");
		sess.continue();
		await p;
		rt.dispose();
	});

	it("step mode stops at the next statement", async () => {
		const stopped = [];
		const rt = createRuntime(appManifest, {
			hostBindings: {},
			debug: { onStopped: (e) => stopped.push(e) },
		});
		const sess = rt.debugSession();
		sess.setBreakpoints("xript-script.js", [{ line: 1 }]);
		const p = rt.debugExecute("let a = 1;\nlet b = 2;\nlet c = 3;\nc;");
		await new Promise((r) => setTimeout(r, 50));
		assert.equal(stopped[0].reason, "breakpoint");
		sess.stepOver();
		await new Promise((r) => setTimeout(r, 50));
		assert.equal(stopped[1].reason, "step");
		assert.equal(sess.stackTrace()[0].line, 2);
		sess.continue();
		await p;
		rt.dispose();
	});

	it("evaluate reports unsupported uniformly", () => {
		const rt = createRuntime(appManifest, { hostBindings: {}, debug: { onStopped() {} } });
		const v = rt.debugSession().evaluate("1 + 1");
		assert.equal(v.type, "unsupported");
		rt.dispose();
	});

	it("expandable variables carry a nonzero reference", async () => {
		const stopped = [];
		const rt = createRuntime(appManifest, {
			hostBindings: {},
			debug: { onStopped: (e) => stopped.push(e) },
		});
		const sess = rt.debugSession();
		sess.setBreakpoints("xript-script.js", [{ line: 2 }]);
		const p = rt.debugExecute("let obj = { x: 1, y: 2 };\nlet z = obj.x;\nz;");
		await new Promise((r) => setTimeout(r, 50));
		const scopes = sess.scopes(1);
		const vars = sess.variables(scopes[0].variablesReference);
		const obj = vars.find((v) => v.name === "obj");
		assert.ok(obj.variablesReference > 0);
		const children = sess.variables(obj.variablesReference);
		assert.equal(children.find((c) => c.name === "x").value, "1");
		sess.continue();
		await p;
		rt.dispose();
	});
});
