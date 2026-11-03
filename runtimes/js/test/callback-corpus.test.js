import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { initXript, initXriptAsync, CallbackError, RetainError } from "../dist/index.js";

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

function failureKind(e) {
	if (e instanceof RetainError) return { kind: e.reason };
	if (!(e instanceof CallbackError)) throw e;
	return e.reason === "threw" ? { kind: "threw", message: e.message } : { kind: e.reason };
}

function createProbe() {
	const state = { typedCalls: 0, stashed: null, kept: [] };
	const keep = (callback) => {
		const handle = callback.retain();
		const existing = state.kept.indexOf(handle);
		if (existing !== -1) return existing;
		state.kept.push(handle);
		return state.kept.length - 1;
	};
	const tryKeep = (callback) => {
		try {
			return keep(callback);
		} catch (e) {
			return failureKind(e);
		}
	};
	const catchCall = (fn) => {
		try {
			return { kind: "returned", value: fn() };
		} catch (e) {
			if (!(e instanceof CallbackError)) throw e;
			return failureKind(e);
		}
	};
	const probe = {
		call: (path, callArgs, ...payload) => resolvePath(payload, path).value(...callArgs),
		catchCall: (path, callArgs, ...payload) => catchCall(() => resolvePath(payload, path).value(...callArgs)),
		kind: (path, ...payload) => {
			const at = resolvePath(payload, path);
			if (!at.found || at.value === undefined) return "missing";
			return typeof at.value === "function" ? "callback" : jsonKind(at.value);
		},
		stash: (path, ...payload) => {
			state.stashed = resolvePath(payload, path).value;
			return null;
		},
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
		keep: (fn) => tryKeep(fn),
		retainField: (options, field) => tryKeep(options[field]),
		keepAll: (list) => list.map((options) => keep(options.onDone)),
		keepEach: (...fns) => fns.map((fn) => keep(fn)),
		tryRetain: (path, ...payload) => tryKeep(resolvePath(payload, path).value),
		retainTreeAt: (tree, path) => tryKeep(resolvePath([tree], [0, ...path]).value),
		node: (fn) => {
			const index = keep(fn);
			return { kind: "action", fn: state.kept[index] };
		},
		runKept: (i, callArgs) => state.kept[i].call(...callArgs),
		catchKept: (i, callArgs) => catchCall(() => state.kept[i].call(...callArgs)),
		release: (i) => {
			state.kept[i].release();
			return null;
		},
		giveBack: (i) => state.kept[i],
	};
	return { state, hostBindings: { probe } };
}

function manifestFor(entry) {
	const limits = { ...(corpus.manifest.limits ?? {}), ...(entry.limits ?? {}) };
	if (entry.timeoutMs !== undefined) limits.timeout_ms = entry.timeoutMs;
	if (Object.keys(limits).length === 0) return corpus.manifest;
	return { ...corpus.manifest, limits };
}

function withKept(value, kept) {
	if (Array.isArray(value)) return value.map((item) => withKept(item, kept));
	if (value === null || typeof value !== "object") return value;
	const keys = Object.keys(value);
	if (keys.length === 1 && keys[0] === "$kept") return kept[value.$kept];
	return Object.fromEntries(keys.map((key) => [key, withKept(value[key], kept)]));
}

function assertOutcome(step, run) {
	if (step.error) {
		assert.throws(run, (e) => step.error.every((part) => e.message.includes(part)));
		return;
	}
	const value = run();
	if ("result" in step) assert.deepEqual(value, step.result);
}

function assertFire(step, fire) {
	if (step.fails === undefined) {
		fire();
		return;
	}
	assert.throws(fire, (e) => {
		assert.equal(failureKind(e).kind, step.fails);
		return true;
	});
}

function runStep(runtime, state, step) {
	const kept = state.kept;
	if ("call" in step) {
		const outcome = (() => {
			try {
				return { kind: "returned", value: kept[step.call].call(...step.args) };
			} catch (e) {
				return failureKind(e);
			}
		})();
		if (step.fails) {
			assert.equal(outcome.kind, step.fails);
			if (step.message !== undefined) assert.equal(outcome.message, step.message);
		} else {
			assert.deepEqual(outcome, { kind: "returned", value: step.result });
		}
	} else if ("callOffThread" in step) {
		return;
	} else if ("release" in step) {
		kept[step.release].release();
	} else if ("releaseMod" in step) {
		assert.equal(runtime.releaseRetained(step.releaseMod), step.released);
	} else if ("dispose" in step) {
		runtime.dispose();
		state.disposed = true;
	} else if ("execute" in step) {
		assertOutcome(step, () => runtime.execute(step.execute).value);
	} else if ("fireHook" in step) {
		assertFire(step, () => runtime.fireHook(step.fireHook, { data: withKept(step.data, kept) }));
	} else if ("emit" in step) {
		assertFire(step, () => runtime.emit(step.emit, withKept(step.payload, kept)));
	} else if ("invoke" in step) {
		const args = withKept(step.args ?? [], kept);
		assertOutcome(step, () =>
			step.owner === undefined ? runtime.invokeExport(step.invoke, args) : runtime.invokeModExport(step.owner, step.invoke, args),
		);
	} else if ("retainStashed" in step) {
		assert.throws(() => state.stashed.retain(), (e) => e instanceof CallbackError && e.reason === step.fails);
	} else {
		assert.fail(`unknown after step ${JSON.stringify(step)}`);
	}
}

async function runCase(factory, entry) {
	const { state, hostBindings } = createProbe();
	const runtime = await factory.createRuntime(manifestFor(entry), { hostBindings });
	try {
		for (const mod of entry.mods ?? []) {
			runtime.loadMod(
				{ xript: "0.9", name: mod.name, version: "1.0.0", entry: "main.js" },
				{ fragmentSources: { "main.js": mod.script } },
			);
		}
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
			if (expect && "result" in expect) assert.deepEqual(value, expect.result);
		}
		if (expect?.typedCalls !== undefined) assert.equal(state.typedCalls, expect.typedCalls);
		if (expect?.expiredAfter) {
			assert.throws(
				() => state.stashed(),
				(e) => e instanceof CallbackError && e.reason === "expired" && e.message.includes("probe.stash"),
			);
		}
		for (const step of entry.after ?? []) runStep(runtime, state, step);
	} finally {
		if (!state.disposed) runtime.dispose();
	}
}

describe("callback corpus", () => {
	let sync;
	let async;

	before(async () => {
		sync = await initXript();
		async = await initXriptAsync();
	});

	it("carries cases", () => {
		assert.ok(corpus.cases.length > 0);
	});

	for (const entry of corpus.cases) {
		it(`sync: ${entry.name}`, () => runCase(sync, entry));
		it(`async sandbox: ${entry.name}`, () => runCase(async, entry));
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
		const factory = await initXriptAsync();
		const runtime = await factory.createRuntime(manifest, {
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
			assert.deepEqual(value, [10, 20]);
			assert.throws(() => kept(3), (e) => e instanceof CallbackError && e.reason === "expired");
		} finally {
			runtime.dispose();
		}
	});

	it("refuses an async binding called from inside a callback", async () => {
		const factory = await initXriptAsync();
		const runtime = await factory.createRuntime(manifest, {
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
});

describe("retained callbacks through async bindings", () => {
	const manifest = {
		xript: "0.10",
		name: "async-retained",
		bindings: {
			later: {
				description: "Retains a function across an await.",
				async: true,
				params: [{ name: "fn", type: "function", retain: true }],
			},
			keep: {
				description: "Retains a function synchronously.",
				params: [{ name: "fn", type: "function", retain: true }],
			},
			fire: { description: "Calls the retained function from inside a binding call." },
			other: { description: "Any async binding.", async: true },
		},
	};

	function host() {
		const state = { kept: null };
		return {
			state,
			hostBindings: {
				later: async (fn) => {
					await new Promise((resolve) => setTimeout(resolve, 5));
					state.kept = fn.retain();
					return null;
				},
				keep: (fn) => {
					state.kept = fn.retain();
					return null;
				},
				fire: () => state.kept.call(),
				other: async () => 1,
			},
		};
	}

	it("retains a callback after the async binding's await and calls it once the binding settled", async () => {
		const { state, hostBindings } = host();
		const runtime = await (await initXriptAsync()).createRuntime(manifest, { hostBindings });
		try {
			await runtime.executeAsync("await later(function () { return 'fired'; });");
			assert.equal(state.kept.call(), "fired");
		} finally {
			runtime.dispose();
		}
	});

	it("refuses an async binding started inside a retained callback called between script calls", async () => {
		const { state, hostBindings } = host();
		const runtime = await (await initXriptAsync()).createRuntime(manifest, { hostBindings });
		try {
			runtime.execute("keep(function () { try { other(); return 'no throw'; } catch (e) { return e.message; } });");
			assert.match(state.kept.call(), /other\(\): cannot be called from inside a callback/);
		} finally {
			runtime.dispose();
		}
	});

	it("refuses an async binding started inside a retained callback called re-entrantly", async () => {
		const { hostBindings } = host();
		const runtime = await (await initXriptAsync()).createRuntime(manifest, { hostBindings });
		try {
			const { value } = runtime.execute(
				"keep(function () { try { other(); return 'no throw'; } catch (e) { return e.message; } }); fire()",
			);
			assert.match(value, /other\(\): cannot be called from inside a callback/);
		} finally {
			runtime.dispose();
		}
	});

	it("attributes callbacks retained inside hook and event handlers to the mod that registered them", async () => {
		const { hostBindings } = host();
		const runtime = (await initXript()).createRuntime(
			{ ...manifest, hooks: { tick: { description: "A hook." } }, events: [{ id: "ping", description: "An event." }] },
			{ hostBindings },
		);
		try {
			runtime.loadMod(
				{ xript: "0.9", name: "alpha", version: "1.0.0", entry: "main.js" },
				{
					fragmentSources: {
						"main.js": "hooks.tick(function () { keep(function () { return 1; }); }); events.on('ping', function () { keep(function () { return 2; }); });",
					},
				},
			);
			runtime.fireHook("tick");
			runtime.emit("ping");
			runtime.execute("keep(function () { return 3; })");
			assert.equal(runtime.releaseRetained("alpha"), 2);
		} finally {
			runtime.dispose();
		}
	});

	it("refuses a retained handle from another runtime when it crosses in", async () => {
		const factory = await initXript();
		const first = host();
		const second = host();
		const a = factory.createRuntime(manifest, { hostBindings: first.hostBindings });
		const b = factory.createRuntime(
			{ ...manifest, bindings: { ...manifest.bindings, give: { description: "Returns the other runtime's handle." } } },
			{ hostBindings: { ...second.hostBindings, give: () => first.state.kept } },
		);
		try {
			a.execute("keep(function () {})");
			assert.throws(() => b.execute("give()"), (e) => /callback expired; a retained callback crosses back only/.test(e.message));
		} finally {
			a.dispose();
			b.dispose();
		}
	});
});
