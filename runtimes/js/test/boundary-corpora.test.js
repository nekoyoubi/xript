import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { initXript, initXriptAsync } from "../dist/index.js";

const load = (name) =>
	JSON.parse(readFileSync(fileURLToPath(new URL(`../../../spec/${name}`, import.meta.url)), "utf8"));

const fidelity = load("value-fidelity-tests.json");
const keyOrder = load("key-order-tests.json");
const phases = load("hook-phase-tests.json");

const MARKER = "$xript";
const SPECIALS = { undefined: undefined, NaN: NaN, Infinity: Infinity, "-Infinity": -Infinity, "-0": -0 };
const PAYLOADS = { bigint: [["value"], []], symbol: [[], ["description"]], string: [["units"], []], cycle: [["up"], []] };

function markerTag(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	if (!Object.prototype.hasOwnProperty.call(value, MARKER)) return null;
	const tag = value[MARKER];
	const keys = Object.keys(value).filter((key) => key !== MARKER);
	if (Object.prototype.hasOwnProperty.call(SPECIALS, tag)) return keys.length === 0 ? tag : null;
	if (!Object.prototype.hasOwnProperty.call(PAYLOADS, tag)) return null;
	const [required, optional] = PAYLOADS[tag];
	if (!required.every((key) => keys.includes(key))) return null;
	return keys.every((key) => required.includes(key) || optional.includes(key)) ? tag : null;
}

/** Turns the corpus's marker spelling into the real values a JavaScript host passes, cycles included. */
function decode(value, ancestors = []) {
	let tag = markerTag(value);
	if (tag === "cycle" && !(Number.isInteger(value.up) && value.up >= 1 && value.up <= ancestors.length)) tag = null;
	if (tag !== null) {
		if (Object.prototype.hasOwnProperty.call(SPECIALS, tag)) return SPECIALS[tag];
		if (tag === "bigint") return BigInt(value.value);
		if (tag === "symbol") return "description" in value ? Symbol(value.description) : Symbol();
		if (tag === "string") return String.fromCharCode(...value.units);
		return ancestors[ancestors.length - value.up];
	}
	if (value === null || typeof value !== "object") return value;
	const out = Array.isArray(value) ? [] : {};
	ancestors.push(out);
	for (const [key, item] of Object.entries(value)) {
		Object.defineProperty(out, key, { value: decode(item, ancestors), writable: true, enumerable: true, configurable: true });
	}
	ancestors.pop();
	return out;
}

function unwrapped(value) {
	const tag = Object.prototype.toString.call(value);
	const valueOf = {
		"[object Number]": Number.prototype.valueOf,
		"[object String]": String.prototype.valueOf,
		"[object Boolean]": Boolean.prototype.valueOf,
		"[object BigInt]": BigInt.prototype.valueOf,
	}[tag];
	if (!valueOf) return value;
	try {
		return valueOf.call(value);
	} catch {
		return value;
	}
}

/** Spells a value the host received the way the corpus does, at any depth, cycles as back-references. */
function encode(value, ancestors = []) {
	if (value === undefined) return { [MARKER]: "undefined" };
	if (typeof value === "number") {
		if (Number.isNaN(value)) return { [MARKER]: "NaN" };
		if (value === Infinity) return { [MARKER]: "Infinity" };
		if (value === -Infinity) return { [MARKER]: "-Infinity" };
		if (Object.is(value, -0)) return { [MARKER]: "-0" };
		return value;
	}
	if (typeof value === "bigint") return { [MARKER]: "bigint", value: String(value) };
	if (typeof value === "symbol") {
		return value.description === undefined ? { [MARKER]: "symbol" } : { [MARKER]: "symbol", description: value.description };
	}
	if (typeof value === "string") {
		return value.isWellFormed() ? value : { [MARKER]: "string", units: Array.from({ length: value.length }, (_, i) => value.charCodeAt(i)) };
	}
	if (value === null || typeof value !== "object") return value;
	const primitive = unwrapped(value);
	if (primitive !== value) return encode(primitive, ancestors);
	if (Object.prototype.toString.call(value) === "[object Date]") return encode(Date.prototype.toJSON.call(value), ancestors);
	const at = ancestors.lastIndexOf(value);
	if (at !== -1) return { [MARKER]: "cycle", up: ancestors.length - at };
	ancestors.push(value);
	try {
		if (Array.isArray(value)) return Array.from({ length: value.length }, (_, i) => encode(value[i], ancestors));
		const out = {};
		for (const key of Object.keys(value)) {
			Object.defineProperty(out, key, { value: encode(value[key], ancestors), writable: true, enumerable: true, configurable: true });
		}
		return out;
	} finally {
		ancestors.pop();
	}
}

function nested(shape, depth) {
	let value = 0;
	for (let i = 0; i < depth; i++) value = shape === "object" ? { d: value } : [value];
	return value;
}

function depthOf(shape, value) {
	let levels = 0;
	while (shape === "object" ? value !== null && typeof value === "object" && !Array.isArray(value) : Array.isArray(value)) {
		value = shape === "object" ? value.d : value[0];
		levels++;
	}
	return value === 0 ? levels : -1;
}

const probeScript = (probe) => `(function () { var v = value(); return (${probe}); })()`;

const FIDELITY_HOOK =
	"hooks.probe(function () { return Array.prototype.map.call(arguments, String).join('|') + '#' + arguments.length; })";
const FIDELITY_EVENT =
	"events.on('probed', function () { return Array.prototype.map.call(arguments, String).join('|') + '#' + arguments.length; })";
const KEY_ORDER_HOOK = "hooks.probe(function () { return Array.prototype.join.call(arguments, ','); })";

function bindings(hostValue, received, decoded = true) {
	return {
		value: () => (decoded ? decode(hostValue) : hostValue),
		echo: (...args) => {
			received.length = 0;
			received.push(...args);
			return args;
		},
		sink: (...args) => {
			received.called = true;
			received.length = 0;
			received.push(...args);
		},
		call: (fn) => {
			const result = fn();
			received.callbackResult = result;
			return result;
		},
	};
}

for (const variant of ["sync", "async"]) {
	describe(`host boundary corpora (${variant} sandbox)`, () => {
		let xript;
		before(async () => {
			xript = variant === "sync" ? await initXript() : await initXriptAsync();
		});

		const create = (manifest, options) => xript.createRuntime(manifest, options);
		const run = async (runtime, code) => (await runtime.execute(code)).value;

		for (const testCase of fidelity.inbound) {
			it(`value fidelity inbound: ${testCase.name}`, async () => {
				const runtime = await create(fidelity.manifest, { hostBindings: bindings(testCase.hostValue, []) });
				try {
					assert.equal(await run(runtime, probeScript(testCase.probe)), testCase.expected);
				} finally {
					runtime.dispose();
				}
			});
		}

		for (const testCase of fidelity.echo) {
			it(`value fidelity echo: ${testCase.name}`, async () => {
				const received = [];
				const runtime = await create(fidelity.manifest, { hostBindings: bindings(null, received) });
				try {
					assert.equal(await run(runtime, testCase.script), testCase.expected);
					assert.deepEqual(received.map((arg) => encode(arg)), testCase.received);
				} finally {
					runtime.dispose();
				}
			});
		}

		for (const testCase of fidelity.sink) {
			it(`value fidelity sink: ${testCase.name}`, async () => {
				const received = [];
				const runtime = await create(fidelity.manifest, { hostBindings: bindings(null, received) });
				try {
					assert.equal(await run(runtime, testCase.script), testCase.expected);
					if (testCase.received === null) assert.equal(received.called, undefined, "sink must not be called");
					else assert.deepEqual(received.map((arg) => encode(arg)), testCase.received);
				} finally {
					runtime.dispose();
				}
			});
		}

		for (const testCase of fidelity.results) {
			it(`value fidelity result: ${testCase.name}`, async () => {
				const runtime = await create(fidelity.manifest, { hostBindings: bindings(null, []) });
				try {
					if (testCase.fails) await assert.rejects(async () => run(runtime, testCase.script));
					else assert.deepEqual(encode(await run(runtime, testCase.script)), testCase.expected);
				} finally {
					runtime.dispose();
				}
			});
		}

		for (const testCase of fidelity.hook) {
			it(`value fidelity hook: ${testCase.name}`, async () => {
				const runtime = await create(fidelity.manifest, { hostBindings: bindings(null, []) });
				try {
					await run(runtime, FIDELITY_HOOK);
					assert.deepEqual(runtime.fireHook("probe", { data: decode(testCase.data) }), [testCase.expected]);
				} finally {
					runtime.dispose();
				}
			});
		}

		for (const testCase of fidelity.event) {
			it(`value fidelity event: ${testCase.name}`, async () => {
				const runtime = await create(fidelity.manifest, { hostBindings: bindings(null, []) });
				try {
					await run(runtime, FIDELITY_EVENT);
					assert.deepEqual(runtime.emit("probed", decode(testCase.data)), [testCase.expected]);
				} finally {
					runtime.dispose();
				}
			});
		}

		for (const testCase of fidelity.eventResult) {
			it(`value fidelity event result: ${testCase.name}`, async () => {
				const runtime = await create(fidelity.manifest, { hostBindings: bindings(null, []) });
				try {
					await run(runtime, `events.on('probed', function () { return ${testCase.returns}; })`);
					assert.deepEqual(runtime.emit("probed").map((result) => encode(result)), [testCase.expected]);
				} finally {
					runtime.dispose();
				}
			});
		}

		for (const testCase of fidelity.depth) {
			it(`value fidelity depth: ${testCase.name}`, async () => {
				const received = [];
				const hostValue = testCase.direction === "inbound" ? nested(testCase.shape, testCase.depth) : null;
				const runtime = await create(fidelity.manifest, { hostBindings: bindings(hostValue, received, false) });
				try {
					const result = await run(runtime, testCase.script);
					if ("error" in testCase) {
						assert.equal(typeof result, "string");
						assert.ok(result.startsWith(testCase.error), `expected a message beginning ${testCase.error}, got ${result.slice(0, 200)}`);
						assert.ok(!result.startsWith(testCase.error + testCase.error), `the prefix repeats: ${result.slice(0, 200)}`);
					} else {
						assert.equal(result, testCase.expected);
						if (testCase.direction === "outbound") assert.equal(depthOf(testCase.shape, received[0]), testCase.depth);
					}
				} finally {
					runtime.dispose();
				}
			});
		}

		for (const testCase of fidelity.callbackResult) {
			it(`value fidelity callback result: ${testCase.name}`, async () => {
				const received = [];
				const runtime = await create(fidelity.manifest, { hostBindings: bindings(null, received) });
				try {
					if ("error" in testCase) {
						const script = `(function () { try { call(function () { return ${testCase.returns}; }); return 'crossed'; } catch (e) { return e.name; } })()`;
						assert.equal(await run(runtime, script), testCase.error);
					} else {
						await run(runtime, `call(function () { return ${testCase.returns}; }); 0`);
						assert.ok("callbackResult" in received, "call must have run the callback");
						assert.deepEqual(encode(received.callbackResult), testCase.expected);
					}
				} finally {
					runtime.dispose();
				}
			});
		}

		for (const testCase of fidelity.prefix) {
			it(`value fidelity prefix: ${testCase.name}`, async () => {
				const runtime = await create(fidelity.manifest, { hostBindings: bindings(null, []) });
				try {
					const message = await run(runtime, testCase.script);
					assert.ok(message.startsWith(testCase.prefix), `expected a message beginning ${testCase.prefix}, got ${message}`);
					assert.ok(!message.startsWith(testCase.prefix + testCase.prefix), `the prefix repeats: ${message}`);
				} finally {
					runtime.dispose();
				}
			});
		}

		for (const testCase of keyOrder.inbound) {
			it(`key order inbound: ${testCase.name}`, async () => {
				const runtime = await create(keyOrder.manifest, { hostBindings: bindings(testCase.hostValue, []) });
				try {
					assert.equal(await run(runtime, probeScript(testCase.probe)), testCase.expected);
				} finally {
					runtime.dispose();
				}
			});
		}

		for (const testCase of keyOrder.echo) {
			it(`key order echo: ${testCase.name}`, async () => {
				const runtime = await create(keyOrder.manifest, { hostBindings: bindings(null, []) });
				try {
					assert.equal(await run(runtime, testCase.script), testCase.expected);
				} finally {
					runtime.dispose();
				}
			});
		}

		for (const testCase of keyOrder.hook) {
			it(`key order hook: ${testCase.name}`, async () => {
				const runtime = await create(keyOrder.manifest, { hostBindings: bindings(null, []) });
				try {
					await run(runtime, KEY_ORDER_HOOK);
					assert.deepEqual(runtime.fireHook("probe", { data: testCase.data }), [testCase.expected]);
				} finally {
					runtime.dispose();
				}
			});
		}

		it("hook phases fire one phase at a time", async () => {
			const runtime = await create(phases.manifest, {});
			try {
				runtime.loadMod(phases.mod.manifest, { fragmentSources: { "mod.js": phases.mod.source } });
				await run(runtime, phases.setup);
				for (const testCase of phases.cases) {
					const options = "data" in testCase ? { phase: testCase.phase, data: testCase.data } : { phase: testCase.phase };
					assert.deepEqual(runtime.fireHook(testCase.hook, options), testCase.expected, testCase.name);
				}
			} finally {
				runtime.dispose();
			}
		});
	});
}
