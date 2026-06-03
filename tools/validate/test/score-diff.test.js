import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scoreManifests, diffScores } from "../dist/index.js";

const host = {
	xript: "0.3",
	name: "h",
	slots: [
		{ id: "a", accepts: ["text/html"], capability: "ui", description: "A." },
		{ id: "b", accepts: ["text/html"], capability: "ui", description: "B." },
	],
	capabilities: { ui: { description: "UI." } },
};

const fill = (slot) => ({ xript: "0.3", name: `m-${slot}`, version: "1.0.0", capabilities: ["ui"], fills: { [slot]: [{ format: "text/html" }] } });

describe("diffScores", () => {
	it("filling more slots lifts informational coverage but not the capacity headline", async () => {
		const baseline = await scoreManifests(host, [fill("a")]);
		const current = await scoreManifests(host, [fill("a"), fill("b")]);
		const diff = diffScores(baseline, current);
		assert.equal(diff.headline.delta, 0, "the capacity headline does not move with how many slots get filled");
		assert.equal(diff.direction, "unchanged");
		assert.deepEqual(diff.slots.gained, ["b"]);
		assert.ok(diff.slots.delta > 0, "informational slot coverage still rises");
	});

	it("an unfilled slot is not a regression", async () => {
		const baseline = await scoreManifests(host, [fill("a"), fill("b")]);
		const current = await scoreManifests(host, [fill("a")]);
		const diff = diffScores(baseline, current, { minDelta: 0 });
		assert.equal(diff.headline.delta, 0, "leaving a slot unfilled does not lower moddability");
		assert.equal(diff.direction, "unchanged");
		assert.deepEqual(diff.slots.lost, ["b"]);
		assert.equal(diff.gate.passed, true);
	});

	it("capacity rises as the host exposes more extension surface, and maxes at full breadth", async () => {
		const lean = await scoreManifests({ xript: "0.3", name: "lean", bindings: { f: {} } }, []);
		const rich = await scoreManifests(
			{
				xript: "0.3",
				name: "rich",
				bindings: { f: {} },
				slots: [{ id: "a", accepts: ["text/html"], capability: "ui", description: "A." }],
				capabilities: { ui: { description: "UI." } },
				events: [{ id: "x.y", description: "X." }],
			},
			[],
		);
		assert.ok(rich.headline > lean.headline);
		assert.equal(rich.headline, 100);
		assert.deepEqual(rich.capacity.absent, []);
	});

	it("declaring more slots never lowers the headline", async () => {
		const few = await scoreManifests(host, []);
		const many = await scoreManifests(
			{
				...host,
				slots: [
					...host.slots,
					{ id: "c", accepts: ["text/html"], capability: "ui", description: "C." },
					{ id: "d", accepts: ["text/html"], capability: "ui", description: "D." },
				],
			},
			[],
		);
		assert.ok(many.headline >= few.headline, "exposing more slots is not penalized");
	});

	it("reports unchanged for an identical run", async () => {
		const baseline = await scoreManifests(host, [fill("a")]);
		const current = await scoreManifests(host, [fill("a")]);
		const diff = diffScores(baseline, current, { minDelta: 0 });
		assert.equal(diff.direction, "unchanged");
		assert.equal(diff.headline.delta, 0);
		assert.equal(diff.gate.passed, true);
	});

	it("flags an introduced integrity violation as a regression", async () => {
		const baseline = await scoreManifests(host, [fill("a")]);
		const current = await scoreManifests(host, [fill("a"), { xript: "0.3", name: "bad", version: "1.0.0", capabilities: ["ui"], fills: { ghost: [{ format: "text/html" }] } }]);
		const diff = diffScores(baseline, current, { minDelta: 0 });
		assert.equal(diff.direction, "regressed");
		assert.ok(diff.integrity.introduced.length > 0);
		assert.equal(diff.gate.passed, false);
	});
});
