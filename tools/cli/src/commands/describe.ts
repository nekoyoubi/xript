import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describeManifest } from "../describe.js";
import { reportVersion, takeSpecFlag } from "../spec-version.js";

export async function run(rawArgs: string[]): Promise<void> {
	if (rawArgs.length === 0 || rawArgs.includes("--help") || rawArgs.includes("-h")) {
		printHelp();
		process.exit(rawArgs.length === 0 ? 1 : 0);
	}
	const spec = takeSpecFlag(rawArgs);
	if (spec.missing) {
		console.error("Error: --spec requires a manifest version, e.g. --spec 0.8");
		process.exit(1);
	}
	const args = spec.rest;

	const filePath = args.find((arg) => !arg.startsWith("-"));
	if (!filePath) {
		printHelp();
		process.exit(1);
	}

	const summaryOnly = args.includes("--summary");

	if (!(await reportVersion(filePath, spec.version))) process.exit(1);

	try {
		const raw = await readFile(resolve(filePath), "utf-8");
		const { summary, docs, footer } = describeManifest(JSON.parse(raw));
		console.log(JSON.stringify(summary, null, 2));
		if (!summaryOnly) {
			console.log("");
			console.log(docs);
		}
		if (footer) {
			console.log("");
			console.log(footer);
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}

function printHelp(): void {
	console.log("xript describe <manifest.json> — summarize a host's surface");
	console.log("");
	console.log("Lists the bindings, hooks, slots, and capabilities a host exposes,");
	console.log("then prints the generated documentation.");
	console.log("");
	console.log("Options:");
	console.log("  --summary   Print only the surface summary, not the docs");
	console.log("  --spec <v>  Check the manifest against this manifest version (0.6-0.9); defaults to its");
	console.log("              $schema, then its xript field");
}
