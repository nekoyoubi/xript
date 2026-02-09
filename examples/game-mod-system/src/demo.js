import { initXriptAsync } from "../../../runtimes/js/dist/index.js";
import { readFile } from "node:fs/promises";
import { createHostBindings, getGameState } from "./host.js";

const manifestRaw = await readFile(new URL("../manifest.json", import.meta.url), "utf-8");
const manifest = JSON.parse(manifestRaw);

const xript = await initXriptAsync();

async function runMod(name, code, capabilities) {
	console.log(`\n--- Mod: "${name}" (capabilities: [${capabilities.join(", ")}]) ---`);
	const runtime = await xript.createRuntime(manifest, {
		hostBindings: createHostBindings(),
		capabilities,
		console: {
			log: (...args) => console.log("  [console]", ...args),
			warn: (...args) => console.warn("  [console]", ...args),
			error: (...args) => console.error("  [console]", ...args),
		},
	});

	try {
		const result = await runtime.executeAsync(code);
		if (result.value !== undefined) {
			console.log(`  => ${JSON.stringify(result.value)}`);
		}
		console.log(`  (${result.duration_ms.toFixed(1)}ms)`);
	} catch (e) {
		console.log(`  => ERROR: ${e.message}`);
	}

	runtime.dispose();
}

console.log("=== xript Game Mod System Demo (Tier 3) ===");
console.log("A dungeon crawler with namespaces, capabilities, async bindings, and execution limits.\n");

const state = getGameState();
console.log(`Game state: ${state.player.name} on level ${state.world.currentLevel}`);
console.log(`  HP: ${state.player.health}/${state.player.maxHealth}`);
console.log(`  Position: (${state.player.position.x}, ${state.player.position.y})`);
console.log(`  Inventory: ${state.player.inventory.map((i) => i.name).join(", ")}`);
console.log(`  Enemies on level: ${state.world.enemies.length}`);

await runMod(
	"Healing Potion",
	`
		const hp = player.getHealth();
		const max = player.getMaxHealth();
		log("Current HP: " + hp + "/" + max);
		player.setHealth(max);
		log("Healed to full! HP: " + player.getHealth() + "/" + max);
		return player.getHealth();
	`,
	["modify-player"],
);

await runMod(
	"Enemy Scout",
	`
		const level = world.getCurrentLevel();
		const enemies = await world.getEnemies();
		log("Scouting level " + level + "...");
		log("Found " + enemies.length + " enemies:");
		for (const e of enemies) {
			log("  " + e.type + " (HP:" + e.health + ") at (" + e.position.x + "," + e.position.y + ")");
		}
		return enemies.length;
	`,
	[],
);

await runMod(
	"Inventory Manager",
	`
		const items = player.getInventory();
		log("Inventory (" + items.length + " items):");
		for (const item of items) {
			log("  " + item.name + " [" + item.type + "]");
		}
		player.addItem({ id: "key-1", name: "Dungeon Key", type: "key" });
		log("Added Dungeon Key to inventory");
		return player.getInventory().length;
	`,
	["modify-player"],
);

await runMod(
	"Save Checkpoint",
	`
		const hp = player.getHealth();
		const pos = player.getPosition();
		await data.set("checkpoint", hp + "|" + pos.x + "," + pos.y);
		log("Saved checkpoint: HP=" + hp + " at (" + pos.x + "," + pos.y + ")");
		return "saved";
	`,
	["storage"],
);

await runMod(
	"Load Checkpoint",
	`
		const saved = await data.get("checkpoint");
		log("Loaded checkpoint: " + saved);
		return saved;
	`,
	["storage"],
);

await runMod(
	"Unauthorized World Mod",
	`
		log("Attempting to spawn a dragon...");
		world.spawnEnemy("dragon", { x: 5, y: 5 });
	`,
	["modify-player"],
);

await runMod(
	"Authorized World Mod",
	`
		log("Spawning a dragon with modify-world capability...");
		world.spawnEnemy("dragon", { x: 5, y: 5 });
		log("Dragon spawned at (5, 5)!");
		return "spawned";
	`,
	["modify-player", "modify-world"],
);

await runMod(
	"Infinite Loop (hits timeout)",
	`
		log("Starting infinite loop...");
		while (true) {}
	`,
	[],
);

console.log("\n=== Demo complete ===");
