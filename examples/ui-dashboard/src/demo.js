import { createRuntime, gameState } from "./host.js";
import { readFile } from "node:fs/promises";

async function loadModFiles(modDir) {
	const manifestRaw = await readFile(new URL(`../mods/${modDir}/mod-manifest.json`, import.meta.url), "utf-8");
	const manifest = JSON.parse(manifestRaw);

	const sources = {};
	if (manifest.entry) {
		const entries = Array.isArray(manifest.entry) ? manifest.entry : [manifest.entry];
		for (const entry of entries) {
			sources[entry] = await readFile(new URL(`../mods/${modDir}/${entry}`, import.meta.url), "utf-8");
		}
	}
	if (manifest.fragments) {
		for (const frag of manifest.fragments) {
			if (!frag.inline) {
				sources[frag.source] = await readFile(new URL(`../mods/${modDir}/${frag.source}`, import.meta.url), "utf-8");
			}
		}
	}
	return { manifest, sources };
}

console.log("=== UI Dashboard Demo ===\n");

const runtime = createRuntime(["ui-mount"]);

const healthMod = await loadModFiles("health-panel");
const inventoryMod = await loadModFiles("inventory-panel");

console.log("Loading health-panel mod...");
const health = runtime.loadMod(healthMod.manifest, { fragmentSources: healthMod.sources });
console.log(`  Loaded: ${health.name} v${health.version} (${health.fragments.length} fragment(s))\n`);

console.log("Loading inventory-panel mod...");
const inventory = runtime.loadMod(inventoryMod.manifest, { fragmentSources: inventoryMod.sources });
console.log(`  Loaded: ${inventory.name} v${inventory.version} (${inventory.fragments.length} fragment(s))\n`);

function renderFrame(label) {
	console.log(`--- ${label} ---`);
	console.log(`  State: ${gameState.player.name} HP=${gameState.player.health}/${gameState.player.maxHealth}`);
	console.log(`  Items: ${gameState.player.inventory.map((i) => `${i.name}(x${i.count})`).join(", ")}\n`);

	const healthResult = health.updateBindings({
		player: {
			health: gameState.player.health,
			maxHealth: gameState.player.maxHealth,
			name: gameState.player.name,
		},
	});

	for (const result of healthResult) {
		console.log(`  [${result.fragmentId}] HTML:`);
		console.log(`    ${result.html.replace(/\n\t*/g, " ").trim()}`);
		if (Object.keys(result.visibility).length > 0) {
			console.log(`    Visibility: ${JSON.stringify(result.visibility)}`);
		}
	}

	const invResult = inventory.updateBindings({
		player: { name: gameState.player.name },
	});
	for (const result of invResult) {
		console.log(`  [${result.fragmentId}] HTML:`);
		console.log(`    ${result.html.replace(/\n\t*/g, " ").trim()}`);
	}

	const fragOps = runtime.fireFragmentHook("health-display", "update", {
		health: gameState.player.health,
		maxHealth: gameState.player.maxHealth,
	});
	if (fragOps.length > 0) {
		console.log(`  Fragment ops: ${JSON.stringify(fragOps)}`);
	}

	const invOps = runtime.fireFragmentHook("inventory-list", "update", {
		inventory: gameState.player.inventory,
	});
	if (invOps.length > 0) {
		console.log(`  Inventory ops: ${JSON.stringify(invOps)}`);
	}

	console.log("");
}

renderFrame("Full Health");

gameState.player.health = 40;
renderFrame("After Damage (40 HP)");

gameState.player.health = 15;
gameState.player.inventory.push({ name: "Magic Shield", count: 1 });
renderFrame("Critical Health (15 HP) + New Item");

console.log("=== Demo complete ===");

runtime.dispose();
