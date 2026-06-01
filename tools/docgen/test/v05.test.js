import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateDocs, generateDocsFromFile } from "../dist/index.js";

function findPage(result, slug) {
	return result.pages.find((p) => p.slug === slug);
}

describe("nested namespace docs", () => {
	it("renders nested namespace members at arbitrary depth", () => {
		const result = generateDocs({
			xript: "0.3",
			name: "host",
			bindings: {
				app: {
					description: "Root.",
					members: {
						brick: {
							description: "Bricks.",
							members: {
								list: { description: "Lists bricks.", returns: "string[]" },
							},
						},
					},
				},
			},
		});
		const page = findPage(result, "bindings/app");
		assert.ok(page, "namespace page exists");
		assert.match(page.content, /### app\.brick\.list\(\)/);
		assert.match(page.content, /Lists bricks\./);
	});
});

describe("record field default and enum docs (wave 2)", () => {
	it("renders default and allowed values columns in a type field table", () => {
		const result = generateDocs({
			xript: "0.3",
			name: "host",
			types: {
				BrickFiles: {
					description: "File viewer config.",
					fields: {
						pathStyle: { type: "string", enum: ["posix", "hybrid", "native"], default: "posix", description: "Path style." },
						viewingEnabled: { type: "boolean", default: true },
					},
				},
			},
		});
		const page = findPage(result, "types/BrickFiles");
		assert.ok(page, "type page exists");
		assert.match(page.content, /Default \| Allowed Values/);
		assert.match(page.content, /`"posix"`/);
		assert.match(page.content, /`"posix"`, `"hybrid"`, `"native"`/);
	});
});

describe("provides docs (wave 2)", () => {
	it("renders a Provides section on the index page with a logical to concrete table", () => {
		const result = generateDocs({
			xript: "0.3",
			name: "clip-mod",
			contributions: {
				provides: [{ role: "clipboard-history", fns: { query: "ch_query", restore: "ch_restore" } }],
			},
		});
		const index = findPage(result, "index");
		assert.match(index.content, /## Provides/);
		assert.match(index.content, /### `clipboard-history`/);
		assert.match(index.content, /\| `query` \| `ch_query` \|/);
	});
});

describe("grant shapes docs (wave 2)", () => {
	it("emits a grant-shapes reference page only when requested", () => {
		const without = generateDocs({ xript: "0.3", name: "host" });
		assert.ok(!without.pages.find((p) => p.slug === "capability-grant-shapes"));

		const withPage = generateDocs({ xript: "0.3", name: "host" }, { grantShapes: true });
		const page = withPage.pages.find((p) => p.slug === "capability-grant-shapes");
		assert.ok(page, "grant shapes page exists");
		assert.match(page.content, /## CapabilityPrompt/);
		assert.match(page.content, /## InstallDescriptor/);
		assert.match(page.content, /## DiscoveryResult/);
	});
});

describe("extends resolution in docs", () => {
	it("includes inherited base bindings in generated docs", async () => {
		const dir = await mkdtemp(join(tmpdir(), "xript-docgen-"));
		try {
			await writeFile(
				join(dir, "base.json"),
				JSON.stringify({
					xript: "0.3",
					name: "base",
					bindings: { getHealth: { description: "Returns health.", returns: "number" } },
				}),
			);
			await writeFile(
				join(dir, "child.json"),
				JSON.stringify({
					xript: "0.3",
					extends: "./base.json",
					name: "child",
					bindings: { setHealth: { description: "Sets health." } },
				}),
			);
			const result = await generateDocsFromFile(join(dir, "child.json"));
			assert.ok(findPage(result, "bindings/getHealth"), "inherited binding page exists");
			assert.ok(findPage(result, "bindings/setHealth"), "child binding page exists");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
