import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRuntimeFromFile } from "../dist/index.js";

function createDungeonCrawlerBindings() {
	const state = {
		player: {
			name: "Hero",
			health: 80,
			maxHealth: 100,
			position: { x: 5, y: 10 },
			inventory: [
				{ id: "sword-1", name: "Iron Sword", type: "weapon", damage: 15 },
				{ id: "potion-1", name: "Health Potion", type: "consumable", healing: 25 },
			],
		},
		level: 3,
		enemies: [
			{ id: "enemy-1", type: "skeleton", health: 30, position: { x: 7, y: 10 } },
			{ id: "enemy-2", type: "goblin", health: 20, position: { x: 3, y: 8 } },
		],
		storage: new Map(),
	};

	return {
		state,
		bindings: {
			log: (msg) => msg,
			player: {
				getName: () => state.player.name,
				getHealth: () => state.player.health,
				getMaxHealth: () => state.player.maxHealth,
				getPosition: () => ({ ...state.player.position }),
				setHealth: (value) => {
					state.player.health = Math.max(0, Math.min(value, state.player.maxHealth));
				},
				getInventory: () => state.player.inventory.map((i) => ({ ...i })),
				addItem: (item) => {
					state.player.inventory.push(item);
				},
			},
			world: {
				getCurrentLevel: () => state.level,
				getEnemies: async () => state.enemies.map((e) => ({ ...e, position: { ...e.position } })),
				spawnEnemy: (type, position) => {
					state.enemies.push({
						id: `enemy-${state.enemies.length + 1}`,
						type,
						health: 50,
						position: { ...position },
					});
				},
			},
			data: {
				get: async (key) => state.storage.get(key),
				set: async (key, value) => {
					state.storage.set(key, value);
				},
			},
		},
	};
}

describe("dungeon-crawler integration tests", () => {
	describe("with no capabilities", () => {
		it("can read player name", async () => {
			const { bindings } = createDungeonCrawlerBindings();
			const runtime = await createRuntimeFromFile("../../examples/game-mod-system.json", {
				hostBindings: bindings,
			});
			assert.equal(runtime.execute("player.getName()").value, "Hero");
		});

		it("can read player health", async () => {
			const { bindings } = createDungeonCrawlerBindings();
			const runtime = await createRuntimeFromFile("../../examples/game-mod-system.json", {
				hostBindings: bindings,
			});
			assert.equal(runtime.execute("player.getHealth()").value, 80);
			assert.equal(runtime.execute("player.getMaxHealth()").value, 100);
		});

		it("can read player position", async () => {
			const { bindings } = createDungeonCrawlerBindings();
			const runtime = await createRuntimeFromFile("../../examples/game-mod-system.json", {
				hostBindings: bindings,
			});
			const result = runtime.execute("player.getPosition()");
			assert.deepEqual(result.value, { x: 5, y: 10 });
		});

		it("can read player inventory", async () => {
			const { bindings } = createDungeonCrawlerBindings();
			const runtime = await createRuntimeFromFile("../../examples/game-mod-system.json", {
				hostBindings: bindings,
			});
			const result = runtime.execute("player.getInventory()");
			assert.equal(result.value.length, 2);
			assert.equal(result.value[0].name, "Iron Sword");
		});

		it("can read world level", async () => {
			const { bindings } = createDungeonCrawlerBindings();
			const runtime = await createRuntimeFromFile("../../examples/game-mod-system.json", {
				hostBindings: bindings,
			});
			assert.equal(runtime.execute("world.getCurrentLevel()").value, 3);
		});

		it("can call log", async () => {
			const { bindings } = createDungeonCrawlerBindings();
			const runtime = await createRuntimeFromFile("../../examples/game-mod-system.json", {
				hostBindings: bindings,
			});
			assert.equal(runtime.execute('log("hello")').value, "hello");
		});

		it("denies player.setHealth without modify-player", async () => {
			const { bindings } = createDungeonCrawlerBindings();
			const runtime = await createRuntimeFromFile("../../examples/game-mod-system.json", {
				hostBindings: bindings,
			});
			const result = runtime.execute(`
				let err; try { player.setHealth(100); } catch(e) { err = e; }
				err.name + "|" + err.capability;
			`);
			assert.equal(result.value, "CapabilityDeniedError|modify-player");
		});

		it("denies player.addItem without modify-player", async () => {
			const { bindings } = createDungeonCrawlerBindings();
			const runtime = await createRuntimeFromFile("../../examples/game-mod-system.json", {
				hostBindings: bindings,
			});
			const result = runtime.execute(`
				let err; try { player.addItem({ id: "x", name: "x", type: "key" }); } catch(e) { err = e; }
				err.name;
			`);
			assert.equal(result.value, "CapabilityDeniedError");
		});

		it("denies world.spawnEnemy without modify-world", async () => {
			const { bindings } = createDungeonCrawlerBindings();
			const runtime = await createRuntimeFromFile("../../examples/game-mod-system.json", {
				hostBindings: bindings,
			});
			const result = runtime.execute(`
				let err; try { world.spawnEnemy("dragon", { x: 0, y: 0 }); } catch(e) { err = e; }
				err.capability;
			`);
			assert.equal(result.value, "modify-world");
		});

		it("denies data.get and data.set without storage", async () => {
			const { bindings } = createDungeonCrawlerBindings();
			const runtime = await createRuntimeFromFile("../../examples/game-mod-system.json", {
				hostBindings: bindings,
			});
			const result = runtime.execute(`
				let errors = [];
				try { data.get("key"); } catch(e) { errors.push(e.capability); }
				try { data.set("key", "val"); } catch(e) { errors.push(e.capability); }
				errors.join(",");
			`);
			assert.equal(result.value, "storage,storage");
		});
	});

	describe("with modify-player capability", () => {
		it("can set player health", async () => {
			const { bindings, state } = createDungeonCrawlerBindings();
			const runtime = await createRuntimeFromFile("../../examples/game-mod-system.json", {
				hostBindings: bindings,
				capabilities: ["modify-player"],
			});
			runtime.execute("player.setHealth(50)");
			assert.equal(state.player.health, 50);
		});

		it("clamps health to valid range", async () => {
			const { bindings, state } = createDungeonCrawlerBindings();
			const runtime = await createRuntimeFromFile("../../examples/game-mod-system.json", {
				hostBindings: bindings,
				capabilities: ["modify-player"],
			});
			runtime.execute("player.setHealth(999)");
			assert.equal(state.player.health, 100);
			runtime.execute("player.setHealth(-10)");
			assert.equal(state.player.health, 0);
		});

		it("can add items to inventory", async () => {
			const { bindings, state } = createDungeonCrawlerBindings();
			const runtime = await createRuntimeFromFile("../../examples/game-mod-system.json", {
				hostBindings: bindings,
				capabilities: ["modify-player"],
			});
			runtime.execute('player.addItem({ id: "key-1", name: "Dungeon Key", type: "key" })');
			assert.equal(state.player.inventory.length, 3);
			assert.equal(state.player.inventory[2].name, "Dungeon Key");
		});

		it("still denies modify-world operations", async () => {
			const { bindings } = createDungeonCrawlerBindings();
			const runtime = await createRuntimeFromFile("../../examples/game-mod-system.json", {
				hostBindings: bindings,
				capabilities: ["modify-player"],
			});
			const result = runtime.execute(`
				let err; try { world.spawnEnemy("slime", { x: 1, y: 1 }); } catch(e) { err = e; }
				err.name;
			`);
			assert.equal(result.value, "CapabilityDeniedError");
		});
	});

	describe("with all capabilities", () => {
		it("can access everything", async () => {
			const { bindings, state } = createDungeonCrawlerBindings();
			const runtime = await createRuntimeFromFile("../../examples/game-mod-system.json", {
				hostBindings: bindings,
				capabilities: ["modify-player", "modify-world", "storage"],
			});

			runtime.execute("player.setHealth(player.getMaxHealth())");
			assert.equal(state.player.health, 100);

			runtime.execute('world.spawnEnemy("dragon", { x: 0, y: 0 })');
			assert.equal(state.enemies.length, 3);
			assert.equal(state.enemies[2].type, "dragon");
		});
	});

	describe("async bindings", () => {
		it("can call world.getEnemies", async () => {
			const { bindings } = createDungeonCrawlerBindings();
			const runtime = await createRuntimeFromFile("../../examples/game-mod-system.json", {
				hostBindings: bindings,
			});
			const result = await runtime.executeAsync("return await world.getEnemies();");
			assert.equal(result.value.length, 2);
			assert.equal(result.value[0].type, "skeleton");
		});

		it("can call data.get and data.set", async () => {
			const { bindings } = createDungeonCrawlerBindings();
			const runtime = await createRuntimeFromFile("../../examples/game-mod-system.json", {
				hostBindings: bindings,
				capabilities: ["storage"],
			});
			await runtime.executeAsync('await data.set("score", "42");');
			const result = await runtime.executeAsync('return await data.get("score");');
			assert.equal(result.value, "42");
		});

		it("returns undefined for missing keys", async () => {
			const { bindings } = createDungeonCrawlerBindings();
			const runtime = await createRuntimeFromFile("../../examples/game-mod-system.json", {
				hostBindings: bindings,
				capabilities: ["storage"],
			});
			const result = await runtime.executeAsync('return await data.get("nonexistent");');
			assert.equal(result.value, undefined);
		});
	});

	describe("execution limits", () => {
		it("enforces the 1000ms timeout from the manifest", async () => {
			const { bindings } = createDungeonCrawlerBindings();
			const runtime = await createRuntimeFromFile("../../examples/game-mod-system.json", {
				hostBindings: bindings,
			});
			assert.throws(
				() => runtime.execute("while(true){}"),
				(err) => err.code === "ERR_SCRIPT_EXECUTION_TIMEOUT" || err.message.includes("timed out"),
			);
		});
	});

	describe("complex scripting scenarios", () => {
		it("can compose multiple read operations", async () => {
			const { bindings } = createDungeonCrawlerBindings();
			const runtime = await createRuntimeFromFile("../../examples/game-mod-system.json", {
				hostBindings: bindings,
			});
			const result = runtime.execute(`
				const healthPercent = Math.round((player.getHealth() / player.getMaxHealth()) * 100);
				const pos = player.getPosition();
				const inv = player.getInventory();
				JSON.stringify({
					name: player.getName(),
					healthPercent,
					position: pos,
					itemCount: inv.length,
					level: world.getCurrentLevel()
				});
			`);
			const parsed = JSON.parse(result.value);
			assert.equal(parsed.name, "Hero");
			assert.equal(parsed.healthPercent, 80);
			assert.deepEqual(parsed.position, { x: 5, y: 10 });
			assert.equal(parsed.itemCount, 2);
			assert.equal(parsed.level, 3);
		});

		it("can heal player to full with modify-player", async () => {
			const { bindings, state } = createDungeonCrawlerBindings();
			const runtime = await createRuntimeFromFile("../../examples/game-mod-system.json", {
				hostBindings: bindings,
				capabilities: ["modify-player"],
			});
			runtime.execute("player.setHealth(player.getMaxHealth())");
			assert.equal(state.player.health, 100);
		});

		it("can filter inventory by type", async () => {
			const { bindings } = createDungeonCrawlerBindings();
			const runtime = await createRuntimeFromFile("../../examples/game-mod-system.json", {
				hostBindings: bindings,
			});
			const result = runtime.execute(`
				player.getInventory().filter(item => item.type === "weapon").length;
			`);
			assert.equal(result.value, 1);
		});
	});
});
