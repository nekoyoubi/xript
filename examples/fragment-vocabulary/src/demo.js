import { createRuntime } from "./host.js";
import { readFile } from "node:fs/promises";

const modManifest = JSON.parse(
	await readFile(new URL("../mods/status-panel/mod-manifest.json", import.meta.url), "utf-8"),
);

const fragmentSources = {};
for (const fills of Object.values(modManifest.fills ?? {})) {
	for (const fill of fills) {
		if (fill.source && !fill.inline) {
			fragmentSources[fill.source] = await readFile(
				new URL(`../mods/status-panel/${fill.source}`, import.meta.url),
				"utf-8",
			);
		}
	}
}

console.log("=== Fragment Vocabulary Demo ===\n");
console.log("The host declares a Panel/Link/Progress vocabulary; the mod authors a typed");
console.log("node tree, not HTML. The runtime resolves it against the vocabulary, keeping");
console.log("node names and prop types intact.\n");

const runtime = createRuntime(["ui-mount"]);
const mod = runtime.loadMod(modManifest, { fragmentSources });
console.log(`Loaded ${mod.name} v${mod.version} -- ${mod.fragments.length} fragment(s)\n`);

function printNode(node, depth) {
	const pad = "  ".repeat(depth);
	if (typeof node === "string") {
		console.log(`${pad}"${node}"`);
		return;
	}
	if (node.kind === "text" || (node.value !== undefined && node.name === undefined)) {
		console.log(`${pad}"${node.value}"`);
		return;
	}
	const props = Object.entries(node.props ?? {})
		.map(([key, value]) => `${key}=${JSON.stringify(value)}`)
		.join(" ");
	console.log(`${pad}<${node.name}>${props ? ` ${props}` : ""}`);
	for (const child of node.children ?? []) printNode(child, depth + 1);
}

for (const fragment of mod.fragments) {
	console.log(`Fragment "${fragment.id}" (contentType: ${fragment.contentType}):`);
	for (const node of fragment.sanitizedTree ?? []) printNode(node, 1);
	console.log("");
}

console.log("Run the toolchain against manifest.json to see the vocabulary as a contract:");
console.log("  npx xript validate manifest.json      # a misspelled node fails here");
console.log("  npx xript typegen  manifest.json       # types the node tree for a mod author");
console.log("  npx xript docgen   manifest.json -o .  # publishes the node table");

runtime.dispose();
