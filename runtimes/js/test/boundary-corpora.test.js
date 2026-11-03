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

function isMarker(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const keys = Object.keys(value);
	return keys.length === 1 && keys[0] === MARKER && Object.prototype.hasOwnProperty.call(SPECIALS, value[MARKER]);
}

/** Turns the corpus's marker spelling into the real values a JavaScript host passes. */
function decode(value) {
	if (isMarker(value)) return SPECIALS[value[MARKER]];
	if (Array.isArray(value)) return value.map(decode);
	if (value !== null && typeof value === "object") {
		const out = {};
		for (const [key, item] of Object.entries(value)) {
			Object.defineProperty(out, key, { value: decode(item), writable: true, enumerable: true, configurable: true });
		}
		return out;
	}
	return value;
}

/** Spells a value the host received the way the corpus does, at any depth. */
function encode(value) {
	if (value === undefined) return { [MARKER]: "undefined" };
	if (typeof value === "number" && Number.isNaN(value)) return { [MARKER]: "NaN" };
	if (value === Infinity) return { [MARKER]: "Infinity" };
	if (value === -Infinity) return { [MARKER]: "-Infinity" };
	if (Object.is(value, -0)) return { [MARKER]: "-0" };
	if (Array.isArray(value)) return Array.from(value, encode);
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item)]));
	}
	return value;
}

const probeScript = (probe) => `(function () { var v = value(); return (${probe}); })()`;

const FIDELITY_HOOK =
	"hooks.probe(function () { return Array.prototype.map.call(arguments, String).join('|') + '#' + arguments.length; })";
const FIDELITY_EVENT =
	"events.on('probed', function () { return Array.prototype.map.call(arguments, String).join('|') + '#' + arguments.length; })";
const KEY_ORDER_HOOK = "hooks.probe(function () { return Array.prototype.join.call(arguments, ','); })";

function bindings(hostValue, received) {
	return {
		value: () => decode(hostValue),
		echo: (...args) => {
			received.length = 0;
			received.push(...args);
			return args;
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
					assert.deepEqual(received.map(encode), testCase.received);
				} finally {
					runtime.dispose();
				}
			});
		}

		for (const testCase of fidelity.results) {
			it(`value fidelity result: ${testCase.name}`, async () => {
				const runtime = await create(fidelity.manifest, { hostBindings: bindings(null, []) });
				try {
					assert.deepEqual(encode(await run(runtime, testCase.script)), testCase.expected);
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
					assert.deepEqual(runtime.emit("probed").map(encode), [testCase.expected]);
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
