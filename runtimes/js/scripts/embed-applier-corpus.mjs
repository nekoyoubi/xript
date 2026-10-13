import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../../../spec/fragment-applier-tests.json", import.meta.url));
const target = fileURLToPath(new URL("../src/applier-cases.ts", import.meta.url));

const corpus = JSON.parse(readFileSync(source, "utf8"));
const body = [
	"// Generated from spec/fragment-applier-tests.json by scripts/embed-applier-corpus.mjs. Do not edit.",
	"import type { FragmentApplierCase } from \"./applier-conformance.js\";",
	"",
	`export const FRAGMENT_APPLIER_CASES: FragmentApplierCase[] = ${JSON.stringify(corpus.cases, null, "\t")} as unknown as FragmentApplierCase[];`,
	"",
].join("\n");

let current = "";
try {
	current = readFileSync(target, "utf8");
} catch {}
if (current !== body) writeFileSync(target, body);
