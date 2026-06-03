import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
	validateManifestFile,
	crossValidate,
	validateManifest,
	validateModManifest,
	validateShape,
	type GrantShape,
} from "@xriptjs/validate";

const KNOWN_SHAPES = ["capability-prompt", "install-descriptor", "discovery-result", "debug-messages"];

export async function run(args: string[]): Promise<void> {
	const crossIndex = args.indexOf("--cross");
	const isCross = crossIndex !== -1;
	const skipFillPayloads = args.includes("--no-fill-payloads");
	const shapeIndex = args.indexOf("--shape");
	const shapeName = shapeIndex !== -1 ? args[shapeIndex + 1] : undefined;
	const files = shapeIndex !== -1
		? args.filter((a, i) => !a.startsWith("-") && i !== shapeIndex + 1)
		: args.filter((a) => !a.startsWith("-"));

	if (args.includes("--help") || args.includes("-h")) {
		printHelp();
		process.exit(0);
	}

	if (shapeIndex !== -1) {
		if (!shapeName || !KNOWN_SHAPES.includes(shapeName)) {
			console.error(`Usage: xript validate --shape <${KNOWN_SHAPES.join("|")}> <payload.json>`);
			process.exit(1);
		}
		if (files.length !== 1) {
			console.error("Usage: xript validate --shape <name> <payload.json>");
			process.exit(1);
		}
		let raw: string;
		try {
			raw = await readFile(resolve(files[0]), "utf-8");
		} catch {
			console.error(`\x1b[31m✗\x1b[0m could not read file: ${resolve(files[0])}`);
			process.exit(1);
		}
		let doc: unknown;
		try {
			doc = JSON.parse(raw!);
		} catch {
			console.error(`\x1b[31m✗\x1b[0m invalid JSON in ${resolve(files[0])}`);
			process.exit(1);
		}
		const result = await validateShape(shapeName as GrantShape, doc!);
		if (result.valid) {
			console.log(`\x1b[32m✓\x1b[0m ${resolve(files[0])} (${shapeName})`);
			process.exit(0);
		} else {
			console.error(`\x1b[31m✗\x1b[0m ${resolve(files[0])} (${shapeName})`);
			for (const error of result.errors) {
				console.error(`  ${error.path}: ${error.message}`);
			}
			process.exit(1);
		}
	}

	if (isCross) {
		if (files.length !== 2) {
			console.error("Usage: xript validate --cross <app-manifest.json> <mod-manifest.json>");
			process.exit(1);
		}

		const [appPath, modPath] = files;

		let appRaw: string;
		let modRaw: string;
		try {
			appRaw = await readFile(resolve(appPath), "utf-8");
		} catch {
			console.error(`\x1b[31m\u2717\x1b[0m could not read file: ${resolve(appPath)}`);
			process.exit(1);
		}
		try {
			modRaw = await readFile(resolve(modPath), "utf-8");
		} catch {
			console.error(`\x1b[31m\u2717\x1b[0m could not read file: ${resolve(modPath)}`);
			process.exit(1);
		}

		let appManifest: unknown;
		let modManifest: unknown;
		try {
			appManifest = JSON.parse(appRaw!);
		} catch {
			console.error(`\x1b[31m\u2717\x1b[0m invalid JSON in ${resolve(appPath)}`);
			process.exit(1);
		}
		try {
			modManifest = JSON.parse(modRaw!);
		} catch {
			console.error(`\x1b[31m\u2717\x1b[0m invalid JSON in ${resolve(modPath)}`);
			process.exit(1);
		}

		const appResult = await validateManifest(appManifest!);
		if (!appResult.valid) {
			console.error(`\x1b[31m\u2717\x1b[0m ${resolve(appPath)} (app manifest invalid)`);
			for (const error of appResult.errors) {
				console.error(`  ${error.path}: ${error.message}`);
			}
			process.exit(1);
		}

		const modResult = await validateModManifest(modManifest!);
		if (!modResult.valid) {
			console.error(`\x1b[31m\u2717\x1b[0m ${resolve(modPath)} (mod manifest invalid)`);
			for (const error of modResult.errors) {
				console.error(`  ${error.path}: ${error.message}`);
			}
			process.exit(1);
		}

		const crossResult = await crossValidate(appManifest!, modManifest!, { checkFillPayloads: !skipFillPayloads });
		if (crossResult.valid) {
			console.log(`\x1b[32m\u2713\x1b[0m cross-validation passed`);
		} else {
			console.error(`\x1b[31m\u2717\x1b[0m cross-validation failed`);
			for (const error of crossResult.errors) {
				console.error(`  ${error.path}: ${error.message}`);
			}
			process.exit(1);
		}
	} else {
		if (files.length === 0) {
			printHelp();
			process.exit(1);
		}

		let hasFailure = false;

		for (const file of files) {
			const result = await validateManifestFile(file);

			if (result.valid) {
				console.log(`\x1b[32m\u2713\x1b[0m ${result.filePath}`);
			} else {
				hasFailure = true;
				console.error(`\x1b[31m\u2717\x1b[0m ${result.filePath}`);
				for (const error of result.errors) {
					console.error(`  ${error.path}: ${error.message}`);
				}
			}
			for (const warning of result.warnings ?? []) {
				console.error(`\x1b[33m!\x1b[0m ${warning.path}: ${warning.message}`);
			}
		}

		process.exit(hasFailure ? 1 : 0);
	}
}

function printHelp(): void {
	console.log("Usage: xript validate <manifest.json> [manifest2.json ...]");
	console.log("       xript validate --cross <app-manifest.json> <mod-manifest.json>");
	console.log("");
	console.log("Validate xript manifests against the specification schema.");
	console.log("Auto-detects app vs mod manifests.");
	console.log("");
	console.log("Options:");
	console.log("  --cross           Cross-validate an app manifest against a mod manifest");
	console.log("  --no-fill-payloads  With --cross, skip validating fills against slot payload schemas");
	console.log("  --shape <name>    Validate a JSON payload against a grant/debug wire shape");
	console.log("                    (capability-prompt | install-descriptor | discovery-result | debug-messages)");
	console.log("  --help, -h        Show this help message");
}
