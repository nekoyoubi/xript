import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..");
const specSource = join(packageRoot, "..", "..", "spec");
const specTarget = join(packageRoot, "content", "spec");

const SPEC_DOCS = [
	"manifest.md",
	"mod-manifest.md",
	"capabilities.md",
	"bindings.md",
	"hooks.md",
	"fragments.md",
	"modules.md",
	"security.md",
	"vision.md",
	"annotations.md",
	"debug-protocol.md",
];

const SPEC_SCHEMAS = ["manifest.schema.json", "mod-manifest.schema.json"];

await rm(specTarget, { recursive: true, force: true });
await mkdir(specTarget, { recursive: true });

const available = new Set(await readdir(specSource));
const missing = [];

for (const file of [...SPEC_DOCS, ...SPEC_SCHEMAS]) {
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

console.log(`sync-content: copied ${SPEC_DOCS.length + SPEC_SCHEMAS.length} spec files into content/spec/`);
