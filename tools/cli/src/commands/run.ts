import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { resolveExtends } from "@xriptjs/validate";
import { runMod } from "../run.js";
import { createHarnessSession, runSteps, loadStepsFile, type HarnessDescriptor } from "../harness.js";

const DEFAULT_APP_MANIFEST = { xript: "0.3", name: "harness-host" };

export async function run(args: string[]): Promise<void> {
	if (args.includes("--help") || args.includes("-h")) {
		printHelp();
		process.exit(0);
	}

	const harnessPath = flagValue(args, "--harness");
	const stepsPath = flagValue(args, "--steps");

	if (harnessPath || stepsPath) {
		await runHarnessed(args, harnessPath, stepsPath);
		return;
	}

	const positional = positionals(args);
	const [modPath, sourcePath] = positional;
	if (!modPath || !sourcePath) {
		printHelp();
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

async function runHarnessed(args: string[], harnessPath: string | undefined, stepsPath: string | undefined): Promise<void> {
	const appPath = flagValue(args, "--app");
	const caps = flagValue(args, "--cap");
	const exportName = flagValue(args, "--export") ?? flagValue(args, "-e");
	const argsJson = flagValue(args, "--args");
	const [modPath, sourcePath] = positionals(args);

	try {
		const appManifest = appPath
			? await resolveExtends(JSON.parse(await readFile(resolve(appPath), "utf-8")), dirname(resolve(appPath)))
			: DEFAULT_APP_MANIFEST;
		const harness: HarnessDescriptor = harnessPath ? JSON.parse(await readFile(resolve(harnessPath), "utf-8")) : {};
		if (caps) harness.capabilities = caps.split(",").map((cap) => cap.trim()).filter(Boolean);

		const session = await createHarnessSession({
			appManifest,
			harness,
			baseDir: harnessPath ? dirname(resolve(harnessPath)) : undefined,
		});
		const output: Record<string, unknown> = { summary: session.summary };
		let failed = false;

		try {
			if (modPath && sourcePath) {
				const modManifest = JSON.parse(await readFile(resolve(modPath), "utf-8"));
				const source = await readFile(resolve(sourcePath), "utf-8");
				output.mod = await session.loadMod(modManifest, source);
				if (exportName) {
					output.result = await session.invoke(exportName, argsJson ? JSON.parse(argsJson) : []);
				}
			}

			if (stepsPath) {
				const { steps, baseDir } = await loadStepsFile(stepsPath);
				const results = await runSteps(session, steps, { baseDir });
				output.steps = results;
				failed = results.some((step) => !step.ok);
			}

			output.journal = session.journal();
		} finally {
			session.dispose();
		}

		console.log(JSON.stringify(output, null, 2));
		process.exit(failed ? 1 : 0);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}

function positionals(args: string[]): string[] {
	return args.filter((arg, i) => !arg.startsWith("-") && !isFlagValue(args, i));
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
	console.log("xript run --app <host.json> --harness <harness.json> --steps <steps.json> — run a harnessed scenario");
	console.log("");
	console.log("Loads a mod into the QuickJS WASM sandbox and optionally invokes an export.");
	console.log("With --harness or --steps, the host's declared bindings are stubbed from the");
	console.log("harness descriptor (spec/harness.schema.json), every call is journaled, and the");
	console.log("steps file (spec/harness-steps.schema.json) drives the scenario. The exit code");
	console.log("fails if any step fails.");
	console.log("");
	console.log("Options:");
	console.log("  --export, -e <name>   Invoke an export after loading");
	console.log("  --args <json>         JSON array of arguments for the invoked export");
	console.log("  --app <manifest>      Host app manifest (a minimal host is used otherwise)");
	console.log("  --cap <c1,c2>         Comma-separated capabilities to grant");
	console.log("  --harness <file>      Harness descriptor: binding stubs + capability grants");
	console.log("  --steps <file>        Scenario steps to run against the harnessed session");
}
