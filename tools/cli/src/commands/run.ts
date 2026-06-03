import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runMod } from "../run.js";

export async function run(args: string[]): Promise<void> {
	if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
		printHelp();
		process.exit(args.length === 0 ? 1 : 0);
	}

	const positional = args.filter((arg, i) => !arg.startsWith("-") && !isFlagValue(args, i));
	const [modPath, sourcePath] = positional;
	if (!modPath || !sourcePath) {
		console.error("Usage: xript run <mod-manifest.json> <entry-script> [options]");
		process.exit(1);
	}

	const exportName = flagValue(args, "--export") ?? flagValue(args, "-e");
	const argsJson = flagValue(args, "--args");
	const appPath = flagValue(args, "--app");
	const caps = flagValue(args, "--cap");

	try {
		const modManifest = JSON.parse(await readFile(resolve(modPath), "utf-8"));
		const source = await readFile(resolve(sourcePath), "utf-8");
		const appManifest = appPath ? JSON.parse(await readFile(resolve(appPath), "utf-8")) : undefined;
		const capabilities = caps ? caps.split(",").map((cap) => cap.trim()).filter(Boolean) : undefined;
		const invoke = exportName ? { export: exportName, args: argsJson ? JSON.parse(argsJson) : [] } : undefined;

		const result = await runMod({ modManifest, source, appManifest, capabilities, invoke });
		console.log(JSON.stringify(result, null, 2));
		process.exit(result.loaded ? 0 : 1);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}

function flagValue(args: string[], flag: string): string | undefined {
	const index = args.indexOf(flag);
	return index !== -1 ? args[index + 1] : undefined;
}

function isFlagValue(args: string[], index: number): boolean {
	const prev = args[index - 1];
	return prev !== undefined && prev.startsWith("-");
}

function printHelp(): void {
	console.log("xript run <mod-manifest.json> <entry-script> [options] — run a mod in the sandbox");
	console.log("");
	console.log("Loads a mod into the QuickJS WASM sandbox and optionally invokes an export.");
	console.log("");
	console.log("Options:");
	console.log("  --export, -e <name>   Invoke an export after loading");
	console.log("  --args <json>         JSON array of arguments for the invoked export");
	console.log("  --app <manifest>      Host app manifest (a minimal host is used otherwise)");
	console.log("  --cap <c1,c2>         Comma-separated capabilities to grant");
}
