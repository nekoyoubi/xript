import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { lintManifests, resolveProvenance, type LintResult, type Severity } from "@xriptjs/validate";

export async function run(args: string[]): Promise<void> {
	if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
		printHelp();
		process.exit(args.length === 0 ? 1 : 0);
	}

	const asJson = args.includes("--json");
	const strict = args.includes("--strict");
	const paths = args.filter((arg) => !arg.startsWith("-"));
	const [hostPath, ...modPaths] = paths;

	if (!hostPath) {
		console.error("Usage: xript lint <host-manifest> [mod-manifest...] [--strict] [--json]");
		process.exit(1);
	}

	try {
		const hostAbs = resolve(hostPath);
		const host = JSON.parse(await readFile(hostAbs, "utf-8"));
		const mods = await Promise.all(modPaths.map(async (path) => JSON.parse(await readFile(resolve(path), "utf-8"))));
		const { resolved, inheritedSlots, inheritedCapabilities, inheritedAbstractTypes } = await resolveProvenance(host, dirname(hostAbs));
		const result = lintManifests(resolved, mods, { strict, inheritedSlots, inheritedCapabilities, inheritedAbstractTypes });

		if (asJson) {
			console.log(JSON.stringify(result, null, 2));
		} else {
			printReport(result);
		}

		const failed = result.counts.error > 0 || (strict && result.counts.warn > 0);
		process.exit(failed ? 1 : 0);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}

const MARK: Record<Severity, string> = { error: "✗", warn: "!", info: "·" };

function printReport(result: LintResult): void {
	if (result.findings.length === 0) {
		console.log("no findings — the supplied manifests line up cleanly");
		return;
	}

	for (const severity of ["error", "warn", "info"] as Severity[]) {
		const group = result.findings.filter((finding) => finding.severity === severity);
		if (group.length === 0) continue;
		console.log(`${severity} (${group.length})`);
		for (const finding of group) {
			console.log(`  ${MARK[severity]} [${finding.code}] ${finding.message}`);
			console.log(`      → ${finding.suggestion}`);
		}
		console.log("");
	}

	console.log(`${result.counts.error} error(s), ${result.counts.warn} warning(s), ${result.counts.info} note(s)`);
}

function printHelp(): void {
	console.log("xript lint <host-manifest> [mod-manifest...] [options] — review a host/mod fit for actionable findings");
	console.log("");
	console.log("Emits grouped findings over the manifest surface: filled-but-undeclared slots, undeclared and vestigial");
	console.log("capabilities, dead slots, ungated slots, and missing descriptions. The complement to `xript score`.");
	console.log("");
	console.log("Options:");
	console.log("  --strict   Exit non-zero on any warning, not just errors");
	console.log("  --json     Emit the full result as JSON");
}
