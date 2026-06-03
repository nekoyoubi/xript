import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { scoreManifests, resolveProvenance, type ScoreResult } from "@xriptjs/validate";

export async function run(args: string[]): Promise<void> {
	if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
		printHelp();
		process.exit(args.length === 0 ? 1 : 0);
	}

	const asJson = args.includes("--json");
	const minIndex = args.indexOf("--min");
	const min = minIndex !== -1 ? Number(args[minIndex + 1]) : undefined;

	const skip = new Set<number>();
	if (minIndex !== -1) {
		skip.add(minIndex);
		skip.add(minIndex + 1);
	}
	const paths = args.filter((arg, i) => !arg.startsWith("-") && !skip.has(i));
	const [hostPath, ...modPaths] = paths;

	if (!hostPath) {
		console.error("Usage: xript score <host-manifest> [mod-manifest...] [--min N] [--json]");
		process.exit(1);
	}

	try {
		const hostAbs = resolve(hostPath);
		const host = JSON.parse(await readFile(hostAbs, "utf-8"));
		const mods = await Promise.all(modPaths.map(async (path) => JSON.parse(await readFile(resolve(path), "utf-8"))));
		const { resolved, inheritedSlots, inheritedCapabilities } = await resolveProvenance(host, dirname(hostAbs));
		const result = await scoreManifests(resolved, mods, { ...(min !== undefined ? { min } : {}), inheritedSlots, inheritedCapabilities });

		if (asJson) {
			console.log(JSON.stringify(result, null, 2));
		} else {
			printReport(result);
		}

		const failed = result.gate ? !result.gate.passed : !result.integrity.passed;
		process.exit(failed ? 1 : 0);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}

function bar(score: number): string {
	const filled = Math.round(score * 20);
	return `${"█".repeat(filled)}${"░".repeat(20 - filled)}`;
}

function printReport(result: ScoreResult): void {
	console.log(`moddability score: ${result.headline}/100`);
	console.log("");
	console.log(`  contract integrity   ${result.integrity.passed ? "pass" : `${result.integrity.violations.length} violation(s)`}`);
	for (const violation of result.integrity.violations) console.log(`    ✗ ${violation}`);
	console.log(`  capacity             ${bar(result.capacity.score)} ${Math.round(result.capacity.score * 100)}%`);
	console.log(`    exposed: ${result.capacity.exposed.join(", ") || "none"}`);
	if (result.capacity.absent.length) console.log(`    not exposed: ${result.capacity.absent.join(", ")}`);
	console.log("");
	console.log(`  mod coverage (informational — not part of the score)`);
	console.log(`    slots        ${bar(result.slots.score)} ${Math.round(result.slots.score * 100)}% of own non-reserved slots filled`);
	if (result.slots.unused.length) console.log(`      unfilled: ${result.slots.unused.join(", ")}`);
	console.log(`    capabilities ${bar(result.capabilities.score)} ${Math.round(result.capabilities.score * 100)}% of own non-reserved capabilities referenced`);
	if (result.capabilities.unused.length) console.log(`      unreferenced: ${result.capabilities.unused.join(", ")}`);
	if (result.gate) console.log(`\n  gate (--min ${result.gate.min}): ${result.gate.passed ? "pass" : "fail"}`);
	console.log(`\n${result.disclaimer}`);
}

function printHelp(): void {
	console.log("xript score <host-manifest> [mod-manifest...] [options] — score a host's moddability");
	console.log("");
	console.log("Headline is moddability capacity: how much of xript's extension surface the host exposes");
	console.log("(bindings, slots, events, a capability model), against a ceiling of exposing all of it.");
	console.log("Mod coverage (how much your supplied mods fill) is reported as informational context, not scored —");
	console.log("exposing a slot no mod fills is moddability, not waste. `extends` is resolved before scoring.");
	console.log("");
	console.log("Options:");
	console.log("  --min <n>   Exit non-zero if the headline is below n (or any integrity violation exists)");
	console.log("  --json      Emit the full result as JSON");
}
