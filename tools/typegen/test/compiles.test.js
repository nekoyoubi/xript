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
			const rendered = (generateTypes(manifestFor(testCase.ref)).match(/function f\(\): ([^;]+);/) || [])[1];
			assert.equal(rendered, testCase.typescript, testCase.name);
		});
	}
});
