#!/usr/bin/env node

import { resolve } from "node:path";
import { generateDocsFromFile, writeDocsToDirectory } from "./index.js";

const args = process.argv.slice(2);

if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
	console.log("Usage: xript-docgen <manifest.json> --output <directory>");
	console.log("");
	console.log("Generate markdown documentation from an xript manifest.");
	console.log("");
	console.log("Options:");
	console.log("  --output, -o  Output directory (required)");
	console.log("  --help, -h    Show this help message");
	process.exit(args.length === 0 ? 1 : 0);
}

const outputIndex = args.findIndex((a) => a === "--output" || a === "-o");
let outputDir: string | undefined;
let manifestPath: string;

if (outputIndex !== -1) {
	outputDir = args[outputIndex + 1];
	if (!outputDir) {
		console.error("Error: --output requires a directory path.");
		process.exit(1);
	}
	const remaining = args.filter((_, i) => i !== outputIndex && i !== outputIndex + 1);
	manifestPath = remaining[0];
} else {
	console.error("Error: --output is required.");
	process.exit(1);
}

if (!manifestPath) {
	console.error("Error: manifest file path is required.");
	process.exit(1);
}

try {
	const result = await generateDocsFromFile(manifestPath);
	const written = await writeDocsToDirectory(result, outputDir);
	console.log(`\u2713 Generated ${written.length} documentation pages to ${resolve(outputDir)}`);
	for (const path of written) {
		console.log(`  ${path}`);
	}
} catch (e) {
	const message = e instanceof Error ? e.message : String(e);
	console.error(`Error: ${message}`);
	process.exit(1);
}
