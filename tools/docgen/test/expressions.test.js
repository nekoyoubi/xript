import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateDocs } from "../dist/index.js";
import { EXPRESSION_REFERENCE } from "@xriptjs/validate";

const host = (overrides = {}) => ({
	xript: "0.10",
	name: "expr-host",
	...overrides,
});

const index = (manifest) => generateDocs(manifest).pages.find((page) => page.slug === "index").content;

describe("docgen: Expressions section", () => {
	it("appears when a slot takes a built-in fragment format", () => {
		const content = index(host({ slots: [{ id: "sidebar", accepts: ["text/html"] }] }));
		assert.match(content, /^## Expressions$/m);
		assert.match(content, /Fragments filled into `sidebar`/);
	});

	it("appears when a slot takes a format the host declares", () => {
		const content = index(host({
			formats: { "application/x-card+json": { syntax: "j5ml", vocabularies: ["html"] } },
			slots: [{ id: "cards", accepts: ["application/x-card+json"] }],
		}));
		assert.match(content, /^## Expressions$/m);
		assert.match(content, /`cards`/);
	});

	it("is absent when no slot takes fragments", () => {
		assert.doesNotMatch(index(host({ slots: [{ id: "on-save", accepts: ["application/x-xript-hook"] }] })), /^## Expressions$/m);
		assert.doesNotMatch(index(host()), /^## Expressions$/m);
	});

	it("lists every builtin from the reference with its signature", () => {
		const content = index(host({ slots: [{ id: "panel", accepts: ["application/jsml+json"] }] }));
		for (const builtin of EXPRESSION_REFERENCE.builtins) {
			assert.ok(content.includes(`| \`${builtin.name}\` | \`${builtin.name}(`), `missing builtin ${builtin.name}`);
		}
		assert.ok(content.includes('`pad(s: string, width: number, fill?: string = " "): string \\| null`'));
		assert.ok(content.includes("`min(...values: number): number \\| null`"));
	});

	it("lists the operators highest precedence first, with pipes escaped for the table", () => {
		const content = index(host({ slots: [{ id: "panel", accepts: ["text/html"] }] }));
		const section = content.slice(content.indexOf("### Operators"), content.indexOf("### Rules"));
		const precedences = [...section.matchAll(/^\| (\d+) \|/gm)].map((match) => Number(match[1]));
		assert.equal(precedences.length, EXPRESSION_REFERENCE.operators.length);
		assert.deepEqual(precedences, [...precedences].sort((a, b) => b - a));
		assert.ok(section.includes("`\\|\\|` logical or"));
	});

	it("lists the attributes that carry expressions and the rules", () => {
		const content = index(host({ slots: [{ id: "panel", accepts: ["text/html"] }] }));
		for (const attr of EXPRESSION_REFERENCE.attributes) assert.ok(content.includes(`| \`${attr.name}\` |`), `missing ${attr.name}`);
		for (const rule of EXPRESSION_REFERENCE.rules) assert.ok(content.includes(`**${rule.title}.**`), `missing rule ${rule.id}`);
		assert.match(content, /`\$index` is in scope inside every `data-each` copy/);
	});
});
