import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { validateManifest } = await import("../dist/index.js");

function host(events) {
	return { xript: "0.10", name: "events-host", events };
}

async function valid(events) {
	const result = await validateManifest(host(events));
	return result.valid ? true : result.errors;
}

describe("event declarations", () => {
	it("accept emit, keys, and an addressed companion shape", async () => {
		assert.equal(
			await valid([
				{
					id: "stat.changed",
					description: "Fired after any stat changes.",
					emit: "mods",
					keys: ["instanceId", "value"],
					addressed: ["stat.<instanceId>.changed"],
				},
			]),
			true,
		);
	});

	it("accept a pattern id whose varying segments are written <name>", async () => {
		assert.equal(await valid([{ id: "cell.<x>.<y>.lit", description: "Fired when one grid cell lights up.", pattern: true }]), true);
	});

	it("keep today's id grammar for an entry that is not a pattern", async () => {
		assert.notEqual(await valid([{ id: "save:captured", description: "Colon segments are not event ids." }]), true);
		assert.notEqual(await valid([{ id: "Document.saved", description: "Uppercase is not an event id." }]), true);
		assert.equal(await valid([{ id: "document.saved", description: "Fired after a document is saved." }]), true);
	});

	it("refuse a <name> segment outside a pattern entry", async () => {
		assert.notEqual(await valid([{ id: "cell.<x>.lit", description: "Missing the pattern flag." }]), true);
	});

	it("refuse a pattern entry with no <name> segment", async () => {
		assert.notEqual(await valid([{ id: "cell.lit", description: "Nothing varies.", pattern: true }]), true);
	});

	it("refuse an unknown emit value and a malformed addressed shape", async () => {
		assert.notEqual(await valid([{ id: "tick", description: "Fired each frame.", emit: "everyone" }]), true);
		assert.notEqual(await valid([{ id: "stat.changed", description: "Fired after any stat changes.", addressed: ["stat:<id>:changed"] }]), true);
	});

	it("refuse duplicate keys", async () => {
		assert.notEqual(await valid([{ id: "tick", description: "Fired each frame.", keys: ["a", "a"] }]), true);
	});
});
