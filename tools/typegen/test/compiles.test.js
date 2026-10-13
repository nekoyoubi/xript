import { describe, it } from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";
import { readFileSync } from "node:fs";
import { generateTypes, generateAmbientTypes } from "../dist/index.js";

/**
 * Type-checks generated output the way an adopter's compiler does.
 *
 * Nothing had ever compiled what typegen emits, which is how a manifest naming a type it never
 * declared produced a declaration file failing with `Cannot find name`. The generator resolves an
 * unknown name to itself, so a bad manifest becomes bad TypeScript, silently.
 */
function typeCheck(source, fileName = "generated.d.ts") {
	const host = {
		getSourceFile: (name, target) =>
			name === fileName ? ts.createSourceFile(name, source, target, true) : defaultLib(name, target),
		writeFile: () => {},
		getDefaultLibFileName: () => ts.getDefaultLibFilePath({ target: ts.ScriptTarget.ES2022 }),
		useCaseSensitiveFileNames: () => false,
		getCanonicalFileName: (n) => n,
		getCurrentDirectory: () => "",
		getNewLine: () => "\n",
		fileExists: (n) => n === fileName || ts.sys.fileExists(n),
		readFile: (n) => (n === fileName ? source : ts.sys.readFile(n)),
	};
	function defaultLib(name, target) {
		const text = ts.sys.readFile(name);
		return text === undefined ? undefined : ts.createSourceFile(name, text, target, true);
	}

	const program = ts.createProgram([fileName], { strict: true, noEmit: true, target: ts.ScriptTarget.ES2022 }, host);
	return ts.getPreEmitDiagnostics(program)
		.filter((d) => d.file?.fileName === fileName)
		.map((d) => {
			const { line } = d.file.getLineAndCharacterOfPosition(d.start);
			return `${line + 1}: TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`;
		});
}

const HOST = {
	xript: "0.8",
	name: "typed-host",
	capabilities: { ui: { description: "UI." }, net: { description: "Net." } },
	types: {
		Player: {
			description: "A player.",
			fields: {
				name: { type: "string", description: "Name." },
				hp: { type: "number", description: "Health." },
				friends: { type: "Player[]", description: "Friends.", optional: true },
			},
		},
		Mode: { description: "A mode.", values: ["fast", "slow"] },
	},
	bindings: {
		log: { description: "Logs.", params: [{ name: "m", type: "string" }] },
		getPlayer: { description: "Reads a player.", params: [], returns: "Player" },
		pick: { description: "Union return.", params: [], returns: { union: ["Player", "Mode"] } },
		listing: { description: "Array return.", params: [], returns: { array: "Player" } },
		net: {
			description: "Net namespace.",
			members: {
				fetch: {
					description: "Fetches.",
					capability: "net",
					async: true,
					params: [{ name: "url", type: "string" }],
					returns: "string",
				},
			},
		},
	},
	hooks: { onSave: { description: "Fires on save.", params: [{ name: "doc", type: "Player" }] } },
	events: [{ id: "app.ready", description: "Ready.", payload: "Player" }],
	slots: [{ id: "panel", accepts: ["text/html"], description: "Panel.", capability: "ui" }],
};

describe("generated declarations compile", () => {
	it("the host-facing types type-check", () => {
		assert.deepEqual(typeCheck(generateTypes(HOST)), []);
	});

	it("the ambient mod surface type-checks", () => {
		assert.deepEqual(typeCheck(generateAmbientTypes(HOST)), []);
	});

	it("a mod's ambient surface against its host type-checks", () => {
		const mod = {
			xript: "0.8",
			name: "panel-mod",
			version: "1.0.0",
			entry: { script: "dist/mod.js", format: "module", exports: { go: { description: "Goes.", returns: "Player" } } },
			fills: { panel: [{ id: "p", format: "text/html", source: "p.html" }] },
		};
		assert.deepEqual(typeCheck(generateAmbientTypes(mod, { host: HOST })), []);
	});
});

describe("JSDoc comment safety", () => {
	// A `*/` in a description closed the generated JSDoc block early and spilled the rest as code,
	// breaking the whole declaration file. Every free-text field must be neutralized.
	it("a description containing */ does not break the declaration file", () => {
		const manifest = {
			xript: "0.8",
			name: "jsdoc",
			capabilities: { c: { description: "cap */ desc" } },
			bindings: {
				f: {
					description: "closes the comment */ then injects code",
					capability: "c",
					params: [{ name: "x", type: "string", description: "param */ desc" }],
					returns: "string",
				},
			},
		};
		const out = generateTypes(manifest);
		assert.doesNotMatch(out, /\*\/ then injects/, "the raw */ sequence must not survive in the output");
		assert.deepEqual(typeCheck(out), []);
	});
});

describe("array element precedence", () => {
	// `{ array: { union: [...] } }` emitted `string | number[]`, which TypeScript reads as
	// `string | (number[])` — a union with an array, not an array of a union. It compiled, which
	// is exactly what made it worse than a syntax error: the wrong type, silently.
	const withReturn = (returns) => ({
		xript: "0.8",
		name: "h",
		types: { Player: { description: "P.", fields: {} } },
		bindings: { f: { description: "F.", params: [], returns } },
	});
	const signatureOf = (manifest) => {
		const line = generateTypes(manifest)
			.split(/\r?\n/)
			.find((l) => l.includes("function f("));
		return line.trim();
	};

	it("parenthesises a union before appending []", () => {
		assert.match(signatureOf(withReturn({ array: { union: ["string", "number"] } })), /\(string \| number\)\[\]/);
	});

	it("leaves a plain element type alone", () => {
		// the call's own parens are part of the signature, so assert on the return type only
		assert.match(signatureOf(withReturn({ array: "Player" })), /\): Player\[\];/);
	});

	it("keeps a bare union unparenthesised", () => {
		assert.match(signatureOf(withReturn({ union: ["string", "number"] })), /string \| number/);
	});

	it("emits a type that still compiles", () => {
		assert.deepEqual(typeCheck(generateTypes(withReturn({ array: { union: ["string", "Player"] } }))), []);
	});
});

describe("fragment vocabulary types", () => {
	// A host declaring a fragment vocabulary. Two formats share one named vocabulary, so its node
	// types must be emitted once, not once per format. Every children constraint is exercised:
	// `Panel` leaves it undeclared (defaults to `any`, open nesting), `Link` takes text, `Progress`
	// is childless, `Tabs` allows only a named set.
	const VOCAB_HOST = {
		xript: "0.8",
		name: "vocab-host",
		slots: [{ id: "sidebar", accepts: ["application/x-widget+json"] }],
		vocabularies: {
			"widget.kit": {
				description: "The widget set.",
				nodes: {
					Panel: { description: "A container.", props: { heading: { type: "string" }, collapsible: { type: "boolean" } } },
					Link: { children: "text", props: { href: { type: "string", sink: "uri" } } },
					Progress: { children: "none", props: { value: { type: "number" }, tone: { type: "string", enum: ["ok", "warn"] } } },
					Tabs: { children: ["Panel", "Link"], props: { active: { type: "number" } } },
				},
			},
		},
		formats: {
			"application/x-widget+json": { syntax: "j5ml", vocabularies: ["widget.kit"] },
			"text/x-widget-html": { syntax: "html", vocabularies: ["widget.kit", "html"] },
		},
	};
	const usage = (code) => `${generateTypes(VOCAB_HOST)}\n${code}\n`;

	it("emits valid declarations", () => {
		assert.deepEqual(typeCheck(generateTypes(VOCAB_HOST)), []);
	});

	it("carries the vocabulary into the ambient mod surface", () => {
		const ambient = generateAmbientTypes(VOCAB_HOST);
		assert.match(ambient, /type WidgetKitNode =/);
		assert.deepEqual(typeCheck(ambient), []);
	});

	it("types a shared vocabulary once, not once per format", () => {
		const out = generateTypes(VOCAB_HOST);
		assert.equal(out.match(/type WidgetKitNode =/g).length, 1);
	});

	it("shapes each node's children rest from its declared constraint", () => {
		const out = generateTypes(VOCAB_HOST);
		// undeclared children -> `any`: open nesting over the union plus text
		assert.match(out, /type WidgetKitPanelNode = \["Panel", WidgetKitPanelProps, \.\.\.\(WidgetKitNode \| string\)\[\]\];/);
		assert.match(out, /type WidgetKitLinkNode = \["Link", WidgetKitLinkProps, \.\.\.string\[\]\];/);
		assert.match(out, /type WidgetKitProgressNode = \["Progress", WidgetKitProgressProps\];/);
		assert.match(out, /type WidgetKitTabsNode = \["Tabs", WidgetKitTabsProps, \.\.\.\(WidgetKitPanelNode \| WidgetKitLinkNode\)\[\]\];/);
	});

	it("accepts an open-nested tree of mixed children to any depth", () => {
		const tree = usage(`const tree: WidgetKitNode = ["Panel", { heading: "Root", collapsible: true },
			["Link", { href: "https://x" }, "click"],
			["Progress", { value: 40, tone: "warn" }],
			["Panel", {}, ["Link", { href: "/deep" }, "nested"], "loose text"],
		]; void tree;`);
		assert.deepEqual(typeCheck(tree, "generated.ts"), []);
	});

	it("rejects a mistyped prop", () => {
		const bad = usage(`const a: WidgetKitPanelNode = ["Panel", { collapsible: "yes" }]; void a;`);
		assert.ok(typeCheck(bad, "generated.ts").length > 0);
	});

	it("rejects a child on a childless node", () => {
		const bad = usage(`const a: WidgetKitProgressNode = ["Progress", { value: 1 }, "child"]; void a;`);
		assert.ok(typeCheck(bad, "generated.ts").length > 0);
	});

	it("rejects a child outside a node's allow-list", () => {
		const bad = usage(`const a: WidgetKitTabsNode = ["Tabs", { active: 0 }, ["Progress", { value: 1 }]]; void a;`);
		assert.ok(typeCheck(bad, "generated.ts").length > 0);
	});

	it("rejects an enum value outside the declared set", () => {
		const bad = usage(`const a: WidgetKitProgressNode = ["Progress", { value: 1, tone: "purple" }]; void a;`);
		assert.ok(typeCheck(bad, "generated.ts").length > 0);
	});

	it("emits nothing for a host with no declared formats", () => {
		const plain = { xript: "0.8", name: "plain", slots: [{ id: "s", accepts: ["text/html"] }] };
		assert.doesNotMatch(generateTypes(plain), /vocabulary/);
	});

	it("does not let a node redeclare a protocol prop with an incompatible type", () => {
		// `id`/`data-bind`/`data-if` are always strings the sanitizer enforces; the protocol
		// interface types them. A node declaring `id: number` must not emit an override that
		// illegally narrows the inherited `id?: string`.
		const host = {
			xript: "0.8",
			name: "protocol-host",
			slots: [{ id: "s", accepts: ["application/x-p+json"] }],
			formats: {
				"application/x-p+json": {
					syntax: "j5ml",
					nodes: { Widget: { children: "none", props: { id: { type: "number" }, "data-if": { type: "number" }, label: { type: "string" } } } },
				},
			},
		};
		const out = generateTypes(host);
		assert.deepEqual(typeCheck(out), []);
		// the node's real prop survives; the protocol names are inherited, not re-emitted
		assert.match(out, /label\?: string;/);
		assert.doesNotMatch(out, /id\?: number;/);
	});

	it("types data-each and data-key as protocol props on every node", () => {
		const host = {
			xript: "0.8",
			name: "repeat-host",
			slots: [{ id: "s", accepts: ["application/x-r+json"] }],
			formats: {
				"application/x-r+json": {
					syntax: "j5ml",
					nodes: { Row: { props: { label: { type: "string" } } } },
				},
			},
		};
		const out = generateTypes(host);
		assert.deepEqual(typeCheck(out), []);
		assert.match(out, /"data-each"\?: string;/);
		assert.match(out, /"data-key"\?: string;/);
	});

	it("keeps type identifiers unique when node names pascal-case alike", () => {
		// `my-widget` and `my_widget` both pascal-case to `MyWidget`; a node named `Node` would
		// otherwise collide its props with the vocabulary protocol interface. All three must emit
		// distinct identifiers, and the tuple literals must keep the original names.
		const host = {
			xript: "0.8",
			name: "collision-host",
			slots: [{ id: "s", accepts: ["application/x-c+json"] }],
			formats: {
				"application/x-c+json": {
					syntax: "j5ml",
					nodes: {
						"my-widget": { children: "none", props: { a: { type: "string" } } },
						my_widget: { children: "none", props: { b: { type: "number" } } },
						Node: { children: "none", props: { c: { type: "string" } } },
					},
				},
			},
		};
		const out = generateTypes(host);
		assert.deepEqual(typeCheck(out), []);
		// the literals still name the real nodes, not the disambiguated identifiers
		assert.match(out, /\["my-widget",/);
		assert.match(out, /\["my_widget",/);
		assert.match(out, /\["Node",/);
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
			const out = generateTypes(manifestFor(testCase.ref));
			const rendered = (out.match(/function f\(\): (.+);$/m) || [])[1];
			assert.equal(rendered, testCase.typescript, testCase.name);
			assert.deepEqual(typeCheck(out), [], `${testCase.name} type-checks`);
		});
	}

	it("compiles every corpus case as a declaration", () => {
		const bindings = Object.fromEntries(
			corpus.cases.map((testCase, i) => [`f${i}`, { description: "F.", params: [], returns: testCase.ref }]),
		);
		assert.deepEqual(typeCheck(generateTypes({ ...base, bindings })), []);
	});
});

describe("function parameters", () => {
	const corpus = JSON.parse(readFileSync(new URL("../../../spec/callback-tests.json", import.meta.url), "utf-8"));

	it("types callback parameters and compiles", () => {
		const output = generateTypes(corpus.manifest);
		assert.match(output, /function typed\(fn: \(\.\.\.args: any\[\]\) => any\): void;/);
		assert.match(output, /function typedOptional\(fn: \(\(\.\.\.args: any\[\]\) => any\) \| undefined\): void;/);
		assert.match(output, /function typedSignature\(test: \(cell: number\) => boolean\): void;/);
		assert.deepEqual(typeCheck(output), []);
	});
});

/**
 * One manifest exercising every shape that once produced a declaration file that does not parse
 * or silently means something else: reserved words as binding, namespace, member, hook, phase and
 * parameter names; non-identifier names; every accepted type word; string unions mixing arrays;
 * variadic parameters; the `optional` alias; an optional parameter before a required one; and the
 * `{ type, description }` return form.
 */
const STRESS = {
	xript: "0.9",
	name: "stress-host",
	capabilities: { fs: { description: "Files." } },
	types: {
		Item: {
			description: "An item.",
			fields: {
				"display-name": { type: "string", description: "Hyphenated field." },
				count: { type: "int" },
				tags: { type: "string[]?" },
				meta: { type: "object" },
				callback: { type: "function", optional: true },
			},
		},
		Kind: { description: "A kind.", values: ["a", "b"] },
	},
	bindings: {
		if: { description: "A reserved top-level function.", params: [{ name: "cond", type: "bool" }], returns: "bool" },
		delete: {
			description: "A reserved top-level namespace.",
			members: { all: { description: "Deletes all.", params: [] } },
		},
		"my-tool": { description: "A non-identifier binding.", params: [{ name: "x", type: "int" }] },
		class: { description: "Another reserved name.", params: [] },
		fs: {
			description: "A namespace with reserved members.",
			members: {
				delete: { description: "Removes a path.", capability: "fs", params: [{ name: "path", type: "string" }] },
				new: { description: "Creates.", params: [{ name: "class", type: "string" }] },
				nested: {
					description: "Nested namespace.",
					members: { return: { description: "Reserved nested member.", params: [], returns: "array" } },
				},
			},
		},
		ok: {
			description: "A clean namespace.",
			members: { read: { description: "Reads.", params: [{ name: "p", type: "string" }], returns: "string" } },
		},
		log: {
			description: "Variadic logger.",
			params: [
				{ name: "level", type: "string" },
				{ name: "args", type: "string | number[]", variadic: true },
			],
		},
		sum: {
			description: "Variadic numbers.",
			params: [{ name: "values", type: "float", variadic: true }],
			returns: { type: "number", description: "The total." },
		},
		pick: {
			description: "Optional before required.",
			params: [
				{ name: "a", type: "string", optional: true },
				{ name: "b", type: "Item" },
				{ name: "c", type: "Kind", required: false },
			],
			returns: { type: "Item?", description: "The picked item, if any." },
		},
		call: {
			description: "Takes functions.",
			params: [
				{ name: "fns", type: "function[]" },
				{ name: "either", type: { union: ["function", "integer"] } },
				{ name: "grid", type: "(int | bool)[][]" },
				{ name: "map", type: { map: "array" } },
				{ name: "default", type: "unknown", default: null },
			],
			returns: "any",
		},
	},
	hooks: {
		"on-save": { description: "Non-identifier hook.", params: [{ name: "item", type: "Item" }] },
		switch: { description: "Reserved hook name.", phases: ["pre", "post"], params: [{ name: "rest", type: "int", variadic: true }] },
		ready: { description: "Plain hook.", params: [] },
	},
	slots: [{ id: "panel", accepts: ["text/html"], description: "Panel.", capability: "fs" }],
};

describe("stress manifest", () => {
	it("generates host-facing types that type-check", () => {
		assert.deepEqual(typeCheck(generateTypes(STRESS)), []);
	});

	it("generates ambient types that type-check", () => {
		assert.deepEqual(typeCheck(generateAmbientTypes(STRESS)), []);
	});

	it("emits reserved and non-identifier names in shapes that still carry their types", () => {
		const out = generateTypes(STRESS);
		assert.match(out, /interface XriptGlobals \{/);
		assert.match(out, /\tif\(cond: boolean\): boolean;/);
		assert.match(out, /\t"my-tool"\(x: number\): void;/);
		assert.match(out, /declare const fs: \{/);
		assert.match(out, /\tdelete\(path: string\): void;/);
		assert.match(out, /\tnew\(class_: string\): void;/);
		assert.match(out, /declare namespace ok \{/);
		assert.match(out, /declare const hooks: \{/);
		assert.match(out, /\t"on-save"\(handler: \(item: Item\) => void\): void;/);
		assert.match(out, /\tswitch: \{/);
	});

	it("renders variadic parameters as rest parameters", () => {
		const out = generateTypes(STRESS);
		assert.match(out, /declare function log\(level: string, \.\.\.args: \(string \| number\[\]\)\[\]\): void;/);
		assert.match(out, /declare function sum\(\.\.\.values: number\[\]\): number;/);
	});

	it("keeps an optional parameter that a required one follows as an explicit undefined", () => {
		assert.match(generateTypes(STRESS), /declare function pick\(a: string \| undefined, b: Item, c\?: Kind\): Item \| undefined;/);
	});

	it("writes no em-dash into generated output", () => {
		for (const out of [generateTypes(STRESS, { intent: true, includeGrantShapes: true }), generateAmbientTypes(STRESS)]) {
			assert.ok(!out.includes("—"), "generated output contains U+2014");
		}
	});

	it("carries a return description into @returns", () => {
		const out = generateTypes(STRESS);
		assert.match(out, /@returns The total\./);
		assert.match(out, /@returns The picked item, if any\./);
	});

	it("passes the real TypeScript compiler with --noEmit", async () => {
		const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
		const { join } = await import("node:path");
		const { tmpdir } = await import("node:os");
		const { spawnSync } = await import("node:child_process");
		const { createRequire } = await import("node:module");
		const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
		const dir = mkdtempSync(join(tmpdir(), "xript-typegen-"));
		try {
			writeFileSync(join(dir, "host.d.ts"), generateTypes(STRESS));
			writeFileSync(join(dir, "ambient.d.ts"), generateAmbientTypes(STRESS));
			const run = (file) => {
				const project = join(dir, `${file}.tsconfig.json`);
				writeFileSync(
					project,
					JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: "ES2022", types: [] }, files: [file] }),
				);
				return spawnSync(process.execPath, [tsc, "--noEmit", "-p", project], { encoding: "utf-8" });
			};
			for (const file of ["host.d.ts", "ambient.d.ts"]) {
				const result = run(file);
				assert.equal(result.status, 0, `${file}: ${result.stdout}${result.stderr}`);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
