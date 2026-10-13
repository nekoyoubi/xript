import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateDocs } from "../dist/index.js";

const host = {
	xript: "0.8",
	name: "intent-host",
	bindings: {
		getTick: { description: "Reads the tick.", execution: { duration: "instant" } },
		net: {
			description: "Network.",
			members: { fetch: { description: "Fetches.", async: true, execution: { duration: "long" } } },
		},
	},
	hooks: { onSave: { description: "Fires on save.", execution: { duration: "unbounded" } } },
	slots: [{ id: "sidebar.left", accepts: ["text/html"], description: "Left rail.", execution: { affinity: "pinned" } }],
};

const mod = {
	xript: "0.8",
	name: "intent-mod",
	version: "1.0.0",
	entry: { script: "main.js", exports: { crunch: { description: "Crunches.", execution: { duration: "long" } } } },
};

const pageFor = (manifest, slug) => generateDocs(manifest).pages.find((page) => page.slug === slug);

describe("docgen — declared execution intent", () => {
	it("adds an Execution section carrying the host-binding thread contract", () => {
		const index = pageFor(host, "index");
		assert.match(index.content, /## Execution/);
		assert.match(index.content, /host bindings are invoked concurrently from multiple worker threads/);
		assert.match(index.content, /MUST be reentrant and thread-safe/);
	});

	it("states what intent is not, in the preamble", () => {
		const index = pageFor(host, "index");
		assert.match(index.content, /it is not `limits`, which is enforcement/);
		assert.match(index.content, /it is not a capability/);
		assert.match(index.content, /declares the SHAPE of the value a host binding returns, not the cost of the call/);
		assert.match(index.content, /bounds SCRIPT execution, not host-binding execution/);
	});

	it("tables every surface with its resolved duration and affinity", () => {
		const index = pageFor(host, "index");
		assert.match(index.content, /\| `getTick` \| binding \| `instant` \| `any` \| Yes \|/);
		assert.match(index.content, /\| `net\.fetch` \| binding \| `long` \| `any` \| Yes \|/);
		assert.match(index.content, /\| `onSave` \| hook \| `unbounded` \| `any` \| Yes \|/);
		assert.match(index.content, /\| `sidebar\.left` \| slot \| `brief` \| `pinned` \| Yes \|/);
	});

	it("marks an inherited intent as inherited rather than declared", () => {
		const index = pageFor(
			{ xript: "0.8", name: "defaulted", execution: { duration: "long" }, bindings: { grind: { description: "Grinds." } } },
			"index",
		);
		assert.match(index.content, /\| `grind` \| binding \| `long` \| `any` \| inherited \|/);
	});

	it("omits the section entirely for a manifest that declares no intent", () => {
		const index = pageFor({ xript: "0.8", name: "plain", bindings: { f: { description: "F." } } }, "index");
		assert.equal(/## Execution/.test(index.content), false);
	});

	it("adds an Execution column to the slots table only when a slot declares intent", () => {
		assert.match(pageFor(host, "index").content, /\| Slot \| Accepts \| Multiple \| Style \| Capability \| Execution \|/);
		const plain = pageFor(
			{ xript: "0.8", name: "plain", slots: [{ id: "a", accepts: ["text/html"], description: "A." }] },
			"index",
		);
		assert.match(plain.content, /\| Slot \| Accepts \| Multiple \| Style \| Capability \|\s*$/m);
	});

	it("notes execution on a binding page, with both unconditional remarks", () => {
		const page = pageFor(host, "bindings/net");
		assert.match(page.content, /\*\*Execution:\*\* `duration: long`/);
		assert.match(page.content, /`async` declares the SHAPE of the value/);
		assert.match(page.content, /bounds SCRIPT execution, not host-binding execution/);
	});

	it("notes execution on a hook page", () => {
		const page = pageFor(host, "hooks/onSave");
		assert.match(page.content, /\*\*Execution:\*\* `duration: unbounded`/);
	});

	it("tables a mod's exports with an Execution column", () => {
		const index = pageFor(mod, "index");
		assert.match(index.content, /## Exports/);
		assert.match(index.content, /\| Export \| Capability \| Execution \| Description \|/);
		assert.match(index.content, /\| `crunch` \| - \| `long` \/ `any` \| Crunches\. \|/);
		assert.match(index.content, /a host routes on the wider of the two/);
	});
});
