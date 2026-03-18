import { initXript } from "@xriptjs/runtime";
import { readFile } from "node:fs/promises";

const manifestRaw = await readFile(new URL("../manifest.json", import.meta.url), "utf-8");
const manifest = JSON.parse(manifestRaw);

const gameState = {
	player: {
		name: "Adventurer",
		health: 80,
		maxHealth: 100,
		inventory: [
			{ name: "Iron Sword", count: 1 },
			{ name: "Health Potion", count: 3 },
		],
	},
};

const hostBindings = {
	log: (message) => console.log(`[mod] ${message}`),
	player: {
		getName: () => gameState.player.name,
		getHealth: () => gameState.player.health,
		getMaxHealth: () => gameState.player.maxHealth,
		getInventory: () => gameState.player.inventory.map((i) => ({ ...i })),
	},
};

const xript = await initXript();

export function createRuntime(capabilities = []) {
	return xript.createRuntime(manifest, {
		hostBindings,
		capabilities,
		console: { log: console.log, warn: console.warn, error: console.error },
	});
}

export { gameState };
