import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { validateFragment, sanitizeHTML } from "@xriptjs/sanitize";

export async function run(args: string[]): Promise<void> {
	if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
		printHelp();
		process.exit(args.length === 0 ? 1 : 0);
	}

	const filePath = resolve(args.find((a) => !a.startsWith("-"))!);
	const validate = args.includes("--validate");
	const quiet = args.includes("--quiet");

	try {
		const input = await readFile(filePath, "utf-8");

		if (validate) {
			const result = validateFragment(input, "text/html", null, null);
			if (result.valid) {
				console.log("Fragment is clean — nothing was stripped.");
			} else {
				console.log(`Fragment has ${result.errors.length} issue(s):\n`);
				for (const error of result.errors) {
					console.log(`  - ${error.message}`);
				}
			}
			console.log("\nSanitized output:\n");
			console.log(result.sanitized);
			process.exit(result.valid ? 0 : 1);
		}

		const output = sanitizeHTML(input);

		// `--quiet` promised "no diagnostics", which meant the default promised diagnostics and
		// printed none: sanitizing stripped a script tag and said nothing. A silent drop is the
		// failure mode this whole contract exists to end, so the default now reports what it
		// removed — on stderr, so `xript sanitize f.html > out.html` still yields only markup.
		if (!quiet) {
			const report = validateFragment(input, "text/html", null, null);
			for (const error of report.errors) console.error(`  - ${error.message}`);
			if (report.errors.length > 0) {
				console.error(`sanitize: removed ${report.errors.length} item(s); pass --quiet to silence this.`);
			}
		}

		if (quiet) {
			process.stdout.write(output);
		} else {
			console.log(output);
		}
	} catch (err) {
		console.error(`Error: ${err instanceof Error ? err.message : err}`);
		process.exit(1);
	}
}

function printHelp(): void {
	console.log("Usage: xript sanitize <fragment.html> [--validate] [--quiet]");
	console.log("");
	console.log("Sanitize HTML fragments for use in xript UI slots.");
	console.log("");
	console.log("Options:");
	console.log("  --validate  Show validation report and sanitized output");
	console.log("  --quiet     Output sanitized HTML only (no diagnostics)");
	console.log("  --help, -h  Show this help message");
}
