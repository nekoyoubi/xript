import { resolve } from "node:path";
import { generateDocsFromFile, writeDocsToDirectory, type DocgenOptions } from "@xriptjs/docgen";

export async function run(args: string[]): Promise<void> {
	if (args.includes("--help") || args.includes("-h")) {
		printHelp();
		process.exit(0);
	}

	const outputIndex = args.findIndex((a) => a === "--output" || a === "-o");
	let outputDir: string | undefined;

	if (outputIndex !== -1) {
		outputDir = args[outputIndex + 1];
		if (!outputDir) {
			console.error("Error: --output requires a directory path.");
			process.exit(1);
		}
	} else {
		console.error("Error: --output is required.");
		process.exit(1);
	}

	const linkFormatIndex = args.findIndex((a) => a === "--link-format");
	let linkFormat: string | undefined;
	if (linkFormatIndex !== -1) {
		linkFormat = args[linkFormatIndex + 1];
	}

	const frontmatterIndex = args.findIndex((a) => a === "--frontmatter");
	let frontmatter: string | undefined;
	if (frontmatterIndex !== -1) {
		frontmatter = args[frontmatterIndex + 1];
	}

	const flagIndices = new Set<number>();
	for (const flag of ["--output", "-o", "--link-format", "--frontmatter"]) {
		const idx = args.indexOf(flag);
		if (idx !== -1) {
			flagIndices.add(idx);
			flagIndices.add(idx + 1);
		}
	}
	const positional = args.filter((a, i) => !a.startsWith("-") && !flagIndices.has(i));
	const manifestPath = positional[0];

	if (!manifestPath) {
		console.error("Error: manifest file path is required.");
		process.exit(1);
	}

	try {
		const opts: DocgenOptions = {};
		if (linkFormat === "no-extension") opts.linkFormat = "no-extension";
		if (frontmatter) opts.frontmatter = frontmatter;
		const result = await generateDocsFromFile(manifestPath, opts);
		const written = await writeDocsToDirectory(result, outputDir!, opts);
		console.log(`\u2713 Generated ${written.length} documentation pages to ${resolve(outputDir!)}`);
		for (const path of written) {
			console.log(`  ${path}`);
		}
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		console.error(`Error: ${message}`);
		process.exit(1);
	}
}

function printHelp(): void {
	console.log("Usage: xript docgen <manifest.json> --output <directory>");
	console.log("");
	console.log("Generate markdown documentation from an xript manifest.");
	console.log("");
	console.log("Options:");
	console.log("  --output, -o       Output directory (required)");
	console.log("  --link-format <f>  Link format: 'default' or 'no-extension'");
	console.log("  --frontmatter <s>  YAML frontmatter to inject into generated files");
	console.log("  --help, -h         Show this help message");
}
