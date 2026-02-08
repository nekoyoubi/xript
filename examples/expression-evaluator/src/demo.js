import { createRuntime } from "../../../runtimes/js/dist/index.js";
import { readFile } from "node:fs/promises";

const manifestRaw = await readFile(new URL("../manifest.json", import.meta.url), "utf-8");
const manifest = JSON.parse(manifestRaw);

const hostBindings = {
	abs: (x) => Math.abs(x),
	round: (x) => Math.round(x),
	floor: (x) => Math.floor(x),
	ceil: (x) => Math.ceil(x),
	min: (a, b) => Math.min(a, b),
	max: (a, b) => Math.max(a, b),
	clamp: (value, lo, hi) => Math.min(Math.max(value, lo), hi),
	upper: (s) => String(s).toUpperCase(),
	lower: (s) => String(s).toLowerCase(),
	len: (s) => String(s).length,
	concat: (a, b) => String(a) + String(b),
};

const runtime = createRuntime(manifest, {
	hostBindings,
	console: { log: console.log, warn: console.warn, error: console.error },
});

function demo(expression) {
	try {
		const result = runtime.execute(expression);
		console.log(`  ${expression}  =>  ${JSON.stringify(result.value)}`);
	} catch (e) {
		console.log(`  ${expression}  =>  ERROR: ${e.message}`);
	}
}

console.log("=== xript Expression Evaluator Demo ===\n");

console.log("Math bindings:");
demo("abs(-42)");
demo("round(3.7)");
demo("floor(3.7)");
demo("ceil(3.2)");
demo("min(10, 3)");
demo("max(10, 3)");
demo("clamp(42, 0, 10)");

console.log("\nString bindings:");
demo('upper("hello world")');
demo('lower("HELLO WORLD")');
demo('len("xript")');
demo('concat("hello", " world")');

console.log("\nExpressions using bindings:");
demo("abs(min(-5, -10))");
demo('upper(concat("hello", " xript"))');
demo("clamp(round(3.7), 0, 3)");

console.log("\nSandbox enforcement (these should all fail safely):");
demo('eval("1 + 1")');
demo("process.exit(1)");
demo('require("fs")');
demo("fetch('https://example.com')");

console.log("\nBuilt-in JS still works (within the sandbox):");
demo("2 + 2");
demo("[1, 2, 3].map(x => x * 2)");
demo('JSON.stringify({ greeting: upper("hi") })');

console.log("\n=== Demo complete ===");
