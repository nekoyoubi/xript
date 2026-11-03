import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateDocs } from "../dist/index.js";

const HOST = {
	xript: "0.10",
	name: "shared-host",
	capabilities: { "clock.admin": { description: "Administer the clock." } },
	bindings: {
		share: { description: "Opens a share sheet.", optional: true },
		web: { description: "Browser-only helpers.", optional: true, members: { open: { description: "Opens a URL." } } },
		net: {
			description: "Network helpers.",
			members: {
				fetch: { description: "Fetches.", optional: true },
				send: { description: "Sends." },
			},
		},
		clock: {
			description: "Live clock.",
			members: {
				now: { description: "The tick.", accessor: "get", type: "number" },
				speed: { description: "The speed.", accessor: "get-set", type: "number", capability: "clock.admin" },
			},
		},
		phase: { description: "Day phase.", accessor: "get", type: "string" },
	},
};

const pages = Object.fromEntries(generateDocs(HOST).pages.map((page) => [page.slug, page.content]));

describe("optional bindings and accessors in generated docs", () => {
	it("marks an optional function with its probe path", () => {
		assert.match(pages["bindings/share"], /\*\*Optional:\*\* a host may omit this/);
		assert.match(pages["bindings/share"], /xript\.has\("share"\)/);
	});

	it("marks an optional namespace and an optional member", () => {
		assert.match(pages["bindings/web"], /\*\*Optional:\*\*/);
		assert.match(pages["bindings/net"], /xript\.has\("net\.fetch"\)/);
		assert.doesNotMatch(pages["bindings/net"].split("### net.send()")[1], /\*\*Optional:\*\*/);
	});

	it("documents a namespace accessor as a live value", () => {
		const clock = pages["bindings/clock"];
		assert.match(clock, /### clock\.now\n/);
		assert.match(clock, /readonly now: number/);
		assert.match(clock, /Read-only: assigning throws a `TypeError`/);
		assert.match(clock, /\nspeed: number\n/);
		assert.match(clock, /every assignment hands the new value to the host/);
	});

	it("gives a top-level accessor its own page and an index entry", () => {
		assert.match(pages["bindings/phase"], /readonly phase: string/);
		assert.match(pages.index, /### Global Values\n\n- \[`phase`\]/);
	});

	it("labels a gated accessor without call parentheses", () => {
		assert.match(pages.index + Object.values(pages).join("\n"), /`clock\.speed`/);
	});

	it("leaves a manifest without the new fields unchanged in shape", () => {
		const plain = Object.fromEntries(
			generateDocs({ xript: "0.10", name: "plain", bindings: { go: { description: "Goes." } } }).pages.map((p) => [p.slug, p.content]),
		);
		assert.doesNotMatch(plain["bindings/go"], /Optional/);
		assert.doesNotMatch(plain.index, /Global Values/);
	});
});
