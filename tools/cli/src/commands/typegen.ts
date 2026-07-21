import { readFile, writeFile } from "node:fs/promises";
import { resolve, basename, dirname } from "node:path";
import { generateTypesFromFile, resolveExtends } from "@xriptjs/typegen";

export async function run(args: string[]): Promise<void> {
	if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
		printHelp();
		process.exit(args.length === 0 ? 1 : 0);
	}

	const includeGrantShapes = args.includes("--include-grant-shapes");
	const ambient = args.includes("--ambient");
	const intent = args.includes("--intent");
	const hostIndex = args.indexOf("--host");
	const hostPath = hostIndex !== -1 ? args[hostIndex + 1] : undefined;
	if (hostIndex !== -1 && !hostPath) {
		console.error("Error: --host requires a manifest path.");
		process.exit(1);
	}
	const hostArgs = new Set(hostIndex === -1 ? [] : [hostIndex, hostIndex + 1]);
	const rest = args.filter((a, i) => a !== "--include-grant-shapes" && a !== "--ambient" && a !== "--intent" && !hostArgs.has(i));

	const outputIndex = rest.findIndex((a) => a === "--output" || a === "-o");
	let outputPath: string | undefined;
	let manifestPath: string;

	if (outputIndex !== -1) {
		outputPath = rest[outputIndex + 1];
		if (!outputPath) {
			console.error("Error: --output requires a file path.");
			process.exit(1);
		}
		const remaining = rest.filter((_, i) => i !== outputIndex && i !== outputIndex + 1);
		manifestPath = remaining[0];
	} else {
		manifestPath = rest.filter((a) => !a.startsWith("-"))[0];
	}

	if (!manifestPath) {
		console.error("Error: manifest file path is required.");
		process.exit(1);
	}

	try {
		const host = hostPath ? await loadManifest(hostPath) : undefined;
		const { content } = await generateTypesFromFile(manifestPath, {
			includeGrantShapes,
			ambient,
			intent,
			...(host !== undefined ? { host } : {}),
		});

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

async function loadManifest(path: string): Promise<unknown> {
	const absolute = resolve(path);
	return resolveExtends(JSON.parse(await readFile(absolute, "utf-8")), dirname(absolute));
}

function printHelp(): void {
	console.log("Usage: xript typegen <manifest.json> [--output <file.d.ts>]");
	console.log("");
	console.log("Generate TypeScript definitions from an xript manifest.");
	console.log("");
	console.log("Options:");
	console.log("  --output, -o            Output file path (default: stdout)");
	console.log("  --ambient               Emit an ambient .d.ts declaring the in-sandbox xript surface for mod authors");
	console.log("  --intent                Emit the execution routing table a host routes on (implied by --ambient)");
	console.log("  --host <manifest.json>  For a mod manifest: the host it fills, so slot kinds (commands) are exact");
	console.log("  --include-grant-shapes  Emit CapabilityPrompt, InstallDescriptor, DiscoveryResult interfaces");
	console.log("  --help, -h              Show this help message");
}
