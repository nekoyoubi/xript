import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scoreManifests } from "../dist/index.js";

const host = {
	xript: "0.3",
	name: "scored-host",
	slots: [
		{ id: "used", accepts: ["text/html"], capability: "cap-used", multiple: false },
		{ id: "dead", accepts: ["text/html"], capability: "cap-used", multiple: false },
	],
	capabilities: { "cap-used": { description: "Used cap." }, "cap-vestigial": { description: "Unused cap." } },
};

const mod = {
	xript: "0.3",
	name: "m",
	version: "1.0.0",
	capabilities: ["cap-used"],
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
		assert.deepEqual(result.capabilities.unused, ["cap-vestigial"]);
	});

	it("rolls up the headline as moddability capacity, not mod coverage", async () => {
		const result = await scoreManifests(host, [mod]);
		// host exposes 2 of the 5 surfaces (slots, capabilities) and declares intent on
		// none of its 2 slots, so the composite is 2/6; none of how many slots the mod
		// fills affects this.
		assert.equal(result.headline, 33);
		assert.deepEqual(result.capacity.exposed.sort(), ["capabilities", "slots"]);
		assert.deepEqual(result.capacity.absent.sort(), ["bindings", "events", "libraries"]);
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
		const below = await scoreManifests(host, [mod], { min: 33 });
		assert.equal(below.gate.passed, true);
	});

	it("scores declared-intent coverage over bindings, hooks and slots", async () => {
		const intentHost = {
			xript: "0.8",
			name: "intent-host",
			bindings: {
				now: { description: "Ticks.", execution: { duration: "instant" } },
				fetch: { description: "Fetches." },
			},
			slots: [{ id: "panel", accepts: ["text/html"], execution: { duration: "long" } }],
		};
		const result = await scoreManifests(intentHost, []);
		assert.equal(result.intent.score, 2 / 3);
		assert.deepEqual(result.intent.declared.sort(), ["bindings/now", "slots/panel"]);
		assert.deepEqual(result.intent.undeclared, ["bindings/fetch"]);
		assert.equal(result.intent.byDuration.long, 1);
		assert.equal(result.signals["declared-intent"], 2 / 3);
	});

	it("does not carry the declared-intent signal when the host has no surface to declare it on", async () => {
		const bare = { xript: "0.8", name: "bare-host", capabilities: { ui: { description: "UI." } } };
		const result = await scoreManifests(bare, []);
		assert.equal("declared-intent" in result.signals, false);
		assert.equal(result.headline, 20);
	});

	it("carries a disclaimer about what it does not prove", async () => {
		const result = await scoreManifests(host, [mod]);
		assert.match(result.disclaimer, /does not prove/i);
	});
});

describe("coverage over an empty surface", () => {
	// An empty surface scores 1 vacuously — nothing is uncovered — which is right for a gate and
	// misleading rendered as a full bar. `total` is what lets a presenter tell the two apart: a
	// host declaring no slots was being told it had filled all of them.
	it("reports a total of zero rather than only a vacuous score", async () => {
		const result = await scoreManifests({ xript: "0.8", name: "bare", bindings: { log: { description: "L." } } }, []);
		assert.equal(result.slots.total, 0);
		assert.equal(result.capabilities.total, 0);
		assert.equal(result.slots.score, 1, "the gate value stays vacuously true");
	});

	it("counts a host's own surface, and not what it inherited", async () => {
		const host = {
			xript: "0.8",
			name: "app",
			capabilities: { ui: { description: "UI." } },
			slots: [
				{ id: "a", accepts: ["text/html"], description: "A." },
				{ id: "b", accepts: ["text/html"], description: "B." },
			],
		};
		const result = await scoreManifests(host, []);
		assert.equal(result.slots.total, 2);
		assert.equal(result.capabilities.total, 1);
		assert.equal(result.slots.score, 0, "no mods supplied, so nothing is filled");
	});
});
