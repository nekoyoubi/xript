import { mkdir, copyFile } from "node:fs/promises";
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
