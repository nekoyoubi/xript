import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scoreManifests } from "../dist/index.js";

const host = {
	xript: "0.3",
	name: "scored-host",
	slots: [
		{ id: "used", accepts: ["text/html"], capability: "capUsed", multiple: false },
		{ id: "dead", accepts: ["text/html"], capability: "capUsed", multiple: false },
	],
	capabilities: { capUsed: { description: "Used cap." }, capVestigial: { description: "Unused cap." } },
};

const mod = {
	xript: "0.3",
	name: "m",
	version: "1.0.0",
	capabilities: ["capUsed"],
	fragments: [{ id: "f", slot: "used", format: "text/html", source: "f.html" }],
};

describe("scoreManifests", () => {
	it("computes slot utilization and flags dead slots", async () => {
		const result = await scoreManifests(host, [mod]);
		assert.equal(result.slots.score, 0.5);
		assert.deepEqual(result.slots.used, ["used"]);
		assert.deepEqual(result.slots.unused, ["dead"]);
	});

	it("computes capability utilization and flags vestigial capabilities", async () => {
		const result = await scoreManifests(host, [mod]);
		assert.equal(result.capabilities.score, 0.5);
		assert.deepEqual(result.capabilities.unused, ["capVestigial"]);
	});

	it("rolls up the headline as moddability capacity, not mod coverage", async () => {
		const result = await scoreManifests(host, [mod]);
		// host exposes 2 of the 4 surfaces (slots, capabilities); none of how many
		// slots the mod fills affects this.
		assert.equal(result.headline, 50);
		assert.deepEqual(result.capacity.exposed.sort(), ["capabilities", "slots"]);
		assert.deepEqual(result.capacity.absent.sort(), ["bindings", "events"]);
	});

	it("headline does not move when slots go unfilled", async () => {
		const filled = await scoreManifests(host, [mod]);
		const empty = await scoreManifests(host, []);
		assert.equal(filled.headline, empty.headline);
	});

	it("excludes reserved and inherited surface from the informational coverage", async () => {
		const extendsHost = {
			xript: "0.6",
			name: "extends-host",
			slots: [
				{ id: "own", accepts: ["text/html"], capability: "ui" },
				{ id: "future", accepts: ["text/html"], capability: "ui", reserved: true },
				{ id: "inherited", accepts: ["application/json"], capability: "ui" },
			],
			capabilities: { ui: { description: "UI." }, audit: { description: "Audit.", reserved: true } },
		};
		const result = await scoreManifests(extendsHost, [], { inheritedSlots: ["inherited"], inheritedCapabilities: [] });
		// only `own` is local + non-reserved; `future` is reserved, `inherited` came from extends
		assert.deepEqual(result.slots.unused, ["own"]);
		assert.equal(result.slots.score, 0);
		// `ui` is referenced by the slot gates (used); `audit` is reserved → neither is vestigial
		assert.deepEqual(result.capabilities.unused, []);
		assert.ok(!result.capabilities.unused.includes("audit"));
	});

	it("passes integrity for a consistent host and mod", async () => {
		const result = await scoreManifests(host, [mod]);
		assert.equal(result.integrity.passed, true);
	});

	it("flags a slot referencing an undeclared capability as an integrity violation", async () => {
		const badHost = {
			xript: "0.3",
			name: "bad-host",
			slots: [{ id: "s", accepts: ["text/html"], capability: "ghost", multiple: false }],
			capabilities: {},
		};
		const result = await scoreManifests(badHost, []);
		assert.equal(result.integrity.passed, false);
		assert.ok(result.integrity.violations.some((v) => /undeclared capability "ghost"/.test(v)));
	});

	it("gates on the min threshold and on integrity", async () => {
		const above = await scoreManifests(host, [mod], { min: 60 });
		assert.equal(above.gate.passed, false);
		const below = await scoreManifests(host, [mod], { min: 40 });
		assert.equal(below.gate.passed, true);
	});

	it("carries a disclaimer about what it does not prove", async () => {
		const result = await scoreManifests(host, [mod]);
		assert.match(result.disclaimer, /does not prove/i);
	});
});
