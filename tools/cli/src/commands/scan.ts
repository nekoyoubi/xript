export async function run(args: string[]): Promise<void> {
	if (args.includes("--help") || args.includes("-h")) {
		printHelp();
		process.exit(0);
	}

	let tsMorph;
	try {
		tsMorph = await import("ts-morph");
	} catch {
		console.error("The scan command requires ts-morph.");
		console.error("");
		console.error("Install it with:");
		console.error("  npm install ts-morph");
		process.exit(1);
	}

	const { scanDirectory, mergeIntoManifest } = await import("../scan/index.js");

	const manifestIndex = args.findIndex((a) => a === "--manifest" || a === "-m");
	const outputIndex = args.findIndex((a) => a === "--output" || a === "-o");
	const write = args.includes("--write");

	let manifestPath: string | undefined;
	let outputPath: string | undefined;

	if (manifestIndex !== -1) manifestPath = args[manifestIndex + 1];
	if (outputIndex !== -1) outputPath = args[outputIndex + 1];

	const flagIndices = new Set<number>();
	for (const flag of ["--manifest", "-m", "--output", "-o"]) {
		const idx = args.indexOf(flag);
		if (idx !== -1) {
			flagIndices.add(idx);
			flagIndices.add(idx + 1);
		}
	}
	const positional = args.filter((a, i) => !a.startsWith("-") && !flagIndices.has(i));
	const sourceDir = positional[0];

	if (!sourceDir) {
		console.error("Error: source directory is required.");
		console.error("");
		printHelp();
		process.exit(1);
	}

	try {
		const result = await scanDirectory(sourceDir);

		if (result.diagnostics.length > 0) {
			for (const diag of result.diagnostics) {
				const prefix = diag.severity === "error" ? "\x1b[31m\u2717\x1b[0m" : "\x1b[33m!\x1b[0m";
				console.error(`${prefix} ${diag.file}:${diag.line} ${diag.message}`);
			}
			console.error("");
		}

		if (manifestPath) {
			const { readFile, writeFile } = await import("node:fs/promises");
			const { resolve } = await import("node:path");
			const absManifest = resolve(manifestPath);
			const raw = await readFile(absManifest, "utf-8");
			const existing = JSON.parse(raw);
			const merged = await mergeIntoManifest(existing, result);

			if (merged.added.length > 0) {
				console.log(`Added ${merged.added.length} binding(s): ${merged.added.join(", ")}`);
			}
			if (merged.removed.length > 0) {
				console.log(`\x1b[33m!\x1b[0m ${merged.removed.length} binding(s) in manifest but not in source: ${merged.removed.join(", ")}`);
			}
			if (merged.capabilityGaps.length > 0) {
				console.log(`\x1b[33m!\x1b[0m ${merged.capabilityGaps.length} capability gap(s): ${merged.capabilityGaps.join(", ")}`);
			}

			if (write) {
				await writeFile(absManifest, JSON.stringify(merged.manifest, null, "\t") + "\n", "utf-8");
				console.log(`\x1b[32m\u2713\x1b[0m Updated ${absManifest}`);
			} else {
				console.log("");
				console.log(JSON.stringify(merged.manifest, null, "\t"));
			}
		} else if (outputPath) {
			const { writeFile } = await import("node:fs/promises");
			const { resolve } = await import("node:path");
			const output = { bindings: result.bindings, capabilities: result.capabilities };
			await writeFile(resolve(outputPath), JSON.stringify(output, null, "\t") + "\n", "utf-8");
			console.log(`\x1b[32m\u2713\x1b[0m Wrote ${outputPath}`);
		} else {
			const output = { bindings: result.bindings, capabilities: result.capabilities };
			process.stdout.write(JSON.stringify(output, null, "\t") + "\n");
		}
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		console.error(`Error: ${message}`);
		process.exit(1);
	}
}

function printHelp(): void {
	console.log("Usage: xript scan <directory> [options]");
	console.log("");
	console.log("Scan TypeScript source files for @xript JSDoc annotations and");
	console.log("generate manifest bindings and capabilities.");
	console.log("");
	console.log("Options:");
	console.log("  --manifest, -m <file>  Merge scanned bindings into an existing manifest");
	console.log("  --output, -o <file>    Write scanned bindings to a file");
	console.log("  --write                Write merged manifest back to disk (requires --manifest)");
	console.log("  --help, -h             Show this help message");
	console.log("");
	console.log("Examples:");
	console.log("  xript scan src/                              # output to stdout");
	console.log("  xript scan src/ -o bindings.json             # write to file");
	console.log("  xript scan src/ -m manifest.json             # preview merge");
	console.log("  xript scan src/ -m manifest.json --write     # merge and save");
}
