import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRuntime, CallbackError } from "../dist/index.js";

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
	const state = { typedCalls: 0, stashed: null };
	const probe = {
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
		typed: () => {
			state.typedCalls++;
			return "called";
		},
		typedOptional: (fn) => {
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
	if (entry.timeoutMs === undefined) return corpus.manifest;
	return { ...corpus.manifest, limits: { timeout_ms: entry.timeoutMs } };
}

function plain(value) {
	return JSON.parse(JSON.stringify(value));
}

function runCase(entry) {
	const { state, hostBindings } = createProbe();
	const runtime = createRuntime(manifestFor(entry), { hostBindings });
	try {
		const expect = entry.expect;
		if (expect.limit) {
			assert.throws(() => runtime.execute(entry.script), (e) => e.name === "ExecutionLimitError");
			return;
		}
		if (expect.error) {
			assert.throws(
				() => runtime.execute(entry.script),
				(e) => expect.error.every((part) => e.message.includes(part)),
			);
		} else {
			const { value } = runtime.execute(entry.script);
			assert.deepEqual(plain(value), expect.result);
		}
		if (expect.typedCalls !== undefined) assert.equal(state.typedCalls, expect.typedCalls);
		if (expect.expiredAfter) {
			assert.throws(
				() => state.stashed(),
				(e) => e instanceof CallbackError && e.reason === "expired" && e.message.includes("probe.stash"),
			);
		}
	} finally {
		runtime.dispose();
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
