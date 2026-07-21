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
		const baseline = await readBaseline(baselinePath);
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

const BASELINE_HINT = "Produce one with:  xript score <host-manifest> [mods...] --json > baseline.json";

/**
 * The baseline is a saved `xript score --json`, and the easy mistake is handing it the host
 * manifest that produced the score. That used to reach `diffScores` and die on a raw
 * `Cannot read properties of undefined (reading 'violations')`, so every failure here names the
 * problem and points at the command that makes a real baseline.
 */
async function readBaseline(path: string): Promise<ScoreResult> {
	let raw: string;
	try {
		raw = await readFile(resolve(path), "utf-8");
	} catch {
		throw new Error(`The baseline '${path}' could not be read.\n${BASELINE_HINT}`);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`The baseline '${path}' is not valid JSON: ${detail}\n${BASELINE_HINT}`);
	}

	if (!isScoreResult(parsed)) {
		const looksLikeManifest = typeof parsed === "object" && parsed !== null && "xript" in parsed;
		const because = looksLikeManifest ? " — it looks like a manifest" : "";
		throw new Error(`The baseline '${path}' is not a saved score${because}.\n${BASELINE_HINT}`);
	}
	return parsed;
}

function isScoreResult(value: unknown): value is ScoreResult {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<ScoreResult>;
	return (
		typeof candidate.headline === "number" &&
		typeof candidate.integrity === "object" &&
		candidate.integrity !== null &&
		Array.isArray((candidate.integrity as { violations?: unknown }).violations) &&
		typeof candidate.capacity === "object" &&
		candidate.capacity !== null
	);
}

function signed(n: number): string {
	return n >= 0 ? `+${n}` : `${n}`;
}

function printMetric(label: string, metric: MetricDiff, gainedLabel: string, lostLabel: string): void {
	// An empty surface scores 1 vacuously, so deleting the only slot rendered `0% → 100% (+1)`:
	// a regression reading as an improvement. Show `n/a` for a side that had nothing to cover.
	const side = (score: number, total: number | undefined): string => (total === 0 ? "n/a" : `${Math.round(score * 100)}%`);
	const from = side(metric.baseline, metric.baselineTotal);
	const to = side(metric.current, metric.currentTotal);
	const movement = from === "n/a" || to === "n/a" ? "" : ` (${signed(metric.delta)})`;
	console.log(`  ${label.padEnd(16)} ${from} → ${to}${movement}`);
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
	printCommandDiff(diff);
	if (diff.gate) console.log(`\n  gate (--min-delta ${diff.gate.minDelta}): ${diff.gate.passed ? "pass" : "fail"}`);
}

/**
 * Command-slot movement. A gained or lost slot already moved the slot metric; the rows worth
 * reading are the two that weaken a surface without moving the score — a slot that stopped being
 * gated, and one that lost its `multiple` and now resolves to a single command.
 */
function printCommandDiff(diff: ScoreDiff): void {
	const commands = diff.commands;
	if (!commands) return;
	const rows: Array<[string, string[]]> = [
		["gained", commands.gained],
		["lost", commands.lost],
		["newly ungated", commands.ungated],
		["narrowed to one command", commands.narrowed],
	];
	if (rows.every(([, ids]) => ids.length === 0)) return;
	console.log("  command slots:");
	for (const [label, ids] of rows) {
		if (ids.length) console.log(`    ${label}: ${ids.join(", ")}`);
	}
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
