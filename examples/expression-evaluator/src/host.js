import { createRuntime } from "../../../runtimes/js/dist/index.js";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";

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

console.log("xript Expression Evaluator");
console.log("Type expressions using the available bindings:");
console.log("  abs, round, floor, ceil, min, max, clamp, upper, lower, len, concat");
console.log('  Example: clamp(42, 0, 10)  =>  10');
console.log('  Example: upper("hello")    =>  HELLO');
console.log("Type .exit to quit\n");

const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "xript> " });
rl.prompt();

rl.on("line", (line) => {
	const input = line.trim();
	if (input === ".exit" || input === "exit") {
		rl.close();
		return;
	}
	if (input === "") {
		rl.prompt();
		return;
	}

	try {
		const result = runtime.execute(input);
		console.log(result.value);
	} catch (e) {
		console.error(`Error: ${e.message}`);
	}

	rl.prompt();
});

rl.on("close", () => {
	console.log("\nGoodbye!");
	process.exit(0);
});
