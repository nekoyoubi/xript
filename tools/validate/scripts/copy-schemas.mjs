import { mkdir, copyFile, readdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const specDir = resolve(here, "../../../spec");
const outDir = resolve(here, "../dist/schema");

const schemas = [
	"manifest.schema.json",
	"mod-manifest.schema.json",
	"capability-prompt.schema.json",
	"install-descriptor.schema.json",
	"discovery-result.schema.json",
	"debug-messages.schema.json",
];

await mkdir(outDir, { recursive: true });
for (const name of schemas) {
	await copyFile(resolve(specDir, name), resolve(outDir, name));
}

for (const family of ["manifest", "mod-manifest"]) {
	const from = resolve(specDir, "history", family);
	const to = resolve(outDir, "history", family);
	await mkdir(to, { recursive: true });
	for (const file of await readdir(from)) {
		if (file.endsWith(".json")) await copyFile(resolve(from, file), resolve(to, file));
	}
}
