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

/**
 * A coverage line. An empty surface scores 1 vacuously — nothing is uncovered — which is right
 * for a gate and reads as an achievement when drawn as a full bar and "100%". A host declaring
 * no slots at all was being told it had filled all of them.
 */
function coverage(metric: { score: number; total: number }, label: string, empty: string): string {
	if (metric.total === 0) return `${" ".repeat(20)} n/a — this host declares ${empty}`;
	return `${bar(metric.score)} ${Math.round(metric.score * 100)}% ${label}`;
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
	console.log(`    slots        ${coverage(result.slots, "of own non-reserved slots filled", "no slots of its own")}`);
	if (result.slots.unused.length) console.log(`      unfilled: ${result.slots.unused.join(", ")}`);
	console.log(
		`    capabilities ${coverage(result.capabilities, "of own non-reserved capabilities referenced", "no capabilities of its own")}`,
	);
	if (result.capabilities.unused.length) console.log(`      unreferenced: ${result.capabilities.unused.join(", ")}`);
	printCommandSurface(result);
	if (result.gate) console.log(`\n  gate (--min ${result.gate.min}): ${result.gate.passed ? "pass" : "fail"}`);
	console.log(`\n${result.disclaimer}`);
}

/**
 * Command slots, reported beside the headline rather than in it. A command slot is a slot, already
 * counted by the slot surface; counting it again would double-count and would move the denominator
 * of every host that shipped before the kind existed.
 */
function printCommandSurface(result: ScoreResult): void {
	const commands = result.commands;
	if (!commands || commands.slots.length === 0) return;
	console.log("");
	console.log(`  command slots (informational — a command slot is a slot, already counted)`);
	console.log(`    declared: ${commands.slots.join(", ")}`);
	if (commands.gated.length) console.log(`      gated: ${commands.gated.join(", ")}`);
	if (commands.constrained.length) console.log(`      payload-constrained: ${commands.constrained.join(", ")}`);
	if (commands.singular.length) console.log(`      singular (resolve to one command): ${commands.singular.join(", ")}`);
	if (commands.unreachable.length) console.log(`      unreachable: ${commands.unreachable.join(", ")}`);
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
