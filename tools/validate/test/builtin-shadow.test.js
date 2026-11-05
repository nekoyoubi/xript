import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { lintManifests } from "../dist/index.js";

function shadows(bindings) {
	return lintManifests({ xript: "0.10", name: "host", bindings }, []).findings.filter((f) => f.code === "binding-shadows-builtin");
}

describe("binding-shadows-builtin", () => {
	it("warns once per top-level binding named like a runtime global, naming what wins", () => {
		const findings = shadows({
			events: { description: "Shadow." },
			hooks: { description: "Shadow." },
			xript: { description: "Shadow." },
			console: { description: "Shadow." },
			save: { description: "Saves." },
		});
		assert.deepEqual(findings.map((f) => f.severity), ["warn", "warn", "warn", "warn"]);
		const byName = Object.fromEntries(findings.map((f) => [f.message.match(/binding "(\w+)"/)[1], f.message]));
		assert.match(byName.events, /runtime's `events` replaces the binding/);
		assert.match(byName.hooks, /runtime's `hooks` replaces the binding/);
		assert.match(byName.xript, /differs by runtime/);
		assert.match(byName.console, /host's binding replaces the runtime's `console`/);
	});

	it("points an events binding at host events mode, and only an events binding", () => {
		const [events, hooks] = shadows({ events: { description: "Shadow." }, hooks: { description: "Shadow." } });
		assert.match(events.suggestion, /host events mode \(`hostEvents: true` in JavaScript, `host_events` in Rust, `HostEvents` in C#\)/);
		assert.doesNotMatch(hooks.suggestion, /host events mode/);
	});

	it("leaves namespace members and ordinary names alone", () => {
		assert.deepEqual(shadows({ game: { description: "Game.", members: { events: { description: "Lists the game's events." } } } }), []);
		assert.deepEqual(shadows({ constructor: { description: "Not a runtime global." } }), []);
	});

	it("is a warning, so validation still passes", () => {
		const result = lintManifests({ xript: "0.10", name: "host", bindings: { events: { description: "Shadow." } } }, []);
		assert.equal(result.findings.some((f) => f.severity === "error" && f.code === "binding-shadows-builtin"), false);
	});
});
