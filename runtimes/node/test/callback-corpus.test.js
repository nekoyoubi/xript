import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRuntime, CallbackError, RetainError } from "../dist/index.js";

const corpus = JSON.parse(
	readFileSync(fileURLToPath(new URL("../../../spec/callback-tests.json", import.meta.url)), "utf8"),
);

function resolvePath(payload, path) {
	let current = payload;
	for (const step of path) {
		if (current === null || typeof current !== "object") return { found: false };
		if (!(step in current)) return { found: false };
		current = current[step];
	}
	return { found: true, value: current };
}

function jsonKind(value) {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value;
}

function createProbe() {
	const state = { typedCalls: 0, stashed: null, kept: [] };
	const keepHandle = (handle) => {
		const known = state.kept.indexOf(handle);
		if (known !== -1) return known;
		state.kept.push(handle);
		return state.kept.length - 1;
	};
	const tryKeep = (callback) => {
		try {
			return keepHandle(callback.retain());
		} catch (e) {
			if (e instanceof RetainError || e instanceof CallbackError) return { kind: e.reason };
			throw e;
		}
	};
	const catching = (call) => {
		try {
			return { kind: "returned", value: call() };
		} catch (e) {
			if (!(e instanceof CallbackError)) throw e;
			return e.reason === "threw" ? { kind: "threw", message: e.message } : { kind: e.reason };
		}
	};
	const probe = {
		keep: (fn) => tryKeep(fn),
		retainField: (options, field) => tryKeep(options[field]),
		keepAll: (list) => list.map((options) => keepHandle(options.onDone.retain())),
		keepEach: (...fns) => fns.map((fn) => keepHandle(fn.retain())),
		tryRetain: (path, ...payload) => tryKeep(resolvePath(payload, path).value),
		node: (fn) => ({ kind: "action", fn: state.kept[keepHandle(fn.retain())] }),
		runKept: (index, callArgs) => state.kept[index].call(...callArgs),
		catchKept: (index, callArgs) => catching(() => state.kept[index].call(...callArgs)),
		release: (index) => {
			state.kept[index].release();
			return null;
		},
		giveBack: (index) => state.kept[index],
		retainTreeAt: (tree, path) => tryKeep(resolvePath([tree], [0, ...path]).value),
		call: (path, callArgs, ...payload) => resolvePath(payload, path).value(...callArgs),
		catchCall: (path, callArgs, ...payload) => {
			try {
				return { kind: "returned", value: resolvePath(payload, path).value(...callArgs) };
			} catch (e) {
				if (!(e instanceof CallbackError)) throw e;
				return e.reason === "threw" ? { kind: "threw", message: e.message } : { kind: e.reason };
			}
		},
		kind: (path, ...payload) => {
			const at = resolvePath(payload, path);
			if (!at.found || at.value === undefined) return "missing";
			return typeof at.value === "function" ? "callback" : jsonKind(at.value);
		},
		stash: (path, ...payload) => {
			state.stashed = resolvePath(payload, path).value;
			return null;
		},
		handBack: (path, nested, ...payload) => {
			const callback = resolvePath(payload, path).value;
			return nested ? { inner: [callback] } : callback;
		},
		callWithSelf: (path, ...payload) => {
			const callback = resolvePath(payload, path).value;
			return callback(callback, { inner: [callback] });
		},
		callStashing: (path, ...payload) => {
			state.stashed = resolvePath(payload, path).value;
			return state.stashed();
		},
		handStashed: () => state.stashed,
		typed: () => {
			state.typedCalls++;
			return "called";
		},
		typedOptional: (fn) => {
			state.typedCalls++;
			return typeof fn === "function" ? "called" : "absent";
		},
		typedOptionalFlag: (fn) => {
			state.typedCalls++;
			return typeof fn === "function" ? "called" : "absent";
		},
		typedSignature: () => {
			state.typedCalls++;
			return "called";
		},
	};
	return { state, hostBindings: { probe } };
}

function manifestFor(entry) {
	const limits = { ...entry.limits };
	if (entry.timeoutMs !== undefined) limits.timeout_ms = entry.timeoutMs;
	if (Object.keys(limits).length === 0) return corpus.manifest;
	return { ...corpus.manifest, limits: { ...corpus.manifest.limits, ...limits } };
}

function plain(value) {
	return JSON.parse(JSON.stringify(value));
}

function withKept(value, kept) {
	if (Array.isArray(value)) return value.map((item) => withKept(item, kept));
	if (value === null || typeof value !== "object") return value;
	const keys = Object.keys(value);
	if (keys.length === 1 && keys[0] === "$kept") return kept[value.$kept];
	return Object.fromEntries(keys.map((key) => [key, withKept(value[key], kept)]));
}

function assertFails(call, step) {
	assert.throws(call, (e) => {
		assert.ok(e instanceof CallbackError, `expected a CallbackError, got ${e}`);
		assert.equal(e.reason, step.fails);
		if (step.message !== undefined) assert.equal(e.message, step.message);
		return true;
	});
}

function assertOutcome(call, step) {
	if (step.error) {
		assert.throws(call, (e) => step.error.every((part) => e.message.includes(part)));
	} else {
		const value = call();
		if ("result" in step) assert.deepEqual(plain(value), step.result);
	}
}

function runStep(runtime, state, step) {
	const kept = state.kept;
	if ("call" in step) {
		const call = () => kept[step.call].call(...(step.args ?? []));
		if (step.fails) assertFails(call, step);
		else assert.deepEqual(plain(call()), step.result);
	} else if ("callOffThread" in step) {
		return;
	} else if ("release" in step) {
		kept[step.release].release();
	} else if ("releaseMod" in step) {
		assert.equal(runtime.releaseRetained(step.releaseMod), step.released);
	} else if (step.dispose) {
		runtime.dispose();
		return "disposed";
	} else if ("execute" in step) {
		assertOutcome(() => runtime.execute(step.execute).value, step);
	} else if ("fireHook" in step) {
		const fire = () => runtime.fireHook(step.fireHook, { data: withKept(step.data, kept) });
		if (step.fails) assertFails(fire, step);
		else fire();
	} else if ("emit" in step) {
		const fire = () => runtime.emit(step.emit, withKept(step.payload, kept));
		if (step.fails) assertFails(fire, step);
		else fire();
	} else if ("invoke" in step) {
		const args = withKept(step.args ?? [], kept);
		assertOutcome(
			() => (step.owner ? runtime.invokeModExport(step.owner, step.invoke, args) : runtime.invokeExport(step.invoke, args)),
			step,
		);
	} else if (step.retainStashed) {
		assertFails(() => state.stashed.retain(), step);
	} else {
		assert.fail(`unknown after step ${JSON.stringify(step)}`);
	}
}

function loadMods(runtime, mods) {
	for (const mod of mods ?? []) {
		runtime.loadMod(
			{ xript: "0.9", name: mod.name, version: "1.0.0", entry: "main.js" },
			{ fragmentSources: { "main.js": mod.script } },
		);
	}
}

function runCase(entry) {
	const { state, hostBindings } = createProbe();
	const runtime = createRuntime(manifestFor(entry), { hostBindings });
	let disposed = false;
	try {
		loadMods(runtime, entry.mods);
		const expect = entry.expect;
		if (expect?.limit) {
			assert.throws(() => runtime.execute(entry.script), (e) => e.name === "ExecutionLimitError");
			return;
		}
		if (expect?.error) {
			assert.throws(
				() => runtime.execute(entry.script),
				(e) => expect.error.every((part) => e.message.includes(part)),
			);
		} else if (entry.script !== undefined) {
			const { value } = runtime.execute(entry.script);
			if (expect) assert.deepEqual(plain(value), expect.result);
		}
		if (expect?.typedCalls !== undefined) assert.equal(state.typedCalls, expect.typedCalls);
		if (expect?.expiredAfter) {
			assert.throws(
				() => state.stashed(),
				(e) => e instanceof CallbackError && e.reason === "expired" && e.message.includes("probe.stash"),
			);
		}
		for (const step of entry.after ?? []) {
			if (runStep(runtime, state, step) === "disposed") disposed = true;
		}
	} finally {
		if (!disposed) runtime.dispose();
	}
}

describe("callback corpus", () => {
	it("carries cases", () => {
		assert.ok(corpus.cases.length > 0);
	});

	for (const entry of corpus.cases) {
		it(entry.name, () => runCase(entry));
	}
});

describe("callbacks through async bindings", () => {
	const manifest = {
		xript: "0.8",
		name: "async-callbacks",
		bindings: {
			find: { description: "Tests cells with a predicate across an await.", async: true },
			other: { description: "Any async binding.", async: true },
		},
	};

	it("keeps a callback valid until the async binding settles, then expires it", async () => {
		let kept;
		const runtime = createRuntime(manifest, {
			hostBindings: {
				other: async () => 1,
				find: async (pred) => {
					kept = pred;
					const before = pred(1);
					await new Promise((resolve) => setTimeout(resolve, 5));
					return [before, pred(2)];
				},
			},
		});
		try {
			const { value } = await runtime.executeAsync("return await find((n) => n * 10);");
			assert.deepEqual(plain(value), [10, 20]);
			assert.throws(() => kept(3), (e) => e instanceof CallbackError && e.reason === "expired");
		} finally {
			runtime.dispose();
		}
	});

	it("refuses an async binding called from inside a callback", async () => {
		const runtime = createRuntime(manifest, {
			hostBindings: {
				other: async () => 1,
				find: async (pred) => pred(1),
			},
		});
		try {
			const { value } = await runtime.executeAsync(
				"try { await find(() => other()); return 'no throw'; } catch (e) { return e.message; }",
			);
			assert.match(value, /other\(\): cannot be called from inside a callback/);
		} finally {
			runtime.dispose();
		}
	});

	it("still starts async bindings after a runaway callback was stopped", async () => {
		const runtime = createRuntime(
			{
				...manifest,
				limits: { timeout_ms: 150 },
				bindings: { ...manifest.bindings, test: { description: "Calls its predicate." } },
			},
			{ hostBindings: { other: async () => 1, find: async () => null, test: (pred) => pred() } },
		);
		try {
			assert.throws(() => runtime.execute("test(function () { while (true) {} })"), (e) => e.name === "ExecutionLimitError");
			const { value } = await runtime.executeAsync("return await other();");
			assert.equal(value, 1);
		} finally {
			runtime.dispose();
		}
	});

	it("never hands the host the script's own function", () => {
		let received;
		const runtime = createRuntime(
			{ xript: "0.8", name: "identity", bindings: { take: { description: "Keeps its argument." } } },
			{ hostBindings: { take: (arg) => { received = arg; return null; } } },
		);
		try {
			runtime.execute("var f = function () { return 1; }; globalThis.payload = { f: f }; take(payload);");
			const { value } = runtime.execute("payload.f === f");
			assert.equal(value, true);
			assert.throws(() => received.f(), (e) => e instanceof CallbackError && e.reason === "expired");
		} finally {
			runtime.dispose();
		}
	});
});

describe("retained callbacks beyond the corpus", () => {
	const manifest = {
		xript: "0.10",
		name: "retained",
		bindings: {
			keep: { description: "Retains fn.", params: [{ name: "fn", type: "function", retain: true }] },
			later: { description: "Retains fn across an await.", async: true, params: [{ name: "fn", type: "function", retain: true }] },
			other: { description: "Any async binding.", async: true },
			give: { description: "Returns whatever the host chose." },
		},
		hooks: { tick: { description: "A host hook." } },
	};

	function create(hostBindings, limits) {
		return createRuntime(limits ? { ...manifest, limits } : manifest, {
			hostBindings: { other: async () => 1, give: () => null, keep: () => null, later: async () => null, ...hostBindings },
		});
	}

	it("refuses an async binding started inside a retained call between script calls", () => {
		let kept;
		const runtime = create({ keep: (fn) => { kept = fn.retain(); return null; } });
		try {
			runtime.execute("keep(function () { try { other(); return 'no throw'; } catch (e) { return e.message; } })");
			assert.match(kept.call(), /other\(\): cannot be called from inside a callback/);
		} finally {
			runtime.dispose();
		}
	});

	it("retains a callback from an async binding and calls it after the binding settled", async () => {
		let kept;
		const runtime = create({
			later: async (fn) => {
				kept = fn.retain();
				await new Promise((resolve) => setTimeout(resolve, 5));
				return kept.call(2);
			},
		});
		try {
			const { value } = await runtime.executeAsync("return await later(function (x) { return x * 5; });");
			assert.equal(value, 10);
			assert.equal(kept.call(3), 15);
		} finally {
			runtime.dispose();
		}
	});

	it("refuses another runtime's retained callback crossing in", () => {
		let kept;
		const first = create({ keep: (fn) => { kept = fn.retain(); return null; } });
		const second = create({ give: () => kept });
		try {
			first.execute("keep(function () {})");
			const { value } = second.execute("try { give(); 'no throw'; } catch (e) { e.message; }");
			assert.match(value, /keep\(\): callback expired; a retained callback crosses back only into the runtime and mod that supplied it/);
		} finally {
			first.dispose();
			second.dispose();
		}
	});

	it("leaves a host function or a marker-shaped object in a binding return as it was", () => {
		const runtime = create({ give: () => ({ marker: { $xriptCallback: "r:1:2:keep" }, fn: () => 7 }) });
		try {
			const { value } = runtime.execute("var r = give(); [r.marker.$xriptCallback, typeof r.fn, r.fn()]");
			assert.deepEqual(plain(value), ["r:1:2:keep", "function", 7]);
		} finally {
			runtime.dispose();
		}
	});

	it("runs a hook handler as the mod that registered it", () => {
		let kept;
		const runtime = create({ keep: (fn) => { kept = fn.retain(); return null; } });
		try {
			runtime.loadMod(
				{ xript: "0.10", name: "alpha", version: "1.0.0", entry: "main.js" },
				{ fragmentSources: { "main.js": "hooks.tick(function () { keep(function () { return 1; }); });" } },
			);
			runtime.fireHook("tick");
			assert.equal(kept.call(), 1);
			assert.equal(runtime.releaseRetained("alpha"), 1);
			assert.throws(() => kept.call(), (e) => e instanceof CallbackError && e.reason === "released");
		} finally {
			runtime.dispose();
		}
	});

	it("leaves no mod running after a runaway re-entrant retained call is stopped", () => {
		let kept;
		const runtime = create(
			{ give: () => kept.call(), keep: (fn) => { kept = fn.retain(); return null; } },
			{ timeout_ms: 150 },
		);
		try {
			runtime.loadMod(
				{ xript: "0.10", name: "alpha", version: "1.0.0", entry: "main.js" },
				{ fragmentSources: { "main.js": "keep(function () { while (true) {} });" } },
			);
			assert.throws(() => runtime.execute("give()"), (e) => e.name === "ExecutionLimitError");
			kept.release();
			runtime.execute("keep(function () { return 'host'; })");
			assert.equal(runtime.releaseRetained("alpha"), 0);
			assert.equal(kept.call(), "host");
		} finally {
			runtime.dispose();
		}
	});
});
