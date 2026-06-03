import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describeManifest } from "../describe.js";

export async function run(args: string[]): Promise<void> {
	if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
		printHelp();
		process.exit(args.length === 0 ? 1 : 0);
	}

	const filePath = args.find((arg) => !arg.startsWith("-"));
	if (!filePath) {
		printHelp();
		process.exit(1);
	}

	const summaryOnly = args.includes("--summary");

	try {
		const raw = await readFile(resolve(filePath), "utf-8");
		const { summary, docs } = describeManifest(JSON.parse(raw));
		console.log(JSON.stringify(summary, null, 2));
		if (!summaryOnly) {
			console.log("");
			console.log(docs);
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
}
