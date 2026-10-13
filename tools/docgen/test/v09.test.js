import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateDocs } from "../dist/index.js";

const EM_DASH = "—";

const RICH_HOST = {
	xript: "0.9",
	name: "rich-host",
	title: "Rich Host",
	description: "Exercises every section docgen writes.",
	version: "1.2.3",
	execution: { duration: "brief", affinity: "any" },
	capabilities: {
		ui: { description: "Mount UI.", risk: "low" },
		fs: { description: "Files.", risk: "high", instances: { description: "One per root." } },
		run: { description: "Run things." },
	},
	types: {
		Item: {
			description: "An item.",
			fields: {
				name: { type: "string", description: "The name." },
				kind: { type: "Kind", enum: ["a", "b"] },
				count: { type: "int", default: 0 },
				tags: { type: "string[]", optional: true },
			},
		},
		Kind: { description: "A kind.", values: ["a", "b"], open: true },
	},
	bindings: {
		log: {
			description: "Logs.",
			params: [
				{ name: "level", type: "string" },
				{ name: "parts", type: "string | number", variadic: true, description: "What to log." },
			],
		},
		sum: { description: "Adds.", params: [{ name: "values", type: "float", variadic: true }], returns: { type: "number", description: "The total." } },
		read: {
			description: "Reads.",
			capability: "read:fs",
			async: true,
			execution: { duration: "long", affinity: "worker" },
			params: [{ name: "path", type: "string" }, { name: "encoding", type: "string", optional: true }],
			returns: "string",
		},
		runCommand: { description: "Runs.", capability: "run", params: [] },
		ns: {
			description: "A namespace.",
			members: {
				get: { description: "Gets.", params: [{ name: "k", type: "string" }], returns: { type: "Item?", description: "The item, if found." } },
				inner: { description: "Inner.", members: { deep: { description: "Deep.", params: [] } } },
			},
		},
	},
	hooks: {
		onSave: { description: "Saved.", params: [{ name: "item", type: "Item" }], capability: "ui" },
		lifecycle: { description: "Phased.", phases: ["pre", "post"], params: [{ name: "rest", type: "int", variadic: true }] },
	},
	events: [
		{ id: "app.ready", description: "Ready." },
		{ id: "item.changed", description: "Changed.", payload: "Item", capability: "ui" },
	],
	libraries: { "std-lib": { description: "Helpers." }, "fs-lib": { description: "Files.", capability: "fs", version: "1.0.0" } },
	formats: {
		"application/x-panel+json": {
			description: "Panels.",
			syntax: "j5ml",
			nodes: { Panel: { props: { heading: { type: "string" } } }, Link: { children: "text", props: { href: { type: "string", sink: "uri" } } } },
		},
	},
	slots: [
		{ id: "sidebar", accepts: ["text/html", "application/x-panel+json"], capability: "ui", multiple: true, description: "Sidebar." },
		{ id: "open", accepts: ["application/x-xript-hook"], description: "Open hook." },
		{ id: "palette", accepts: ["application/x-xript-command"], multiple: true, capability: "run", description: "Commands.", limits: { timeout_ms: 500 } },
		{ id: "plain", accepts: ["text/html"] },
	],
};

const RICH_MOD = {
	xript: "0.9",
	name: "rich-mod",
	version: "1.0.0",
	capabilities: ["ui", "run"],
	entry: {
		script: "mod.js",
		format: "module",
		exports: {
			wrap: { description: "Wraps.", capability: "run", params: [{ name: "args", type: "string", variadic: true }], returns: { type: "string", description: "Wrapped." } },
			plain: { description: "Plain." },
		},
	},
	fills: {
		sidebar: [{ id: "panel", format: "text/html", source: "<p>x</p>", inline: true, events: [{ selector: "p", on: "click", handler: "wrap" }] }],
		palette: [
			{ id: "wrap.double", title: "Wrap", handler: "wrap", args: { open: "\"" } },
			{ id: "wrap.hidden", title: "Hidden", handler: "plain", exposed: false },
		],
	},
};

describe("generated docs carry no em-dash", () => {
	it("a rich host manifest, with grant shapes", () => {
		const result = generateDocs(RICH_HOST, { grantShapes: true });
		assert.ok(result.pages.length > 5);
		for (const page of result.pages) {
			assert.ok(!page.content.includes(EM_DASH), `${page.slug} contains U+2014`);
			assert.ok(!page.title.includes(EM_DASH), `${page.slug} title contains U+2014`);
		}
	});

	it("a rich mod manifest documented against its host", () => {
		const result = generateDocs(RICH_MOD, { host: RICH_HOST });
		for (const page of result.pages) assert.ok(!page.content.includes(EM_DASH), `${page.slug} contains U+2014`);
	});

	it("uses a colon as the index separator and a hyphen for an empty cell", () => {
		const index = generateDocs(RICH_HOST).pages.find((p) => p.slug === "index").content;
		assert.match(index, /- \[`log\(\)`\]\(\.\/bindings\/log\.md\): Logs\./);
		assert.match(index, /\| `app\.ready` \| - \| - \| Ready\. \|/);
	});
});

describe("variadic parameters and described returns", () => {
	const pages = generateDocs(RICH_HOST).pages;
	const page = (slug) => pages.find((p) => p.slug === slug).content;

	it("writes a variadic parameter as a rest in the signature", () => {
		assert.match(page("bindings/log"), /function log\(level: string, \.\.\.parts: \(string \| number\)\[\]\): void/);
		assert.match(page("bindings/sum"), /function sum\(\.\.\.values: number\[\]\): number/);
	});

	it("marks a variadic parameter in the parameter table", () => {
		const content = page("bindings/log");
		assert.match(content, /\| `\.\.\.parts` \| `string` \\\| `number` \| No \| What to log\. Variadic: takes zero or more arguments, each of this type\. \|/);
	});

	it("documents the optional alias as not required", () => {
		assert.match(page("bindings/read"), /\| `encoding` \| `string` \| No \|/);
		assert.match(page("bindings/read"), /encoding\?: string/);
	});

	it("carries a return description", () => {
		assert.match(page("bindings/sum"), /## Returns\s+`number`: The total\./);
		assert.match(page("bindings/ns"), /\*\*Returns:\*\* `Item` \\\| `undefined`: The item, if found\./);
	});

	it("writes a variadic hook parameter as a rest in the handler type", () => {
		assert.match(page("hooks/lifecycle"), /hooks\.lifecycle\.pre\(handler: \(\.\.\.rest: number\[\]\) => void\): void/);
	});
});
