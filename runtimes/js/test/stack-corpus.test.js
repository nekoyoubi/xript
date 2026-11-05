import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { initXript, initXriptAsync } from "../dist/index.js";

const corpus = JSON.parse(readFileSync(fileURLToPath(new URL("../../../spec/stack-tests.json", import.meta.url)), "utf8"));
const scriptFor = (testCase) => corpus.template.replace("SCRIPT", () => testCase.script);

/**
 * Recurses until the host stack runs out, then calls `attempt` on the way back up, one frame
 * at a time, until it returns true. Every remaining stack depth between "none" and "enough" is
 * tried in turn, so the run cannot step over the depths where the engine runs out underneath a
 * call, however large the host's frames happen to be.
 */
function fromTheBottom(attempt) {
	let done = false;
	try {
		done = fromTheBottom(attempt);
	} catch {
		done = false;
	}
	return done || attempt();
}

for (const variant of ["sync", "async"]) {
	describe(`stack corpus (${variant} sandbox)`, () => {
		let xript;
		before(async () => {
			xript = variant === "sync" ? await initXript() : await initXriptAsync();
		});

		for (const testCase of corpus.cases) {
			it(testCase.name, async () => {
				const runtime = await xript.createRuntime(corpus.manifest, {});
				try {
					const outcome = runtime.execute(scriptFor(testCase)).value;
					assert.ok(outcome === "caught" || outcome === "ok", `got ${outcome}`);
					assert.equal(runtime.execute(corpus.after).value, corpus.afterExpected);
				} finally {
					assert.doesNotThrow(() => runtime.dispose());
				}
			});
		}

		it("a script exhausting the engine from a nearly full host stack fails only its own runtime", async () => {
			const recursion = scriptFor(corpus.cases.find((c) => c.name === "plain recursion"));
			const pool = [];
			for (let i = 0; i < 3; i++) pool.push(await xript.createRuntime(corpus.manifest, {}));
			let current = 0;
			let reachedEnough = false;
			fromTheBottom(() => {
				let outcome;
				try {
					outcome = pool[current].execute(recursion).value;
				} catch (error) {
					outcome = error;
				}
				if (outcome === "caught") {
					reachedEnough = true;
					return true;
				}
				if (outcome instanceof Error && outcome.name === "EngineStackExhaustedError") current += 1;
				return current === pool.length;
			});
			assert.ok(current > 0, "no depth left the engine too little host stack");
			for (let i = 0; i < pool.length; i++) {
				if (i < current) {
					assert.throws(() => pool[i].execute("1 + 1"), { name: "EngineStackExhaustedError" });
				} else {
					assert.equal(pool[i].execute("1 + 1").value, 2);
				}
				assert.doesNotThrow(() => pool[i].dispose());
			}
			assert.ok(reachedEnough || current === pool.length);
			const fresh = await xript.createRuntime(corpus.manifest, {});
			assert.equal(fresh.execute(corpus.after).value, corpus.afterExpected);
			fresh.dispose();
		});
	});

	describe(`JSON.parse nesting limit (${variant} sandbox)`, () => {
		let xript;
		let runtime;
		before(async () => {
			xript = variant === "sync" ? await initXript() : await initXriptAsync();
			runtime = await xript.createRuntime(corpus.manifest, {});
		});
		after(() => runtime.dispose());

		const nested = (depth, open, close) => `new Array(${depth + 1}).join('${open}') + '0' + new Array(${depth + 1}).join('${close}')`;
		const attemptIn = (target, expression) =>
			target.execute(`(function () { try { return ${expression}; } catch (e) { return e.name + ': ' + e.message; } })()`).value;
		const attempt = (expression) => attemptIn(runtime, expression);
		const depthOf = (expression) => `(function (v) { var d = 0; while (typeof v === 'object') { v = Array.isArray(v) ? v[0] : v.d; d++; } return d; })(${expression})`;

		it("parses arrays and objects nested 1000 levels deep", () => {
			assert.equal(attempt(depthOf(`JSON.parse(${nested(1000, "[", "]")})`)), 1000);
			assert.equal(attempt(depthOf(`JSON.parse(${nested(1000, '{"d":', "}")})`)), 1000);
		});

		it("refuses text nested 1001 levels deep with a catchable stack overflow", () => {
			assert.equal(attempt(`JSON.parse(${nested(1001, "[", "]")})`), "InternalError: stack overflow");
			assert.equal(attempt(`JSON.parse(${nested(1001, '{"d":', "}")})`), "InternalError: stack overflow");
			assert.equal(runtime.execute(corpus.after).value, corpus.afterExpected);
		});

		it("does not count brackets inside strings, escaped quotes included", () => {
			assert.equal(attempt(`JSON.parse('"' + new Array(5001).join('[') + '"').length`), 5000);
			assert.equal(attempt(`JSON.parse('["\\\\"' + new Array(5001).join('{') + '"]')[0].length`), 5001);
		});

		it("parses a wide, shallow text holding many brackets", () => {
			assert.equal(attempt(`JSON.parse('[' + new Array(5001).join('[{"a":[1]}],') + '0]').length`), 5001);
		});

		it("keeps the reviver and the engine's own syntax errors", () => {
			assert.equal(attempt(`JSON.parse('{"a":1,"b":2}', function (k, v) { return typeof v === 'number' ? v * 10 : v; }).b`), 20);
			assert.match(attempt(`JSON.parse('[1,')`), /^SyntaxError/);
			assert.equal(attempt(`JSON.parse.name`), "parse");
		});

		it("measures nesting the same way after a script rewrites RegExp.prototype", async () => {
			const tampered = `(function () {
				RegExp.prototype.exec = function () { return null; };
				RegExp.prototype[Symbol.replace] = function () { return ''; };
				Object.defineProperty(RegExp.prototype, 'global', { get: function () { return false; } });
				Object.defineProperty(RegExp.prototype, 'flags', { get: function () { return ''; } });
			})()`;
			const target = await xript.createRuntime(corpus.manifest, {});
			try {
				target.execute(tampered);
				assert.equal(attemptIn(target, `JSON.parse(${nested(1001, "[", "]")})`), "InternalError: stack overflow");
				assert.equal(attemptIn(target, `JSON.parse(${nested(1000, "[", "]")}).length`), 1);
				assert.equal(target.execute(corpus.after).value, corpus.afterExpected);
			} finally {
				target.dispose();
			}
		});
	});
}
