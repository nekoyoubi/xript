import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..");
const specSource = join(packageRoot, "..", "..", "spec");
const specTarget = join(packageRoot, "content", "spec");

// The schema files served as resources — an explicit list, because `spec/` holds many `.json`
// files (conformance corpora, test fixtures) that are not served. The markdown pages, by
// contrast, are derived from the directory below: every `spec/*.md` except the dir README is a
// page, so a new spec page syncs itself and only needs a `SPEC_RESOURCES` entry to be served.
// That entry is guarded by a completeness test, so a page can never again fall out of one list
// while staying in another.
const SPEC_SCHEMAS = ["manifest.schema.json", "mod-manifest.schema.json", "harness.schema.json", "harness-steps.schema.json"];

await rm(specTarget, { recursive: true, force: true });
await mkdir(specTarget, { recursive: true });

const available = new Set(await readdir(specSource));
const specDocs = [...available].filter((name) => name.endsWith(".md") && name !== "README.md").sort();
const missing = [];

for (const file of [...specDocs, ...SPEC_SCHEMAS]) {
	if (!available.has(file)) {
		missing.push(file);
		continue;
	}
	await cp(join(specSource, file), join(specTarget, file));
}

if (missing.length > 0) {
	console.error(`sync-content: missing spec sources: ${missing.join(", ")}`);
	process.exit(1);
}

console.log(`sync-content: copied ${specDocs.length + SPEC_SCHEMAS.length} spec files into content/spec/`);
