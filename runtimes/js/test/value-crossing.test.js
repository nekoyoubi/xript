import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { initXript, initXriptAsync } from "../dist/index.js";

const NESTED = "({ n: NaN, i: -Infinity, z: -0, u: undefined, list: [undefined, NaN, Infinity, -0] })";

function assertNestedSpecials(value) {
	assert.deepEqual(Object.keys(value), ["n", "i", "z", "u", "list"]);
	assert.ok(Number.isNaN(value.n));
	assert.equal(value.i, -Infinity);
	assert.ok(Object.is(value.z, -0));
	assert.ok("u" in value);
	assert.equal(value.u, undefined);
	assert.equal(value.list.length, 4);
	assert.equal(value.list[0], undefined);
	assert.ok(Number.isNaN(value.list[1]));
	assert.equal(value.list[2], Infinity);
	assert.ok(Object.is(value.list[3], -0));
}

const SCRIPT_CHECK = `[Object.keys(v).join(','), Number.isNaN(v.n), v.i, Object.is(v.z, -0), 'u' in v, typeof v.u,
	v.list.length, typeof v.list[0], Number.isNaN(v.list[1]), v.list[2], Object.is(v.list[3], -0)].join('|')`;
const SCRIPT_EXPECTED = "n,i,z,u,list|true|-Infinity|true|true|undefined|4|undefined|true|Infinity|true";

const hostSpecials = () => ({ n: NaN, i: -Infinity, z: -0, u: undefined, list: [undefined, NaN, Infinity, -0] });

const manifest = {
	xript: "0.10",
	name: "value-crossing",
	bindings: {
		echo: { description: "Returns its first argument." },
		apply: { description: "Calls a function with a host value and returns what it returned." },
		keep: { description: "Retains a function.", params: [{ name: "fn", type: "function", retain: true }] },
	},
	hooks: { probe: { description: "Reports what its handlers return." } },
	events: [{ id: "probed", description: "Reports what its subscribers return." }],
};

const exportingMod = {
	xript: "0.10",
	name: "exporter",
	version: "1.0.0",
	entry: {
		format: "script",
		script: "main.js",
		exports: {
			inspect: { description: "Reports what it received." },
			produce: { description: "Returns nested special values." },
		},
	},
};

const exportingSource = `
	xript.exports.register("inspect", function (v) { return ${SCRIPT_CHECK}; });
	xript.exports.register("produce", function () { return ${NESTED}; });
`;

for (const [variant, init] of [["sync", initXript], ["async", initXriptAsync]]) {
	describe(`values crossing the host boundary keep their JavaScript identity (${variant} sandbox)`, () => {
		let xript;
		before(async () => {
			xript = await init();
		});

		async function withRuntime(hostBindings, body, options = {}, limits = undefined) {
			const runtime = await xript.createRuntime(limits ? { ...manifest, limits } : manifest, { hostBindings, ...options });
			try {
				return await body(runtime);
			} finally {
				runtime.dispose();
			}
		}

		it("a binding receives nested special values as themselves", async () => {
			let received;
			await withRuntime({ echo: (v) => (received = v) }, (runtime) => runtime.execute(`echo(${NESTED})`));
			assertNestedSpecials(received);
		});

		it("a callback's arguments and return value keep nested special values", async () => {
			let returned;
			const { value } = await withRuntime(
				{ apply: (fn) => (returned = fn(hostSpecials())) },
				(runtime) => runtime.execute(`(function () { var seen; apply(function (v) { seen = ${SCRIPT_CHECK}; return ${NESTED}; }); return seen; })()`),
			);
			assert.equal(value, SCRIPT_EXPECTED);
			assertNestedSpecials(returned);
		});

		it("a retained callback's return value keeps nested special values", async () => {
			let kept;
			await withRuntime({ keep: (fn) => (kept = fn.retain()) }, (runtime) => {
				runtime.execute(`keep(function () { return ${NESTED}; })`);
				assertNestedSpecials(kept.call());
				kept.release();
			});
		});

		it("an export receives and returns nested special values", async () => {
			await withRuntime({}, (runtime) => {
				runtime.loadMod(exportingMod, { fragmentSources: { "main.js": exportingSource } });
				assert.equal(runtime.invokeExport("inspect", [hostSpecials()]), SCRIPT_EXPECTED);
				assertNestedSpecials(runtime.invokeExport("produce", []));
			});
		});

		it("an async export invocation returns nested special values", async () => {
			await withRuntime({}, async (runtime) => {
				runtime.loadMod(exportingMod, { fragmentSources: { "main.js": exportingSource } });
				assertNestedSpecials(await runtime.invokeExportAsync("produce", []));
			});
		});

		it("hook and event handlers return nested special values", async () => {
			await withRuntime({}, (runtime) => {
				runtime.execute(`hooks.probe(function () { return ${NESTED}; }); events.on('probed', function () { return ${NESTED}; });`);
				const [hookResult] = runtime.fireHook("probe");
				assertNestedSpecials(hookResult);
				const [eventResult] = runtime.emit("probed");
				assertNestedSpecials(eventResult);
			});
		});

		it("executeAsync returns nested special values", async () => {
			await withRuntime({}, async (runtime) => {
				assertNestedSpecials((await runtime.executeAsync(`return ${NESTED};`)).value);
			});
		});

		it("console receives nested special values", async () => {
			const logged = [];
			await withRuntime({}, (runtime) => runtime.execute(`console.log(${NESTED})`), { console: { log: (...args) => logged.push(...args) } });
			assertNestedSpecials(logged[0]);
		});

		it("a function nested in a binding argument is a callable proxy at its path", async () => {
			const { value } = await withRuntime(
				{ apply: (opts) => opts.list[1].run(20) + opts.top(1) },
				(runtime) => runtime.execute("apply({ top: function (n) { return n + 1; }, list: [0, { run: function (n) { return n * 2; } }] })"),
			);
			assert.equal(value, 42);
		});

		it("a string holding NUL crosses whole in both directions, as a value and as a key", async () => {
			const nul = String.fromCharCode(0);
			let received;
			await withRuntime({ echo: (v) => (received = v), apply: (fn) => fn(`a${nul}b`, { [`k${nul}`]: `v${nul}` }) }, (runtime) => {
				const make = "'a' + String.fromCharCode(0) + 'b'";
				runtime.execute(`echo(${make})`);
				assert.equal(received, `a${nul}b`);
				runtime.execute(`echo({ s: ${make}, list: [${make}], keyed: (function () { var o = {}; o[${make}] = 1; return o; })() })`);
				assert.deepEqual(received, { s: `a${nul}b`, list: [`a${nul}b`], keyed: { [`a${nul}b`]: 1 } });
				assert.equal(runtime.execute(make).value, `a${nul}b`);
				const seen = runtime.execute(
					"apply(function (s, o) { var k = Object.keys(o)[0]; return [s.length, s.charCodeAt(1), k.length, o[k].length].join('|'); })",
				).value;
				assert.equal(seen, "3|0|2|2");
			});
		});

		it("a long string holding a lone surrogate crosses whole, at the top level and nested", async () => {
			const lone = `${String.fromCharCode(0xd800)}abcdefghijklmnopqrstuvwxyz`;
			let received;
			await withRuntime({ echo: (v) => (received = v) }, (runtime) => {
				const make = "String.fromCharCode(0xD800) + 'abcdefghijklmnopqrstuvwxyz'";
				runtime.execute(`echo(${make})`);
				assert.equal(received, lone);
				runtime.execute(`echo({ k: ${make}, list: ['plain', ${make}] })`);
				assert.deepEqual(received, { k: lone, list: ["plain", lone] });
				assert.equal(runtime.execute(make).value, lone);
			});
		});

		it("a host string holding a lone surrogate arrives whole, alone, nested, and beside special values", async () => {
			const lone = `${String.fromCharCode(0xd800)}abc`;
			const values = [lone, { s: lone }, { s: lone, n: NaN }];
			let next = 0;
			await withRuntime({ echo: () => values[next++] }, (runtime) => {
				const { value } = runtime.execute(`(function () {
					function units(s) { var out = []; for (var i = 0; i < s.length; i++) out.push(s.charCodeAt(i).toString(16)); return out.join(','); }
					var a = echo(), b = echo(), c = echo();
					return [units(a), units(b.s), units(c.s), Number.isNaN(c.n)].join('|');
				})()`);
				assert.equal(value, "d800,61,62,63|d800,61,62,63|d800,61,62,63|true");
			});
		});

		it("a setter a script put on a prototype never sees a host value crossing in", async () => {
			const values = [{ token: "secret", list: ["first"] }, { token: "secret", list: ["first"], n: NaN }];
			let next = 0;
			await withRuntime({ echo: () => values[next++] }, (runtime) => {
				const { value } = runtime.execute(`(function () {
					var seen = 0;
					Object.defineProperty(Object.prototype, "token", { set: function () { seen += 1; }, configurable: true });
					Object.defineProperty(Array.prototype, "0", { set: function () { seen += 1; }, configurable: true });
					var clean = echo(), special = echo();
					var report = [
						Object.keys(clean).join(","), clean.token, clean.list[0],
						Object.keys(special).join(","), special.token, special.list[0], Number.isNaN(special.n),
						seen,
					].join("|");
					delete Object.prototype.token;
					delete Array.prototype[0];
					return report;
				})()`);
				assert.equal(value, "token,list|secret|first|token,list,n|secret|first|true|0");
			});
		});

		it("an own __proto__ key in a binding argument stays data", async () => {
			let received;
			await withRuntime({ echo: (v) => (received = v) }, (runtime) => runtime.execute("echo(JSON.parse('{\"__proto__\":{\"polluted\":true},\"ok\":1}'))"));
			assert.deepEqual(Object.keys(received), ["__proto__", "ok"]);
			assert.equal(Object.getPrototypeOf(received), Object.prototype);
			assert.equal(received.polluted, undefined);
		});

		it("keeps the JSON-shaped rules for values that are not plain data", async () => {
			let received;
			await withRuntime({ echo: (v) => (received = v) }, (runtime) => {
				const shaped = "({ d: new Date(0), m: new Map([[1, 2]]), n: new Number(3), s: Symbol('s'), f: function () {}, a: [Symbol('s')] })";
				runtime.execute(`echo(${shaped})`);
				assert.equal(received.d, "1970-01-01T00:00:00.000Z");
				assert.deepEqual(received.m, {});
				assert.equal(received.n, 3);
				assert.ok(!("s" in received));
				assert.equal(typeof received.f, "function");
				assert.deepEqual(received.a, [null]);

				const result = runtime.execute(shaped).value;
				assert.deepEqual(Object.keys(result), ["d", "m", "n", "a"]);
				assert.deepEqual(result.a, [null]);
			});
		});

		it("a cyclic value still crosses as its string, both ways", async () => {
			let received;
			await withRuntime({ echo: (v) => (received = v) }, (runtime) => {
				const cyclic = "(function () { var o = { a: 1 }; o.self = o; return o; })()";
				runtime.execute(`echo(${cyclic})`);
				assert.equal(received, "[object Object]");
				assert.equal(runtime.execute(cyclic).value, "[object Object]");
			});
		});

		it("a shared, acyclic reference is copied at each place it appears", async () => {
			await withRuntime({}, (runtime) => {
				assert.deepEqual(runtime.execute("(function () { var o = { a: 1 }; return { x: o, y: [o] }; })()").value, { x: { a: 1 }, y: [{ a: 1 }] });
			});
		});

		it("a top-level error result keeps its name and message", async () => {
			await withRuntime({}, (runtime) => {
				const value = runtime.execute("new RangeError('boom')").value;
				assert.equal(value.name, "RangeError");
				assert.equal(value.message, "boom");
			});
		});

		it("a promise result crosses as an empty object instead of breaking dispose", async () => {
			await withRuntime({}, (runtime) => {
				assert.deepEqual(runtime.execute("Promise.resolve(1)").value, {});
				runtime.execute("hooks.probe(function () { return Promise.resolve(1); })");
				assert.deepEqual(runtime.fireHook("probe"), [{}]);
			});
		});

		it("a hook handler returning a function hands the host null", async () => {
			await withRuntime({}, (runtime) => {
				runtime.execute("hooks.probe(function () { return function () { return 1; }; })");
				assert.deepEqual(runtime.fireHook("probe"), [null]);
			});
		});

		it("a binding argument whose walk exhausts the budget ends the call before the host runs", async () => {
			let ran = false;
			await withRuntime(
				{ echo: () => (ran = true) },
				(runtime) => {
					assert.throws(() => runtime.execute("echo({ get slow() { for (;;) {} } })"), /timed out|limit|interrupted/i);
				},
				{},
				{ timeout_ms: 50 },
			);
			assert.equal(ran, false);
		});
	});
}
