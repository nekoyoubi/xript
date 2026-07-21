import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { generateDocsFromFile, writeDocsToDirectory, resolveExtends, type DocgenOptions } from "@xriptjs/docgen";

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

	const hostIndex = args.indexOf("--host");
	const hostPath = hostIndex !== -1 ? args[hostIndex + 1] : undefined;
	if (hostIndex !== -1 && !hostPath) {
		console.error("Error: --host requires a manifest path.");
		process.exit(1);
	}

	const flagIndices = new Set<number>();
	for (const flag of ["--output", "-o", "--link-format", "--frontmatter", "--host"]) {
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
		if (args.includes("--grant-shapes")) opts.grantShapes = true;
		if (hostPath) {
			const absolute = resolve(hostPath);
			opts.host = await resolveExtends(JSON.parse(await readFile(absolute, "utf-8")), dirname(absolute));
		}
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
	console.log("  --grant-shapes     Emit a capability grant shapes reference page");
	console.log("  --host <manifest>  For a mod manifest: the host it fills, so command fills and their gates are exact");
	console.log("  --help, -h         Show this help message");
}
