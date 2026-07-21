import { loadGuidanceIndex, loadGuidanceTopic } from "../guide.js";

export async function run(args: string[]): Promise<void> {
	if (args.includes("--help") || args.includes("-h")) {
		await printHelp();
		process.exit(0);
	}

	const topic = args.find((arg) => !arg.startsWith("-"));
	const topics = await loadGuidanceIndex();

	if (!topic) {
		console.log("xript authoring doctrine — topics:\n");
		for (const entry of topics) {
			console.log(`  ${entry.id.padEnd(18)} ${entry.summary}`);
		}
		console.log("\nRead one with: xript guide <topic>");
		process.exit(0);
	}

	const loaded = await loadGuidanceTopic(topic);
	if (!loaded) {
		console.error(`Unknown topic "${topic}". Available: ${topics.map((entry) => entry.id).join(", ")}`);
		process.exit(1);
	}

	console.log(loaded.body);
}

async function printHelp(): Promise<void> {
	const topics = await loadGuidanceIndex();
	console.log("xript guide [topic] — print xript authoring doctrine");
	console.log("");
	console.log("Run without a topic to list available topics.");
	console.log(`Topics: ${topics.map((entry) => entry.id).join(", ")}`);
}
