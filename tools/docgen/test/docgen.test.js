import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile, rm, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateDocs, generateDocsFromFile, writeDocsToDirectory } from "../dist/index.js";

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

	it("escapes a pipe in a table cell so the row stays well-formed", () => {
		const result = generateDocs({
			xript: "0.1",
			name: "test",
			capabilities: { "risky.scope": { description: "left | right", risk: "high" } },
			bindings: {
				f: { description: "d", params: [{ name: "x", type: "string", description: "a | b" }], returns: "string" },
			},
		});
		const index = result.pages.find((p) => p.slug === "index");
		const capRow = index.content.split("\n").find((l) => l.includes("risky.scope"));
		// a raw `|` would make the row a 5-cell row against a 4-column header; escaped it stays 4
		assert.ok(capRow.includes("left \\| right"), "capability description pipe should be escaped");
		assert.equal(capRow.split(/(?<!\\)\|/).length - 2, 4, "capability row should have exactly 4 cells");

		const fPage = result.pages.find((p) => p.slug === "bindings/f");
		const paramRow = fPage.content.split("\n").find((l) => l.includes("`x`"));
		assert.ok(paramRow.includes("a \\| b"), "param description pipe should be escaped");
	});

	it("does not print a literal `undefined` for a binding with no description", () => {
		const result = generateDocs({
			xript: "0.1",
			name: "test",
			bindings: {
				log: { params: [] },
				player: { members: { getHealth: { returns: "number" } } },
			},
		});
		const index = result.pages.find((p) => p.slug === "index");
		assert.ok(!index.content.includes("undefined"), "index leaked a literal `undefined`");
		const nsPage = result.pages.find((p) => p.slug === "bindings/player");
		assert.ok(nsPage && !nsPage.content.includes("undefined"), "namespace page leaked `undefined`");
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
		assert.equal(result.pages.length, 13);

		const slugs = result.pages.map((p) => p.slug).sort();
		assert.deepEqual(slugs, [
			"bindings/data",
			"bindings/log",
			"bindings/player",
			"bindings/world",
			"hooks/onDamage",
			"hooks/onLevelChange",
			"hooks/onTurnStart",
			"index",
			"types/Enemy",
			"types/EnemyType",
			"types/Item",
			"types/ItemType",
			"types/Position",
		]);
	});

	it("generates hook pages for non-phased hooks", () => {
		const result = generateDocs({
			xript: "0.1",
			name: "test",
			hooks: {
				onSave: {
					description: "Called when the game saves.",
					params: [{ name: "slot", type: "number", description: "Save slot." }],
				},
			},
		});
		const index = result.pages.find((p) => p.slug === "index");
		assert.ok(index.content.includes("## Hooks"));
		assert.ok(index.content.includes("`onSave`"));

		const page = result.pages.find((p) => p.slug === "hooks/onSave");
		assert.ok(page);
		assert.ok(page.content.includes("# onSave"));
		assert.ok(page.content.includes("Called when the game saves."));
		assert.ok(page.content.includes("hooks.onSave(handler: (slot: number) => void): void"));
		assert.ok(page.content.includes("| `slot` |"));
	});

	it("generates hook pages for phased hooks", () => {
		const result = generateDocs({
			xript: "0.1",
			name: "test",
			hooks: {
				onDamage: {
					description: "Damage event.",
					phases: ["pre", "post", "done"],
					params: [{ name: "amount", type: "number" }],
					capability: "modify-player",
				},
			},
		});
		const page = result.pages.find((p) => p.slug === "hooks/onDamage");
		assert.ok(page);
		assert.ok(page.content.includes("## Phases"));
		assert.ok(page.content.includes("`pre`"));
		assert.ok(page.content.includes("`post`"));
		assert.ok(page.content.includes("hooks.onDamage.pre(handler:"));
		assert.ok(page.content.includes("hooks.onDamage.post(handler:"));
		assert.ok(page.content.includes("`modify-player`"));
	});

	it("handles deprecated hooks", () => {
		const result = generateDocs({
			xript: "0.1",
			name: "test",
			hooks: {
				onOldEvent: {
					description: "Legacy event.",
					deprecated: "Use onNewEvent instead.",
				},
			},
		});
		const page = result.pages.find((p) => p.slug === "hooks/onOldEvent");
		assert.ok(page);
		assert.ok(page.content.includes("**Deprecated:** Use onNewEvent instead."));
	});

	it("produces minimal output for empty manifest", () => {
		const result = generateDocs({ xript: "0.1", name: "minimal" });
		assert.equal(result.pages.length, 1);
		assert.equal(result.pages[0].slug, "index");
		assert.ok(!result.pages[0].content.includes("## API Surface"));
	});

	it("generates slot table in index page when slots defined", () => {
		const result = generateDocs({
			xript: "0.3",
			name: "slotted-app",
			slots: [
				{ id: "sidebar.left", accepts: ["text/html"], multiple: true, style: "isolated" },
				{ id: "header.status", accepts: ["text/html"], capability: "ui-mount" },
			],
		});
		const index = result.pages.find((p) => p.slug === "index");
		assert.ok(index);
		assert.ok(index.content.includes("## UI Slots"));
		assert.ok(index.content.includes("`sidebar.left`"));
		assert.ok(index.content.includes("`header.status`"));
		assert.ok(index.content.includes("`ui-mount`"));
		assert.ok(index.content.includes("isolated"));
	});

	it("generates fragment API page when slots defined", () => {
		const result = generateDocs({
			xript: "0.3",
			name: "fragment-app",
			slots: [
				{ id: "sidebar.left", accepts: ["text/html"] },
			],
		});
		const apiPage = result.pages.find((p) => p.slug === "fragment-api");
		assert.ok(apiPage);
		assert.equal(apiPage.title, "Fragment API");
		assert.ok(apiPage.content.includes("## Lifecycle Hooks"));
		assert.ok(apiPage.content.includes("hooks.fragment.mount"));
		assert.ok(apiPage.content.includes("hooks.fragment.update"));
		assert.ok(apiPage.content.includes("## Fragment Proxy Methods"));
		assert.ok(apiPage.content.includes("toggle"));
		assert.ok(apiPage.content.includes("replaceChildren"));
		assert.ok(apiPage.content.includes("setProp(selector, prop, value)"), "documents the canonical setProp op");
		assert.match(apiPage.content, /setAttr[^\n]*Deprecated/, "marks setAttr deprecated");
	});

	it("does not generate slot docs when no slots defined", () => {
		const result = generateDocs({ xript: "0.1", name: "no-slots" });
		const index = result.pages.find((p) => p.slug === "index");
		assert.ok(!index.content.includes("## UI Slots"));
		assert.ok(!result.pages.find((p) => p.slug === "fragment-api"));
	});

	it("includes fragment API link in index when slots exist", () => {
		const result = generateDocs({
			xript: "0.3",
			name: "linked-app",
			slots: [{ id: "sidebar", accepts: ["text/html"] }],
		});
		const index = result.pages.find((p) => p.slug === "index");
		assert.ok(index.content.includes("fragment-api.md"));
	});

	it("strips .md from links with linkFormat no-extension", () => {
		const result = generateDocs({
			xript: "0.1",
			name: "test",
			bindings: {
				log: { description: "Logs a message." },
				player: { description: "Player.", members: { getHealth: { description: "Health.", returns: "number" } } },
			},
			hooks: { onTick: { description: "Called each tick." } },
			types: { Direction: { description: "Cardinal direction.", values: ["north", "south"] } },
			slots: [{ id: "sidebar", accepts: ["text/html"] }],
		}, { linkFormat: "no-extension" });
		const index = result.pages.find((p) => p.slug === "index");
		assert.ok(!index.content.includes(".md)"), "should not contain .md links");
		assert.ok(index.content.includes("./bindings/log)"));
		assert.ok(index.content.includes("./bindings/player)"));
		assert.ok(index.content.includes("./hooks/onTick)"));
		assert.ok(index.content.includes("./types/Direction)"));
		assert.ok(index.content.includes("./fragment-api)"));
	});

	it("uses .md links by default", () => {
		const result = generateDocs({
			xript: "0.1",
			name: "test",
			bindings: { log: { description: "Logs." } },
		});
		const index = result.pages.find((p) => p.slug === "index");
		assert.ok(index.content.includes("./bindings/log.md)"));
	});

	it("uses .md links with linkFormat default", () => {
		const result = generateDocs({
			xript: "0.1",
			name: "test",
			bindings: { log: { description: "Logs." } },
		}, { linkFormat: "default" });
		const index = result.pages.find((p) => p.slug === "index");
		assert.ok(index.content.includes("./bindings/log.md)"));
	});

	it("shows slot accept formats and multiple flag", () => {
		const result = generateDocs({
			xript: "0.3",
			name: "multi-slot",
			slots: [
				{ id: "overlay", accepts: ["text/html"], multiple: true },
				{ id: "status", accepts: ["text/html"], multiple: false },
			],
		});
		const index = result.pages.find((p) => p.slug === "index");
		assert.ok(index.content.includes("| Yes |"));
		assert.ok(index.content.includes("| No |"));
	});

	it("publishes a node table for a declared fragment format", () => {
		const result = generateDocs({
			xript: "0.8",
			name: "panel-host",
			formats: {
				"application/x-panel+json": {
					description: "The sidebar vocabulary.",
					syntax: "j5ml",
					nodes: {
						Panel: { props: { heading: { type: "string" }, collapsible: { type: "boolean", default: false } } },
						Link: { children: "text", props: { href: { type: "string", sink: "uri" } } },
					},
				},
			},
			slots: [{ id: "sidebar.left", accepts: ["application/x-panel+json"], multiple: true }],
		});
		const content = result.pages.find((p) => p.slug === "index").content;
		assert.match(content, /## Fragment Formats/);
		assert.match(content, /### `application\/x-panel\+json`/);
		assert.match(content, /\| `Panel` \|/);
		assert.match(content, /`heading`: `string`/);
		assert.match(content, /`collapsible`: `boolean`, default `false`/);
		assert.match(content, /`href`: `string`, sink `uri`/);
		assert.match(content, /\| text \|/);
	});

	it("resolves a named vocabulary referenced by a format", () => {
		const result = generateDocs({
			xript: "0.8",
			name: "acme-host",
			vocabularies: {
				"acme.components": {
					nodes: { "acme-icon": { children: "none", props: { name: { type: "string" } } }, "acme-card": { props: { heading: { type: "string" } } } },
				},
			},
			formats: { "application/x-acme+json": { syntax: "j5ml", vocabularies: ["acme.components"] } },
			slots: [{ id: "main", accepts: ["application/x-acme+json"] }],
		});
		const content = result.pages.find((p) => p.slug === "index").content;
		assert.match(content, /\| `acme-icon` \|/);
		assert.match(content, /\| `acme-card` \|/);
		assert.match(content, /`heading`: `string`/);
	});

	it("does not enumerate the built-in HTML element set for an html-scoped format", () => {
		const result = generateDocs({
			xript: "0.8",
			name: "html-host",
			formats: { "text/x-host+html": { syntax: "html", vocabularies: ["html"] } },
			slots: [{ id: "s", accepts: ["text/x-host+html"] }],
		});
		const content = result.pages.find((p) => p.slug === "index").content;
		assert.match(content, /## Fragment Formats/);
		assert.match(content, /No host-declared nodes/);
		assert.ok(!content.includes("| `div` |"), "must not dump HTML elements");
	});

	it("omits the Fragment Formats section when no formats are declared", () => {
		const result = generateDocs({ xript: "0.8", name: "plain", slots: [{ id: "s", accepts: ["text/html"] }] });
		assert.ok(!result.pages.find((p) => p.slug === "index").content.includes("## Fragment Formats"));
	});
});

describe("writeDocsToDirectory with frontmatter", () => {
	it("injects frontmatter when option provided", async () => {
		const result = generateDocs({ xript: "0.1", name: "test", bindings: { log: { description: "Logs." } } });
		const tmpDir = await mkdtemp(join(tmpdir(), "docgen-test-"));
		try {
			await writeDocsToDirectory(result, tmpDir, { frontmatter: "title: API Docs\nlayout: doc" });
			const content = await readFile(join(tmpDir, "index.md"), "utf-8");
			assert.ok(content.startsWith("---\n"));
			assert.ok(content.includes("title: API Docs"));
			assert.ok(content.includes("layout: doc"));
			assert.ok(content.includes("---\n\n#"));
		} finally {
			await rm(tmpDir, { recursive: true });
		}
	});

	it("does not inject frontmatter when option absent", async () => {
		const result = generateDocs({ xript: "0.1", name: "test" });
		const tmpDir = await mkdtemp(join(tmpdir(), "docgen-test-"));
		try {
			await writeDocsToDirectory(result, tmpDir);
			const content = await readFile(join(tmpDir, "index.md"), "utf-8");
			assert.ok(!content.startsWith("---"));
		} finally {
			await rm(tmpDir, { recursive: true });
		}
	});

	it("applies frontmatter to all generated files", async () => {
		const result = generateDocs({
			xript: "0.1",
			name: "test",
			bindings: { log: { description: "Logs." } },
		});
		const tmpDir = await mkdtemp(join(tmpdir(), "docgen-test-"));
		try {
			const written = await writeDocsToDirectory(result, tmpDir, { frontmatter: "sidebar:\n  order: 1" });
			for (const file of written) {
				const content = await readFile(file, "utf-8");
				assert.ok(content.startsWith("---\n"), `${file} should have frontmatter`);
			}
		} finally {
			await rm(tmpDir, { recursive: true });
		}
	});
});

describe("runtime-configured capability scopes", () => {
	const host = {
		xript: "0.8",
		name: "fs-host",
		capabilities: {
			fs: { description: "Filesystem." },
			"fs.workspace": {
				description: "A configured workspace root.",
				instances: { description: "One per configured workspace.", example: "fs.workspace.my-project" },
			},
		},
	};

	const indexOf = (manifest) => generateDocs(manifest).pages[0].content;

	it("documents the dynamic half of the scope tree", () => {
		const out = indexOf(host);
		assert.match(out, /### Runtime-configured scopes/);
		assert.match(out, /One per configured workspace\./);
		assert.match(out, /fs\.workspace\.my-project/);
	});

	it("omits the section when no scope declares instances", () => {
		const plain = { ...host, capabilities: { fs: { description: "Filesystem." } } };
		assert.doesNotMatch(indexOf(plain), /Runtime-configured scopes/);
	});
});

describe("array element precedence", () => {
	// Both renderers appended `[]` without parenthesising, so an array of a union documented as
	// `string | number[]` — a union with an array. The signature block is fenced as TypeScript,
	// so the wrong type was published as code an adopter copies.
	const host = {
		xript: "0.8",
		name: "h",
		types: { Player: { description: "P.", fields: {} } },
		bindings: {
			arrayOfUnion: { description: "A.", params: [{ name: "x", type: { array: { union: ["string", "number"] } } }] },
			plainArray: { description: "B.", params: [], returns: { array: "Player" } },
		},
	};
	const pageFor = (name) => generateDocs(host).pages.find((p) => p.slug.includes(name)).content;

	it("parenthesises a union in the signature block", () => {
		assert.match(pageFor("arrayOfUnion"), /\(string \| number\)\[\]/);
	});

	it("parenthesises a union in the parameter table", () => {
		assert.match(pageFor("arrayOfUnion"), /\(`string` \\| `number`\)\[\]/);
	});

	it("leaves a plain element type unparenthesised", () => {
		const page = pageFor("plainArray");
		assert.match(page, /Player\[\]/);
		assert.doesNotMatch(page, /\(`?Player`?\)\[\]/);
	});
});

describe("typeRef rendering corpus", () => {
	// `typegen` and `docgen` are two resolvers of one grammar. When the array-of-union precedence
	// bug shipped, BOTH were wrong the same way, so a test asserting only that they agree would
	// have passed. The corpus pins the expected text instead.
	const corpus = JSON.parse(readFileSync(new URL("../../../spec/type-ref-tests.json", import.meta.url), "utf-8"));
	const base = { xript: "0.8", name: "h", types: { Player: { description: "P.", fields: {} } } };
	const manifestFor = (ref) => ({ ...base, bindings: { f: { description: "F.", params: [], returns: ref } } });

	it("carries cases", () => {
		assert.ok(corpus.cases.length > 0);
	});

	for (const testCase of corpus.cases) {
		it(testCase.name, () => {
			const rendered = (generateDocs(manifestFor(testCase.ref)).pages.find((pg) => pg.slug.includes("bindings/f")).content.match(/## Returns\s+(.+)/) || [])[1].trim();
			assert.equal(rendered, testCase.markdown, testCase.name);
		});
	}
});
