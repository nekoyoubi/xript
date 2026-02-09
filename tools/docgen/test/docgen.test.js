import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateDocs, generateDocsFromFile } from "../dist/index.js";

describe("generateDocs", () => {
	it("generates an index page with manifest metadata", () => {
		const result = generateDocs({
			xript: "0.1",
			name: "test-app",
			title: "Test Application",
			version: "1.0.0",
			description: "A test application.",
		});
		const index = result.pages.find((p) => p.slug === "index");
		assert.ok(index);
		assert.ok(index.content.includes("# Test Application API Reference"));
		assert.ok(index.content.includes("A test application."));
		assert.ok(index.content.includes("**API Version:** 1.0.0"));
	});

	it("generates an index page with function and namespace listings", () => {
		const result = generateDocs({
			xript: "0.1",
			name: "test",
			bindings: {
				log: { description: "Logs a message." },
				player: { description: "Player functions.", members: { getHealth: { description: "Gets health.", returns: "number" } } },
			},
		});
		const index = result.pages.find((p) => p.slug === "index");
		assert.ok(index);
		assert.ok(index.content.includes("`log()`"));
		assert.ok(index.content.includes("`player`"));
		assert.ok(index.content.includes("1 function"));
	});

	it("generates function binding pages", () => {
		const result = generateDocs({
			xript: "0.1",
			name: "test",
			bindings: {
				log: {
					description: "Logs a message.",
					params: [{ name: "message", type: "string", description: "The message." }],
				},
			},
		});
		const page = result.pages.find((p) => p.slug === "bindings/log");
		assert.ok(page);
		assert.ok(page.content.includes("# log()"));
		assert.ok(page.content.includes("function log(message: string): void"));
		assert.ok(page.content.includes("| `message` |"));
	});

	it("generates namespace binding pages", () => {
		const result = generateDocs({
			xript: "0.1",
			name: "test",
			bindings: {
				player: {
					description: "Player functions.",
					members: {
						getHealth: { description: "Returns health.", returns: "number" },
						setHealth: {
							description: "Sets health.",
							params: [{ name: "value", type: "number" }],
							capability: "modify-player",
						},
					},
				},
			},
		});
		const page = result.pages.find((p) => p.slug === "bindings/player");
		assert.ok(page);
		assert.ok(page.content.includes("# player"));
		assert.ok(page.content.includes("### player.getHealth()"));
		assert.ok(page.content.includes("### player.setHealth()"));
		assert.ok(page.content.includes("`modify-player`"));
	});

	it("generates type pages for interfaces", () => {
		const result = generateDocs({
			xript: "0.1",
			name: "test",
			types: {
				Position: {
					description: "A 2D position.",
					fields: {
						x: { type: "number", description: "Horizontal." },
						y: { type: "number", description: "Vertical." },
					},
				},
			},
		});
		const page = result.pages.find((p) => p.slug === "types/Position");
		assert.ok(page);
		assert.ok(page.content.includes("# Position"));
		assert.ok(page.content.includes("A 2D position."));
		assert.ok(page.content.includes("| `x` |"));
		assert.ok(page.content.includes("interface Position {"));
	});

	it("generates type pages for enums", () => {
		const result = generateDocs({
			xript: "0.1",
			name: "test",
			types: {
				Direction: {
					description: "A direction.",
					values: ["north", "south", "east", "west"],
				},
			},
		});
		const page = result.pages.find((p) => p.slug === "types/Direction");
		assert.ok(page);
		assert.ok(page.content.includes("# Direction"));
		assert.ok(page.content.includes('`"north"`'));
		assert.ok(page.content.includes('type Direction = "north" | "south" | "east" | "west"'));
	});

	it("includes capability table in index", () => {
		const result = generateDocs({
			xript: "0.1",
			name: "test",
			capabilities: {
				"modify-player": { description: "Modify player.", risk: "medium" },
				storage: { description: "Use storage.", risk: "low" },
			},
		});
		const index = result.pages.find((p) => p.slug === "index");
		assert.ok(index);
		assert.ok(index.content.includes("| `modify-player` |"));
		assert.ok(index.content.includes("| medium |"));
		assert.ok(index.content.includes("| `storage` |"));
	});

	it("handles deprecated functions", () => {
		const result = generateDocs({
			xript: "0.1",
			name: "test",
			bindings: {
				getHP: {
					description: "Gets health.",
					returns: "number",
					deprecated: "Use getHealth() instead.",
				},
			},
		});
		const page = result.pages.find((p) => p.slug === "bindings/getHP");
		assert.ok(page);
		assert.ok(page.content.includes("**Deprecated:** Use getHealth() instead."));
	});

	it("handles async functions", () => {
		const result = generateDocs({
			xript: "0.1",
			name: "test",
			bindings: {
				fetch: {
					description: "Fetches data.",
					returns: "string",
					async: true,
				},
			},
		});
		const page = result.pages.find((p) => p.slug === "bindings/fetch");
		assert.ok(page);
		assert.ok(page.content.includes("Promise<string>"));
		assert.ok(page.content.includes("(async)"));
	});

	it("handles optional parameters", () => {
		const result = generateDocs({
			xript: "0.1",
			name: "test",
			bindings: {
				greet: {
					description: "Greets.",
					params: [
						{ name: "name", type: "string" },
						{ name: "loud", type: "boolean", default: false },
					],
					returns: "string",
				},
			},
		});
		const page = result.pages.find((p) => p.slug === "bindings/greet");
		assert.ok(page);
		assert.ok(page.content.includes("loud?: boolean"));
		assert.ok(page.content.includes("| No |"));
		assert.ok(page.content.includes("(default: `false`)"));
	});

	it("includes examples in function pages", () => {
		const result = generateDocs({
			xript: "0.1",
			name: "test",
			bindings: {
				heal: {
					description: "Heals.",
					examples: [
						{ title: "Full heal", code: "heal(100);", description: "Heals to full." },
					],
				},
			},
		});
		const page = result.pages.find((p) => p.slug === "bindings/heal");
		assert.ok(page);
		assert.ok(page.content.includes("### Full heal"));
		assert.ok(page.content.includes("heal(100);"));
		assert.ok(page.content.includes("Heals to full."));
	});

	it("handles optional type fields", () => {
		const result = generateDocs({
			xript: "0.1",
			name: "test",
			types: {
				Item: {
					description: "An item.",
					fields: {
						id: { type: "string" },
						damage: { type: "number", optional: true },
					},
				},
			},
		});
		const page = result.pages.find((p) => p.slug === "types/Item");
		assert.ok(page);
		assert.ok(page.content.includes("damage?: number;"));
		assert.ok(page.content.includes("| No |"));
	});

	it("generates full docs for the dungeon-crawler example", async () => {
		const result = await generateDocsFromFile("../../examples/game-mod-system/manifest.json");
		assert.equal(result.pages.length, 10);

		const slugs = result.pages.map((p) => p.slug).sort();
		assert.deepEqual(slugs, [
			"bindings/data",
			"bindings/log",
			"bindings/player",
			"bindings/world",
			"index",
			"types/Enemy",
			"types/EnemyType",
			"types/Item",
			"types/ItemType",
			"types/Position",
		]);
	});

	it("produces minimal output for empty manifest", () => {
		const result = generateDocs({ xript: "0.1", name: "minimal" });
		assert.equal(result.pages.length, 1);
		assert.equal(result.pages[0].slug, "index");
		assert.ok(!result.pages[0].content.includes("## API Surface"));
	});
});
