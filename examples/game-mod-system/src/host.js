const gameState = {
	player: {
		name: "Adventurer",
		health: 80,
		maxHealth: 100,
		position: { x: 3, y: 7 },
		inventory: [
			{ id: "sword-1", name: "Iron Sword", type: "weapon", damage: 15 },
			{ id: "potion-1", name: "Health Potion", type: "consumable", healing: 25 },
		],
	},
	world: {
		currentLevel: 3,
		enemies: [
			{ id: "e1", type: "skeleton", health: 30, position: { x: 5, y: 7 } },
			{ id: "e2", type: "goblin", health: 20, position: { x: 8, y: 3 } },
			{ id: "e3", type: "slime", health: 10, position: { x: 1, y: 9 } },
		],
	},
	storage: new Map(),
};

let nextEnemyId = 4;

export function createHostBindings() {
	return {
		log: (message) => console.log(`  [mod] ${message}`),
		player: {
			getName: () => gameState.player.name,
			getHealth: () => gameState.player.health,
			getMaxHealth: () => gameState.player.maxHealth,
			getPosition: () => ({ ...gameState.player.position }),
			setHealth: (value) => {
				gameState.player.health = Math.max(0, Math.min(value, gameState.player.maxHealth));
				return gameState.player.health;
			},
			getInventory: () => gameState.player.inventory.map((i) => ({ ...i })),
			addItem: (item) => {
				gameState.player.inventory.push({ ...item });
			},
		},
		world: {
			getCurrentLevel: () => gameState.world.currentLevel,
			getEnemies: async () => {
				await delay(10);
				return gameState.world.enemies.map((e) => ({ ...e, position: { ...e.position } }));
			},
			spawnEnemy: (type, position) => {
				const enemy = { id: `e${nextEnemyId++}`, type, health: 50, position: { ...position } };
				gameState.world.enemies.push(enemy);
				return enemy;
			},
		},
		data: {
			get: async (key) => {
				await delay(5);
				return gameState.storage.get(key) ?? undefined;
			},
			set: async (key, value) => {
				await delay(5);
				gameState.storage.set(key, value);
			},
		},
	};
}

export function getGameState() {
	return gameState;
}

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
