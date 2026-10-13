import { resolve, basename } from "node:path";
import { createInterface } from "node:readline/promises";
import { writeProject, type TemplateOptions } from "@xriptjs/init";
import { resolveTargetVersion } from "@xriptjs/validate";
import { takeSpecFlag } from "../spec-version.js";

export async function run(rawArgs: string[]): Promise<void> {
	if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
		printHelp();
		process.exit(0);
	}
	const spec = takeSpecFlag(rawArgs);
	if (spec.missing) {
		console.error("Error: --spec requires a manifest version, e.g. --spec 0.8");
		process.exit(1);
	}
	const args = spec.rest;
	let specVersion: string | undefined;
	try {
		specVersion = spec.version !== undefined ? resolveTargetVersion({}, spec.version).version : undefined;
	} catch (error) {
		console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}

	const skipPrompts = args.includes("--yes") || args.includes("-y");
	const isMod = args.includes("--mod");
	const tierFlag = args.find((_, i) => args[i - 1] === "--tier");
	const langFlag = args.includes("--typescript") ? "typescript"
		: args.includes("--javascript") ? "javascript"
		: undefined;

	const positional = args.filter((a, i) => {
		if (a.startsWith("-")) return false;
		if (args[i - 1] === "--tier") return false;
		return true;
	});
	const targetDir = positional[0] ? resolve(positional[0]) : process.cwd();

	try {
		const prompted = skipPrompts
			? resolveDefaults(targetDir, tierFlag, langFlag, isMod)
			: await promptUser(targetDir, tierFlag, langFlag, isMod);
		const options: TemplateOptions = specVersion !== undefined ? { ...prompted, specVersion } : prompted;

		const result = await writeProject(targetDir, options);

		console.log("");
		console.log(`\u2713 Created ${options.name} in ${result.directory}`);
		console.log("");
		for (const file of result.files) {
			console.log(`  ${file}`);
		}
		console.log("");
		console.log("Next steps:");
		console.log(`  cd ${basename(result.directory)}`);
		console.log("  npm install");
		console.log("  npm run demo");
		console.log("");
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		console.error(`Error: ${message}`);
		process.exit(1);
	}
}

function resolveDefaults(
	dir: string,
	tier?: string,
	lang?: string,
	mod?: boolean,
): TemplateOptions {
	return {
		name: basename(dir),
		tier: parseTier(tier) ?? 2,
		language: (lang as "typescript" | "javascript") ?? "typescript",
		type: mod ? "mod" : "app",
	};
}

async function promptUser(
	dir: string,
	tierOverride?: string,
	langOverride?: string,
	mod?: boolean,
): Promise<TemplateOptions> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });

	try {
		const defaultName = basename(dir);
		const nameInput = await rl.question(`Project name (${defaultName}): `);
		const name = nameInput.trim() || defaultName;

		let tier: 2 | 3 | 4;
		if (tierOverride) {
			tier = parseTier(tierOverride) ?? 2;
		} else {
			const tierInput = await rl.question("Tier: 2 (bindings), 3 (advanced scripting), or 4 (full feature)? (2): ");
			tier = parseTier(tierInput.trim()) ?? 2;
		}

		let language: "typescript" | "javascript";
		if (langOverride) {
			language = langOverride as "typescript" | "javascript";
		} else {
			const langInput = await rl.question("Language: ts or js? (ts): ");
			const normalized = langInput.trim().toLowerCase();
			language = (normalized === "js" || normalized === "javascript") ? "javascript" : "typescript";
		}

		return { name, tier, language, type: mod ? "mod" : "app" };
	} finally {
		rl.close();
	}
}

function parseTier(input?: string): 2 | 3 | 4 | undefined {
	if (!input) return undefined;
	const n = parseInt(input, 10);
	if (n === 4) return 4;
	if (n === 3) return 3;
	if (n === 2) return 2;
	return undefined;
}

function printHelp(): void {
	console.log("Usage: xript init [directory] [options]");
	console.log("");
	console.log("Scaffold a new xript app or mod project.");
	console.log("");
	console.log("Options:");
	console.log("  --yes, -y         Skip prompts, use opinionated defaults");
	console.log("  --mod             Generate a mod project instead of an app");
	console.log("  --tier <2|3|4>    Adoption tier (default: 2)");
	console.log("  --typescript      Generate TypeScript files (default)");
	console.log("  --javascript      Generate JavaScript files");
	console.log("  --spec <version>  Manifest version the scaffold declares (0.6, 0.7, 0.8, 0.9; default: this toolchain's)");
	console.log("  --help, -h        Show this help message");
}
