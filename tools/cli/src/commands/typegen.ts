import { writeFile } from "node:fs/promises";
import { resolve, basename } from "node:path";
import { generateTypesFromFile } from "@xriptjs/typegen";

export async function run(args: string[]): Promise<void> {
	if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
		printHelp();
		process.exit(args.length === 0 ? 1 : 0);
	}

	const outputIndex = args.findIndex((a) => a === "--output" || a === "-o");
	let outputPath: string | undefined;
	let manifestPath: string;

	if (outputIndex !== -1) {
		outputPath = args[outputIndex + 1];
		if (!outputPath) {
			console.error("Error: --output requires a file path.");
			process.exit(1);
		}
		const remaining = args.filter((_, i) => i !== outputIndex && i !== outputIndex + 1);
		manifestPath = remaining[0];
	} else {
		manifestPath = args.filter((a) => !a.startsWith("-"))[0];
	}

	if (!manifestPath) {
		console.error("Error: manifest file path is required.");
		process.exit(1);
	}

	try {
		const { content } = await generateTypesFromFile(manifestPath);

		if (outputPath) {
			const absoluteOutput = resolve(outputPath);
			await writeFile(absoluteOutput, content, "utf-8");
			const name = basename(absoluteOutput);
			console.log(`\u2713 Generated ${name}`);
		} else {
			process.stdout.write(content);
		}
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		console.error(`Error: ${message}`);
		process.exit(1);
	}
}

function printHelp(): void {
	console.log("Usage: xript typegen <manifest.json> [--output <file.d.ts>]");
	console.log("");
	console.log("Generate TypeScript definitions from an xript manifest.");
	console.log("");
	console.log("Options:");
	console.log("  --output, -o  Output file path (default: stdout)");
	console.log("  --help, -h    Show this help message");
}
