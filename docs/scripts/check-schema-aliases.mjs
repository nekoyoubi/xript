import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkSchemaAliases } from "./schema-aliases.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const schemaTarget = join(here, "..", "public", "schema");
const repoRoot = join(here, "..", "..");

const { checked, mismatches, missing, mutated, tagsAvailable } = await checkSchemaAliases({ schemaTarget, repoRoot });

if (checked === 0) {
	console.error("check-schema-aliases: no emitted schemas found - run the docs sync first");
	process.exit(1);
}

const failures = [...mismatches, ...missing, ...(mutated ?? [])];
if (failures.length > 0) {
	console.error("check-schema-aliases: released schema URLs are not being served faithfully");
	for (const failure of failures) console.error(`  ${failure}`);
	process.exit(1);
}

const coverage = tagsAvailable
	? "every version a release tag published is still emitted with the content it shipped"
	: "no release tags reachable, skipped the published-version coverage check";
console.log(`check-schema-aliases: ${checked} emitted schemas each match their own $id; ${coverage}`);
