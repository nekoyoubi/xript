import { resolveTargetVersion } from "@xriptjs/validate";
import { loadGuidanceIndex, loadGuidanceTopic } from "../guide.js";
import { takeSpecFlag } from "../spec-version.js";

export async function run(rawArgs: string[]): Promise<void> {
	if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
		await printHelp();
		process.exit(0);
	}
	const spec = takeSpecFlag(rawArgs);
	if (spec.missing) {
		console.error("Error: --spec requires a manifest version, e.g. --spec 0.8");
		process.exit(1);
	}
	const args = spec.rest;
	let version: string | undefined;
	try {
		version = spec.version !== undefined ? resolveTargetVersion({}, spec.version).version : undefined;
	} catch (error) {
		console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}

	const topic = args.find((arg) => !arg.startsWith("-"));
	const topics = await loadGuidanceIndex();

	if (!topic) {
		console.log("xript authoring doctrine, topics:\n");
		for (const entry of topics) {
			console.log(`  ${entry.id.padEnd(18)} ${entry.summary}`);
		}
		console.log("\nRead one with: xript guide <topic>");
		process.exit(0);
	}

	const loaded = await loadGuidanceTopic(topic, version);
	if (!loaded) {
		console.error(`Unknown topic "${topic}". Available: ${topics.map((entry) => entry.id).join(", ")}`);
		process.exit(1);
	}

	console.log(loaded.body);
}

async function printHelp(): Promise<void> {
	const topics = await loadGuidanceIndex();
	console.log("xript guide [topic] [--spec <version>]: print xript authoring doctrine");
	console.log("");
	console.log("Run without a topic to list available topics. With --spec, a topic whose doctrine changed");
	console.log("across manifest versions leads with the note for that version (0.6, 0.7, 0.8, 0.9).");
	console.log(`Topics: ${topics.map((entry) => entry.id).join(", ")}`);
}
