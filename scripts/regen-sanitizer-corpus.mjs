#!/usr/bin/env node
/**
 * Regenerates the `expected` field of every case in `spec/sanitizer-tests.json`
 * from the current sanitizer, leaving `input`, `description`, and every other
 * field untouched.
 *
 * Run with `--check` to verify the corpus is already in sync without writing.
 *
 * The script refuses to write unless re-serializing the corpus *before* any
 * regeneration reproduces the file on disk byte for byte, so a formatting drift
 * can never ride along inside a content change.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizeHTML } from "../tools/sanitize/dist/index.js";

const corpusPath = resolve(dirname(fileURLToPath(import.meta.url)), "../spec/sanitizer-tests.json");
const original = readFileSync(corpusPath, "utf8");
const cases = JSON.parse(original);

const serialize = (value) => JSON.stringify(value, null, "\t") + (original.endsWith("\n") ? "\n" : "");

if (serialize(cases) !== original) {
	console.error("refusing to run: re-serializing the corpus unchanged does not reproduce the file");
	process.exit(2);
}

const changed = [];
for (const testCase of cases) {
	const actual = sanitizeHTML(testCase.input);
	if (actual !== testCase.expected) {
		changed.push({ description: testCase.description, from: testCase.expected, to: actual });
		testCase.expected = actual;
	}
}

if (process.argv.includes("--check")) {
	if (changed.length > 0) {
		console.error(`corpus is stale: ${changed.length} case(s) differ from the current sanitizer`);
		for (const entry of changed) console.error(`  ${entry.description}`);
		process.exit(1);
	}
	console.log(`corpus is in sync (${cases.length} cases)`);
	process.exit(0);
}

writeFileSync(corpusPath, serialize(cases));
console.log(`regenerated ${changed.length} of ${cases.length} case(s)`);
for (const entry of changed) {
	console.log(`\n${entry.description}\n  - ${entry.from}\n  + ${entry.to}`);
}
