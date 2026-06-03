import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { scoreManifests, diffScores, resolveProvenance, type ScoreResult, type ScoreDiff, type MetricDiff } from "@xriptjs/validate";

export async function run(args: string[]): Promise<void> {
	if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
		printHelp();
		process.exit(args.length === 0 ? 1 : 0);
	}

	const asJson = args.includes("--json");
	const minIndex = args.indexOf("--min-delta");
	const minDelta = minIndex !== -1 ? Number(args[minIndex + 1]) : undefined;

	const skip = new Set<number>();
	if (minIndex !== -1) {
		skip.add(minIndex);
		skip.add(minIndex + 1);
	}
	const paths = args.filter((arg, i) => !arg.startsWith("-") && !skip.has(i));
	const [baselinePath, hostPath, ...modPaths] = paths;

	if (!baselinePath || !hostPath) {
		console.error("Usage: xript score-diff <baseline.json> <host-manifest> [mod-manifest...] [--min-delta N] [--json]");
		process.exit(1);
	}

	try {
		const baseline = JSON.parse(await readFile(resolve(baselinePath), "utf-8")) as ScoreResult;
		const hostAbs = resolve(hostPath);
		const host = JSON.parse(await readFile(hostAbs, "utf-8"));
		const mods = await Promise.all(modPaths.map(async (path) => JSON.parse(await readFile(resolve(path), "utf-8"))));
		const { resolved, inheritedSlots, inheritedCapabilities } = await resolveProvenance(host, dirname(hostAbs));
		const current = await scoreManifests(resolved, mods, { inheritedSlots, inheritedCapabilities });
		const diff = diffScores(baseline, current, minDelta !== undefined ? { minDelta } : {});

		if (asJson) console.log(JSON.stringify(diff, null, 2));
		else printDiff(diff);

		process.exit(diff.gate && !diff.gate.passed ? 1 : 0);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}

function signed(n: number): string {
	return n >= 0 ? `+${n}` : `${n}`;
}

function printMetric(label: string, metric: MetricDiff, gainedLabel: string, lostLabel: string): void {
	console.log(`  ${label.padEnd(16)} ${Math.round(metric.baseline * 100)}% → ${Math.round(metric.current * 100)}% (${signed(metric.delta)})`);
	if (metric.gained.length) console.log(`    ${gainedLabel}: ${metric.gained.join(", ")}`);
	if (metric.lost.length) console.log(`    ${lostLabel}: ${metric.lost.join(", ")}`);
}

function printDiff(diff: ScoreDiff): void {
	const arrow = diff.direction === "improved" ? "▲" : diff.direction === "regressed" ? "▼" : "—";
	console.log(`moddability ${diff.direction} ${arrow}  ${diff.headline.baseline} → ${diff.headline.current} (${signed(diff.headline.delta)})`);
	console.log("");
	if (diff.integrity.introduced.length) {
		console.log(`  contract regressed — ${diff.integrity.introduced.length} new violation(s):`);
		for (const v of diff.integrity.introduced) console.log(`    ✗ ${v}`);
	}
	if (diff.integrity.fixed.length) console.log(`  contract improved — ${diff.integrity.fixed.length} violation(s) fixed`);
	printMetric("capacity", diff.capacity, "newly exposed", "newly absent");
	console.log("  mod coverage (informational):");
	printMetric("  slots", diff.slots, "newly filled", "newly unfilled");
	printMetric("  capabilities", diff.capabilities, "newly used", "newly unreferenced");
	if (diff.gate) console.log(`\n  gate (--min-delta ${diff.gate.minDelta}): ${diff.gate.passed ? "pass" : "fail"}`);
}

function printHelp(): void {
	console.log("xript score-diff <baseline.json> <host-manifest> [mod-manifest...] [options] — compare against a saved score");
	console.log("");
	console.log("Computes the current extensibility score and diffs it against a baseline (a saved `xript score --json`),");
	console.log("reporting whether the codebase moved toward or away from xript.");
	console.log("");
	console.log("Produce a baseline with:  xript score host.json mods/*.json --json > baseline.json");
	console.log("");
	console.log("Options:");
	console.log("  --min-delta <n>   Gate: exit non-zero if the headline fell by more than n, or any new integrity violation appeared");
	console.log("  --json            Emit the full diff as JSON");
}
