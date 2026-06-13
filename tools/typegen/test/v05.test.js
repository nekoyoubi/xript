import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateTypes, generateTypesFromFile, generateAmbientTypes, resolveExtends } from "../dist/index.js";

describe("Slot union", () => {
	it("emits a Slot string-literal union from app slot ids", () => {
		const result = generateTypes({
			xript: "0.3",
			name: "host",
			slots: [
				{ id: "sidebar", accepts: ["text/html"] },
				{ id: "statusbar", accepts: ["text/html"] },
			],
		});
		assert.match(result, /type Slot = "sidebar" \| "statusbar";/);
	});
});

describe("nested namespaces", () => {
	it("emits nested namespace types at arbitrary depth", () => {
		const result = generateTypes({
			xript: "0.3",
			name: "host",
			bindings: {
				app: {
					description: "Root.",
					members: {
						brick: {
							description: "Bricks.",
							members: {
								meta: {
									description: "Meta.",
									members: {
										list: { description: "Lists." },
									},
								},
							},
						},
					},
				},
			},
		});
		assert.match(result, /declare namespace app \{/);
		assert.match(result, /namespace brick \{/);
		assert.match(result, /namespace meta \{/);
		assert.match(result, /function list\(\): void;/);
	});
});

describe("host-invokable exports", () => {
	it("emits an Exports interface from entry.exports", () => {
		const result = generateTypes({
			xript: "0.3",
			name: "my-mod",
			version: "1.0.0",
			entry: {
				script: "main.js",
				exports: {
					transcribe: {
						description: "Transcribe audio.",
						params: [{ name: "audioUrl", type: "string" }],
						returns: "string",
					},
				},
			},
		});
		assert.match(result, /interface Exports \{/);
		assert.match(result, /transcribe\(audioUrl: string\): string;/);
	});

	it("omits the Exports interface for the bare string entry form", () => {
		const result = generateTypes({
			xript: "0.3",
			name: "my-mod",
			version: "1.0.0",
			entry: "main.js",
		});
		assert.ok(!result.includes("interface Exports"));
	});
});

describe("record field default and enum (wave 2)", () => {
	it("treats a default-present field as non-optional and inline enum as a literal union", () => {
		const result = generateTypes({
			xript: "0.3",
			name: "host",
			types: {
				BrickFiles: {
					description: "File viewer config.",
					fields: {
						path: { type: "string", optional: true },
						pathStyle: { type: "string", enum: ["posix", "hybrid", "native"], default: "posix" },
						viewingEnabled: { type: "boolean", default: true },
					},
				},
			},
		});
		assert.match(result, /interface BrickFiles \{/);
		assert.match(result, /path\?: string;/);
		assert.match(result, /pathStyle: "posix" \| "hybrid" \| "native";/);
		assert.match(result, /viewingEnabled: boolean;/);
	});

	it("resolves a named values-based enum type the same as inline enum", () => {
		const result = generateTypes({
			xript: "0.3",
			name: "host",
			types: {
				PathStyle: { description: "Path rendering style.", values: ["posix", "hybrid", "native"] },
				BrickFiles: {
					description: "File viewer config.",
					fields: { pathStyle: { type: "PathStyle", default: "posix" } },
				},
			},
		});
		assert.match(result, /pathStyle: "posix" \| "hybrid" \| "native";/);
	});

	it("emits a companion Accessor interface with typed get/set", () => {
		const result = generateTypes({
			xript: "0.3",
			name: "host",
			types: {
				BrickFiles: {
					description: "File viewer config.",
					fields: {
						path: { type: "string", optional: true },
						pathStyle: { type: "string", enum: ["posix", "hybrid", "native"], default: "posix" },
						viewingEnabled: { type: "boolean", default: true },
					},
				},
			},
		});
		assert.match(result, /interface BrickFilesAccessor \{/);
		assert.match(result, /get path\(\): string \| undefined;/);
		assert.match(result, /set path\(v: string \| undefined\);/);
		assert.match(result, /get pathStyle\(\): "posix" \| "hybrid" \| "native";/);
		assert.match(result, /get viewingEnabled\(\): boolean;/);
		assert.match(result, /set viewingEnabled\(v: boolean\);/);
	});

	it("omits an accessor for fieldless enum value types", () => {
		const result = generateTypes({
			xript: "0.3",
			name: "host",
			types: { Direction: { description: "A direction.", values: ["n", "s"] } },
		});
		assert.ok(!result.includes("DirectionAccessor"));
	});
});

describe("provider roles (wave 2)", () => {
	it("emits a ProvidedRoles interface keyed by role", () => {
		const result = generateTypes({
			xript: "0.3",
			name: "clip-mod",
			version: "1.0.0",
			contributions: {
				provides: [
					{ role: "clipboard-history", fns: { query: "ch_query", restore: "ch_restore" } },
				],
			},
		});
		assert.match(result, /interface ProvidedRoles \{/);
		assert.match(result, /"clipboard-history": Record<string, string>;/);
	});

	it("omits ProvidedRoles when no contributions.provides present", () => {
		const result = generateTypes({ xript: "0.3", name: "plain", version: "1.0.0" });
		assert.ok(!result.includes("ProvidedRoles"));
	});
});

describe("grant shapes (wave 2)", () => {
	it("emits the three grant-shape interfaces only with includeGrantShapes", () => {
		const without = generateTypes({ xript: "0.3", name: "host" });
		assert.ok(!without.includes("interface CapabilityPrompt"));

		const withShapes = generateTypes({ xript: "0.3", name: "host" }, { includeGrantShapes: true });
		assert.match(withShapes, /interface CapabilityPrompt \{/);
		assert.match(withShapes, /requestedScope: "one-run" \| "session" \| "persistent";/);
		assert.match(withShapes, /state: "first-time" \| "previously-denied" \| "requesting-elevation";/);
		assert.match(withShapes, /interface InstallDescriptor \{/);
		assert.match(withShapes, /source: \{ type: "file" \| "url" \| "registry"; location: string \};/);
		assert.match(withShapes, /interface DiscoveryResult \{/);
	});
});

describe("ambient declaration target (wave 3)", () => {
	const manifest = {
		xript: "0.3",
		name: "my-mod",
		version: "1.0.0",
		bindings: {
			log: { description: "Logs.", params: [{ name: "m", type: "string" }] },
			player: { description: "Player.", members: { getHealth: { description: "Health.", returns: "number" } } },
		},
		hooks: { onStart: { description: "Start." } },
		slots: [{ id: "sidebar.left", accepts: ["text/html"] }],
		entry: {
			script: "src/mod.ts",
			format: "module",
			exports: { transcribe: { description: "x", params: [{ name: "u", type: "string" }], returns: "string" } },
		},
	};

	it("wraps the in-sandbox surface in a declare global block", () => {
		const out = generateTypes(manifest, { ambient: true });
		assert.match(out, /declare global \{/);
		assert.match(out, /export \{\};/);
	});

	it("emits host bindings as bare (non-declare) globals inside declare global", () => {
		const out = generateTypes(manifest, { ambient: true });
		assert.match(out, /\tfunction log\(m: string\): void;/);
		assert.ok(!/\tdeclare function log/.test(out), "no nested declare on globals");
		assert.match(out, /namespace player \{/);
	});

	it("declares the xript const with the exports.register surface", () => {
		const out = generateTypes(manifest, { ambient: true });
		assert.match(out, /const xript: \{/);
		assert.match(out, /register\(name: string, fn: \(\.\.\.args: any\[\]\) => unknown\): void;/);
	});

	it("emits the hooks namespace including fragment lifecycles", () => {
		const out = generateTypes(manifest, { ambient: true });
		assert.match(out, /namespace hooks \{/);
		assert.match(out, /namespace fragment \{/);
		assert.match(out, /function update\(fragmentId: string/);
	});

	it("surfaces the mod's Exports interface outside the global block", () => {
		const out = generateTypes(manifest, { ambient: true });
		assert.match(out, /interface Exports \{/);
		assert.match(out, /transcribe\(u: string\): string;/);
	});

	it("generateAmbientTypes is exported and equivalent to the ambient option", () => {
		const a = generateAmbientTypes(manifest);
		const b = generateTypes(manifest, { ambient: true });
		assert.equal(a, b);
	});

	it("emits only the xript/exports/types portion when given just a mod manifest", () => {
		const out = generateTypes(
			{ xript: "0.3", name: "mod-only", version: "1.0.0", entry: { script: "m.ts", format: "module", exports: { go: { description: "g" } } } },
			{ ambient: true },
		);
		assert.match(out, /declare global \{/);
		assert.match(out, /const xript: \{/);
		assert.match(out, /interface Exports \{/);
		assert.ok(!out.includes("function log("), "no host bindings when manifest declares none");
	});
});

describe("extends resolution", () => {
	it("resolves extends so emitted types cover base + child bindings", async () => {
		const dir = await mkdtemp(join(tmpdir(), "xript-typegen-"));
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
			const { content } = await generateTypesFromFile(join(dir, "child.json"));
			assert.match(content, /declare function getHealth\(\): number;/);
			assert.match(content, /declare function setHealth\(\): void;/);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("merges in-memory via resolveExtends helper", async () => {
		const dir = await mkdtemp(join(tmpdir(), "xript-typegen-r-"));
		try {
			await writeFile(
				join(dir, "base.json"),
				JSON.stringify({ xript: "0.3", name: "base", capabilities: { storage: { description: "x" } } }),
			);
			const merged = await resolveExtends(
				{ xript: "0.3", extends: "./base.json", name: "child" },
				dir,
			);
			assert.ok(merged.capabilities.storage);
			assert.equal(merged.extends, undefined);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("top-level events catalog", () => {
	it("emits an XriptEvents interface mapping event id to payload type", () => {
		const result = generateTypes({
			xript: "0.3",
			name: "host",
			types: { SaveInfo: { description: "Save info.", fields: { path: { type: "string" } } } },
			events: [
				{ id: "document.saved", description: "Fired after a save.", payload: "SaveInfo" },
				{ id: "selection.changed", description: "Fired when selection changes." },
			],
		});
		assert.match(result, /interface XriptEvents \{/);
		assert.match(result, /"document\.saved": SaveInfo;/);
		assert.match(result, /"selection\.changed": void;/);
	});

	it("emits an XriptEventId union of event ids", () => {
		const result = generateTypes({
			xript: "0.3",
			name: "host",
			events: [
				{ id: "a.fired", description: "A." },
				{ id: "b.fired", description: "B." },
			],
		});
		assert.match(result, /type XriptEventId = "a\.fired" \| "b\.fired";/);
	});

	it("omits the events catalog when no events are declared", () => {
		const result = generateTypes({ xript: "0.3", name: "host" });
		assert.ok(!result.includes("XriptEvents"));
		assert.ok(!result.includes("XriptEventId"));
	});

	it("emits the events catalog inside the global block in ambient mode", () => {
		const out = generateTypes(
			{ xript: "0.3", name: "host", events: [{ id: "x.fired", description: "X." }] },
			{ ambient: true },
		);
		assert.match(out, /declare global \{/);
		assert.match(out, /interface XriptEvents \{/);
	});
});

describe("event subscription surface", () => {
	const manifest = {
		xript: "0.3",
		name: "host",
		types: { SaveInfo: { description: "Save info.", fields: { path: { type: "string" } } } },
		events: [
			{ id: "document.saved", description: "Fired after a save.", payload: "SaveInfo" },
			{ id: "selection.changed", description: "Selection changed." },
		],
	};

	it("emits a typed events global with on/subscribe over the event id union (ambient)", () => {
		const out = generateTypes(manifest, { ambient: true });
		assert.match(out, /namespace events \{/);
		assert.match(out, /function on<K extends XriptEventId>\(id: K, handler: \(payload: XriptEvents\[K\]\) => void\): void;/);
		assert.match(out, /function subscribe<K extends XriptEventId>\(id: K, handler: \(payload: XriptEvents\[K\]\) => void\): void;/);
	});

	it("declares the events global in non-ambient mode", () => {
		const out = generateTypes(manifest);
		assert.match(out, /declare namespace events \{/);
	});

	it("surfaces an event's subscription capability in the catalog JSDoc", () => {
		const out = generateTypes({
			xript: "0.3",
			name: "host",
			events: [{ id: "world.changed", description: "World changed.", capability: "read:world" }],
		});
		assert.match(out, /Requires capability: `read:world`/);
	});

	it("omits the events global when no events are declared", () => {
		const out = generateTypes({ xript: "0.3", name: "host" });
		assert.ok(!out.includes("namespace events"));
	});
});

describe("capability typing surface", () => {
	const manifest = {
		xript: "0.3",
		name: "host",
		capabilities: {
			"modify-state": { description: "x", risk: "medium" },
			"run.command": { description: "y" },
		},
	};

	it("emits a Capability scope union of declared keys", () => {
		const out = generateTypes(manifest);
		assert.match(out, /type Capability = "modify-state" \| "run\.command";/);
	});

	it("emits an open CapabilityRef permitting read:/write: prefixes", () => {
		const out = generateTypes(manifest);
		assert.match(out, /type CapabilityRef = \(/);
		assert.match(out, /"read:modify-state"/);
		assert.match(out, /"write:run\.command"/);
		assert.match(out, /\| \(string & \{\}\)/);
	});

	it("emits capability types inside the global block in ambient mode", () => {
		const out = generateTypes(manifest, { ambient: true });
		assert.match(out, /declare global \{/);
		assert.match(out, /\ttype Capability =/);
		assert.match(out, /\ttype CapabilityRef =/);
	});

	it("omits capability types when none are declared", () => {
		const out = generateTypes({ xript: "0.3", name: "host" });
		assert.ok(!out.includes("type Capability"));
		assert.ok(!out.includes("type CapabilityRef"));
	});
});

describe("fragment fill handlers", () => {
	it("emits a FragmentHandlers entry from the preferred handlers array", () => {
		const result = generateTypes({
			xript: "0.3",
			name: "panel-mod",
			version: "1.0.0",
			fills: {
				"sidebar.left": [
					{
						id: "counter",
						format: "text/html",
						source: "panel.html",
						handlers: [{ selector: "#inc", on: "click", handler: "increment" }],
					},
				],
			},
		});
		assert.match(result, /interface FragmentHandlers \{/);
		assert.match(result, /"sidebar\.left::counter": \[\{ selector: "#inc"; on: "click"; handler: "increment" \}\];/);
	});

	it("reads the deprecated events alias when handlers is absent", () => {
		const result = generateTypes({
			xript: "0.3",
			name: "panel-mod",
			version: "1.0.0",
			fills: {
				"sidebar.left": [
					{ format: "text/html", source: "panel.html", events: [{ selector: "#inc", on: "click", handler: "increment" }] },
				],
			},
		});
		assert.match(result, /"sidebar\.left": \[\{ selector: "#inc"; on: "click"; handler: "increment" \}\];/);
		assert.match(result, /@deprecated|deprecated `events` key|Rename it to `handlers`/);
	});

	it("prefers handlers over events when both are present", () => {
		const result = generateTypes({
			xript: "0.3",
			name: "panel-mod",
			version: "1.0.0",
			fills: {
				"slot.a": [
					{
						handlers: [{ selector: ".win", on: "click", handler: "fromHandlers" }],
						events: [{ selector: ".lose", on: "click", handler: "fromEvents" }],
					},
				],
			},
		});
		assert.match(result, /handler: "fromHandlers"/);
		assert.ok(!result.includes("fromEvents"));
	});

	it("omits FragmentHandlers when no fill declares handlers", () => {
		const result = generateTypes({
			xript: "0.3",
			name: "panel-mod",
			version: "1.0.0",
			fills: { "slot.a": [{ format: "text/html", source: "p.html" }] },
		});
		assert.ok(!result.includes("FragmentHandlers"));
	});

	it("emits FragmentHandlers as a top-level section in ambient mode", () => {
		const out = generateTypes(
			{
				xript: "0.3",
				name: "panel-mod",
				version: "1.0.0",
				fills: { "slot.a": [{ handlers: [{ selector: "#x", on: "click", handler: "go" }] }] },
			},
			{ ambient: true },
		);
		assert.match(out, /interface FragmentHandlers \{/);
		assert.match(out, /handler: "go"/);
	});
});

describe("open enums", () => {
	it("appends (string & {}) to a named open enum type", () => {
		const result = generateTypes({
			xript: "0.3",
			name: "host",
			types: { ElementKind: { description: "Element kinds.", values: ["text", "image"], open: true } },
		});
		assert.match(result, /type ElementKind = "text" \| "image" \| \(string & \{\}\);/);
	});

	it("keeps a non-open enum closed", () => {
		const result = generateTypes({
			xript: "0.3",
			name: "host",
			types: { Closed: { description: "Closed.", values: ["a", "b"] } },
		});
		assert.match(result, /type Closed = "a" \| "b";/);
		assert.doesNotMatch(result, /Closed = "a" \| "b" \| \(string/);
	});

	it("appends (string & {}) to an inline open field enum", () => {
		const result = generateTypes({
			xript: "0.3",
			name: "host",
			types: {
				Cfg: { description: "Config.", fields: { kind: { type: "string", enum: ["text", "image"], open: true } } },
			},
		});
		assert.match(result, /kind: "text" \| "image" \| \(string & \{\}\);/);
	});

	it("carries open through a field referencing a named open enum", () => {
		const result = generateTypes({
			xript: "0.3",
			name: "host",
			types: {
				ElementKind: { description: "Kinds.", values: ["text", "image"], open: true },
				Cfg: { description: "Config.", fields: { kind: { type: "ElementKind" } } },
			},
		});
		assert.match(result, /kind: "text" \| "image" \| \(string & \{\}\);/);
	});
});
