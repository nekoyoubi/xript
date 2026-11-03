import { describe, it } from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";
import { generateTypes, generateAmbientTypes } from "../dist/index.js";

function typeCheck(source, fileName = "mod.ts") {
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
		.map((d) => `TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`);
}

const HOST = {
	xript: "0.10",
	name: "shared-host",
	bindings: {
		share: { description: "Opens a share sheet.", optional: true, params: [{ name: "text", type: "string" }] },
		web: { description: "Browser-only helpers.", optional: true, members: { open: { description: "Opens a URL." } } },
		net: {
			description: "Network helpers.",
			members: {
				fetch: { description: "Fetches.", optional: true, params: [{ name: "url", type: "string" }], returns: "string" },
				send: { description: "Sends." },
			},
		},
		clock: {
			description: "Live clock.",
			members: {
				now: { description: "The tick.", accessor: "get", type: "number" },
				speed: { description: "The speed.", accessor: "get-set", type: "number" },
				drift: { description: "Some hosts lack it.", accessor: "get", type: "number", optional: true },
			},
		},
		phase: { description: "Day phase.", accessor: "get", type: "string" },
	},
};

const ambient = generateAmbientTypes(HOST);
const withMod = (code) => `${ambient}\n${code}\nexport {};\n`;

describe("optional bindings and accessors in generated types", () => {
	it("the generated declarations type-check", () => {
		assert.deepEqual(typeCheck(generateTypes(HOST), "generated.d.ts"), []);
		assert.deepEqual(typeCheck(withMod("")), []);
	});

	it("rejects an unguarded call to an optional function", () => {
		assert.notDeepEqual(typeCheck(withMod('share("hi");')), []);
	});

	it("rejects an unguarded call to an optional member", () => {
		assert.notDeepEqual(typeCheck(withMod('net.fetch("x");')), []);
	});

	it("rejects unguarded use of an optional namespace", () => {
		assert.notDeepEqual(typeCheck(withMod("web.open();")), []);
	});

	it("accepts guarded use of optional bindings", () => {
		const code = [
			'if (share) share("hi");',
			'const body: string | undefined = net.fetch?.("x");',
			"if (web) web.open();",
			"net.send();",
			"const d: number | undefined = clock.drift;",
		].join("\n");
		assert.deepEqual(typeCheck(withMod(code)), []);
	});

	it("types a get accessor as a readonly value and a get-set accessor as writable", () => {
		assert.deepEqual(typeCheck(withMod("const t: number = clock.now; clock.speed = t * 2; const p: string = phase;")), []);
		assert.notDeepEqual(typeCheck(withMod("clock.now = 1;")), []);
		assert.notDeepEqual(typeCheck(withMod('phase = "night";')), []);
	});

	it("declares xript.has", () => {
		assert.deepEqual(typeCheck(withMod('const present: boolean = xript.has("net.fetch");')), []);
	});

	it("marks optional bindings in the doc comment", () => {
		assert.match(ambient, /Optional: a host may omit this/);
	});

	it("leaves a manifest without optional bindings or accessors on the namespace form", () => {
		const plain = generateTypes({
			xript: "0.10",
			name: "plain",
			bindings: { ns: { description: "Plain.", members: { go: { description: "Goes." } } } },
		});
		assert.match(plain, /declare namespace ns \{/);
		assert.match(plain, /function go\(\): void;/);
	});
});
