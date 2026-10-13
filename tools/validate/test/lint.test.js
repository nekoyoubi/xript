import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { lintManifests } from "../dist/index.js";

const host = {
	xript: "0.3",
	name: "linted-host",
	slots: [
		{ id: "filled", accepts: ["text/html"], capability: "cap-used", description: "A filled slot." },
		{ id: "dead", accepts: ["text/html"], capability: "cap-used", description: "A dead slot." },
	],
	capabilities: {
		"cap-used": { description: "Used cap." },
		"cap-vestigial": { description: "Unused cap." },
	},
};

const mod = {
	xript: "0.3",
	name: "m",
	version: "1.0.0",
	capabilities: ["cap-used"],
	fills: { filled: [{ format: "text/html", source: "f.html" }] },
};

function codes(result, severity) {
	return result.findings.filter((f) => f.severity === severity).map((f) => f.code);
}

describe("lintManifests", () => {
	it("flags a filled-but-undeclared slot as an error", () => {
		const result = lintManifests(host, [
			{ ...mod, fills: { ghost: [{ format: "text/html" }] } },
		]);
		const errorCodes = codes(result, "error");
		assert.ok(errorCodes.includes("filled-but-undeclared"));
		assert.ok(result.findings.some((f) => f.code === "filled-but-undeclared" && /ghost/.test(f.message)));
	});

	it("flags an undeclared capability requested by a mod as an error", () => {
		const result = lintManifests(host, [{ ...mod, capabilities: ["cap-used", "capMissing"] }]);
		assert.ok(codes(result, "error").includes("undeclared-capability"));
	});

	it("flags a dead slot as a warning", () => {
		const result = lintManifests(host, [mod]);
		const warnings = result.findings.filter((f) => f.severity === "warn");
		assert.ok(warnings.some((f) => f.code === "dead-slot" && /dead/.test(f.message)));
	});

	it("flags a vestigial capability as a warning", () => {
		const result = lintManifests(host, [mod]);
		assert.ok(result.findings.some((f) => f.code === "vestigial-capability" && /cap-vestigial/.test(f.message)));
	});

	it("flags an ungated slot as info", () => {
		const ungatedHost = {
			xript: "0.3",
			name: "h",
			slots: [{ id: "open", accepts: ["text/html"], description: "Ungated." }],
			capabilities: {},
		};
		const result = lintManifests(ungatedHost, []);
		assert.ok(result.findings.some((f) => f.code === "ungated-slot" && f.severity === "info"));
	});

	it("flags a missing description as info", () => {
		const undescribedHost = {
			xript: "0.3",
			name: "h",
			slots: [{ id: "s", accepts: ["text/html"], capability: "capA" }],
			capabilities: { capA: { description: "A." } },
		};
		const result = lintManifests(undescribedHost, []);
		assert.ok(result.findings.some((f) => f.code === "undescribed" && f.severity === "info"));
	});

	it("counts findings by severity", () => {
		const result = lintManifests(host, [mod]);
		assert.equal(result.counts.error + result.counts.warn + result.counts.info, result.findings.length);
		assert.equal(result.counts.error, codes(result, "error").length);
	});

	it("counts a legacy fragments[] fill as a filled slot", () => {
		const legacyMod = {
			xript: "0.3",
			name: "legacy",
			version: "1.0.0",
			capabilities: ["cap-used"],
			fragments: [{ id: "f", slot: "dead", format: "text/html", source: "f.html" }],
		};
		const result = lintManifests(host, [mod, legacyMod]);
		assert.ok(!result.findings.some((f) => f.code === "dead-slot"));
	});

	it("every finding carries a suggestion", () => {
		const result = lintManifests(host, [mod]);
		for (const finding of result.findings) assert.ok(finding.suggestion.length > 0);
	});

	it("does not flag a capability that only gates a host binding as vestigial", () => {
		const gatedHost = {
			xript: "0.3",
			name: "h",
			bindings: {
				canvas: { description: "Canvas.", members: { size: { description: "Size.", returns: "number", capability: "canvas.read" } } },
			},
			slots: [],
			capabilities: { "canvas.read": { description: "Read the canvas." } },
		};
		const result = lintManifests(gatedHost, []);
		assert.ok(!result.findings.some((f) => f.code === "vestigial-capability" && /canvas\.read/.test(f.message)));
	});

	it("does not flag a reserved capability as vestigial", () => {
		const reservedCapHost = {
			xript: "0.3",
			name: "h",
			slots: [],
			capabilities: {
				live: { description: "Gates a slot." },
				parity: { description: "Canon parity, not yet gating anything.", reserved: true },
			},
		};
		const result = lintManifests(reservedCapHost, []);
		assert.ok(!result.findings.some((f) => f.code === "vestigial-capability" && /parity/.test(f.message)));
		assert.ok(result.findings.some((f) => f.code === "vestigial-capability" && /live/.test(f.message)));
	});

	it("does not flag a reserved slot as dead", () => {
		const reservedHost = {
			xript: "0.3",
			name: "h",
			slots: [{ id: "future", accepts: ["text/html"], capability: "capA", description: "Reserved.", reserved: true }],
			capabilities: { capA: { description: "A." } },
		};
		const result = lintManifests(reservedHost, []);
		assert.ok(!result.findings.some((f) => f.code === "dead-slot"));
	});

	it("flags an inherited abstract type left unfilled as an error", () => {
		const resolvedHost = {
			xript: "0.3",
			name: "h",
			types: {
				StatusCode: { description: "Inherited but never filled.", abstract: true },
			},
			slots: [],
		};
		const result = lintManifests(resolvedHost, [], { inheritedAbstractTypes: ["StatusCode"] });
		assert.ok(
			result.findings.some((f) => f.code === "abstract-type-unfilled" && f.severity === "error" && /StatusCode/.test(f.message)),
		);
	});

	it("stays silent once an inherited abstract type is filled", () => {
		const resolvedHost = {
			xript: "0.3",
			name: "h",
			types: {
				StatusCode: { description: "Now concrete.", values: ["ok", "error"] },
			},
			slots: [],
		};
		const result = lintManifests(resolvedHost, [], { inheritedAbstractTypes: [] });
		assert.ok(!result.findings.some((f) => f.code === "abstract-type-unfilled"));
	});

	it("does not flag a locally-declared abstract type as unfilled", () => {
		const localHost = {
			xript: "0.3",
			name: "h",
			types: {
				LocalHole: { description: "Declared here, not inherited.", abstract: true },
			},
			slots: [],
		};
		const result = lintManifests(localHost, []);
		assert.ok(!result.findings.some((f) => f.code === "abstract-type-unfilled"));
	});

	it("does not trip dead-slot on an inherited slot that a mod fills", () => {
		const resolvedHost = {
			xript: "0.3",
			name: "h",
			slots: [{ id: "statusbar", accepts: ["text/html"], capability: "cap-used", description: "Inherited then refined." }],
			capabilities: { "cap-used": { description: "Used cap." } },
		};
		const fillingMod = {
			xript: "0.3",
			name: "m",
			version: "1.0.0",
			capabilities: ["cap-used"],
			fills: { statusbar: [{ format: "text/html", source: "f.html" }] },
		};
		const result = lintManifests(resolvedHost, [fillingMod], { inheritedSlots: ["statusbar"] });
		assert.ok(!result.findings.some((f) => f.code === "dead-slot"));
	});

	it("does not trip vestigial-capability on an inherited capability a mod uses", () => {
		const resolvedHost = {
			xript: "0.3",
			name: "h",
			slots: [],
			capabilities: { storage: { description: "Inherited capability." } },
		};
		const usingMod = {
			xript: "0.3",
			name: "m",
			version: "1.0.0",
			capabilities: ["storage"],
		};
		const result = lintManifests(resolvedHost, [usingMod], { inheritedCapabilities: ["storage"] });
		assert.ok(!result.findings.some((f) => f.code === "vestigial-capability" && /storage/.test(f.message)));
	});

	it("flags an escalation-named child under a declared ancestor as a warning", () => {
		const escalatingHost = {
			xript: "0.3",
			name: "h",
			slots: [],
			capabilities: {
				fs: { description: "Filesystem access." },
				"fs.host": { description: "Host-level filesystem access." },
			},
		};
		const result = lintManifests(escalatingHost, []);
		assert.ok(
			result.findings.some(
				(f) => f.code === "capability-escalation" && f.severity === "warn" && /fs\.host/.test(f.message) && /"fs"/.test(f.message),
			),
		);
	});

	it("flags an escalation child even when an intermediate ancestor is undeclared", () => {
		const escalatingHost = {
			xript: "0.3",
			name: "h",
			slots: [],
			capabilities: {
				run: { description: "Run things." },
				"run.command.shell": { description: "Shell escape." },
			},
		};
		const result = lintManifests(escalatingHost, []);
		assert.ok(
			result.findings.some(
				(f) => f.code === "capability-escalation" && /run\.command\.shell/.test(f.message) && /"run"/.test(f.message),
			),
		);
	});

	it("does not flag an escalation-named scope with no declared ancestor", () => {
		const reRootedHost = {
			xript: "0.3",
			name: "h",
			slots: [],
			capabilities: {
				fs: { description: "Filesystem access." },
				"host-fs": { description: "Re-rooted privileged filesystem access." },
			},
		};
		const result = lintManifests(reRootedHost, []);
		assert.ok(!result.findings.some((f) => f.code === "capability-escalation"));
	});

	it("does not flag a benign narrowing child under a declared ancestor", () => {
		const benignHost = {
			xript: "0.3",
			name: "h",
			slots: [],
			capabilities: {
				fs: { description: "Filesystem access." },
				"fs.addon": { description: "Addon directory access." },
			},
		};
		const result = lintManifests(benignHost, []);
		assert.ok(!result.findings.some((f) => f.code === "capability-escalation"));
	});

	it("does not flag a top-level escalation-named capability with no ancestor", () => {
		const topLevelHost = {
			xript: "0.3",
			name: "h",
			slots: [],
			capabilities: {
				admin: { description: "Top-level admin scope, declared on purpose." },
			},
		};
		const result = lintManifests(topLevelHost, []);
		assert.ok(!result.findings.some((f) => f.code === "capability-escalation"));
	});
});

describe("library lint checks", () => {
	const libraryHost = {
		xript: "0.7",
		name: "library-host",
		capabilities: { lib: { description: "Shared libraries." } },
		libraries: {
			"doc-lib": { description: "Doc helpers.", capability: "lib" },
		},
	};

	it("accepts a library gated on a declared capability, and the gate counts as use", () => {
		const result = lintManifests(libraryHost, []);
		assert.ok(!codes(result, "error").includes("undeclared-capability"));
		assert.ok(!codes(result, "warn").includes("vestigial-capability"));
	});

	it("errors when a library gates on an undeclared capability", () => {
		const broken = { ...libraryHost, libraries: { "doc-lib": { description: "Doc helpers.", capability: "ghost" } } };
		const result = lintManifests(broken, []);
		const finding = result.findings.find((f) => f.code === "undeclared-capability");
		assert.ok(finding);
		assert.match(finding.message, /library "doc-lib"/);
	});
});

describe("runtime-configured capability scopes", () => {
	const modRequesting = (cap) => ({
		xript: "0.8",
		name: "ws-mod",
		version: "1.0.0",
		capabilities: [cap],
		entry: { script: "m.js", format: "script", exports: {} },
	});
	const hostDeclaring = (instances) => ({
		xript: "0.8",
		name: "fs-host",
		capabilities: {
			fs: { description: "Filesystem." },
			"fs.workspace": { description: "A configured workspace root.", ...(instances ? { instances } : {}) },
		},
	});

	// The matcher already accepts a descendant of a declared scope, which is what makes
	// runtime roots work at all. Without `instances` the host never said children exist.
	it("warns when a mod names a scope below a node that never claims runtime children", () => {
		const { findings } = lintManifests(hostDeclaring(null), [modRequesting("write:fs.workspace.proj-a")]);
		const codes = findings.map((f) => f.code);
		assert.ok(codes.includes("dynamic-scope-undeclared"), `got ${codes.join(", ")}`);
		assert.ok(!codes.includes("undeclared-capability"), "a subsumed scope is not undeclared");
	});

	it("falls silent once the parent declares instances", () => {
		const host = hostDeclaring({ description: "One per configured workspace.", example: "fs.workspace.proj-a" });
		const { findings } = lintManifests(host, [modRequesting("write:fs.workspace.proj-a")]);
		assert.ok(!findings.map((f) => f.code).includes("dynamic-scope-undeclared"));
	});

	it("says nothing about a scope the host declares outright", () => {
		const { findings } = lintManifests(hostDeclaring(null), [modRequesting("write:fs.workspace")]);
		assert.ok(!findings.map((f) => f.code).includes("dynamic-scope-undeclared"));
	});

	it("still errors on a root the host does not declare at all", () => {
		const { findings } = lintManifests(hostDeclaring(null), [modRequesting("write:nowhere.proj-a")]);
		const codes = findings.map((f) => f.code);
		assert.ok(codes.includes("undeclared-capability"));
		assert.ok(!codes.includes("dynamic-scope-undeclared"), "an undeclared root is reported once, as undeclared");
	});
});

describe("undeclared capability gates outside slots", () => {
	// Only slots, libraries and mod requests were checked, so a host could gate a binding, a
	// nested namespace member, a hook or an event on a scope it never declared — an
	// undiscoverable gate that appears in no generated doc — and both validate and lint passed.
	const host = {
		xript: "0.8",
		name: "gate-host",
		capabilities: { known: { description: "Declared." } },
		bindings: {
			ok: { description: "Declared gate.", capability: "known" },
			bad: { description: "Undeclared gate.", capability: "ghost" },
			ns: { description: "Namespace.", members: { deep: { description: "Nested.", capability: "phantom" } } },
		},
		hooks: { onSave: { description: "Fires.", capability: "spectre" } },
		events: [{ id: "thing.happened", description: "Event.", capability: "wraith" }],
	};

	it("reports every surface that gates on a scope the host does not declare", () => {
		const { findings } = lintManifests(host, []);
		const reported = findings.filter((f) => f.code === "undeclared-capability").map((f) => f.message);
		for (const needle of ['binding "bad"', 'binding "ns.deep"', 'hook "onSave"', 'event "thing.happened"']) {
			assert.ok(reported.some((m) => m.includes(needle)), `${needle} went unreported: ${reported.join(" | ")}`);
		}
	});

	it("says nothing about a gate the host does declare", () => {
		const { findings } = lintManifests(host, []);
		assert.ok(!findings.some((f) => f.code === "undeclared-capability" && f.message.includes('"ok"')));
	});

	it("accepts a gate subsumed by a declared parent scope", () => {
		const nested = {
			xript: "0.8",
			name: "gate-host",
			capabilities: { fs: { description: "Filesystem." } },
			bindings: { read: { description: "Reads.", capability: "read:fs.workspace" } },
		};
		const { findings } = lintManifests(nested, []);
		assert.ok(!findings.some((f) => f.code === "undeclared-capability"));
	});
});

describe("undeclared type references", () => {
	// A `typeRef` string is just a string to the schema, so a reference to a type nobody declared
	// validated clean and then emitted a `.d.ts` that would not compile: typegen passes an
	// unknown name through verbatim.
	const host = {
		xript: "0.8",
		name: "typed-host",
		types: {
			Player: { description: "A player.", fields: { name: { type: "string", description: "N." } } },
			Bad: { description: "Refers onward.", fields: { who: { type: "Nobody", description: "W." } } },
		},
		bindings: {
			ok: { description: "Declared.", params: [], returns: "Player" },
			okArray: { description: "Array shorthand of a declared type.", params: [], returns: "Player[]" },
			bad: { description: "Undeclared.", params: [], returns: "NoSuchType" },
			ns: { description: "Namespace.", members: { deep: { description: "Nested.", params: [{ name: "p", type: "AlsoMissing" }] } } },
		},
		hooks: { onSave: { description: "Fires.", params: [{ name: "doc", type: "GhostDoc" }] } },
		events: [{ id: "app.ready", description: "Ready.", payload: "PhantomPayload" }],
	};

	it("reports every reference to a type the manifest does not declare", () => {
		const reported = lintManifests(host, []).findings
			.filter((f) => f.code === "undeclared-type")
			.map((f) => f.message);
		for (const needle of ["NoSuchType", "AlsoMissing", "GhostDoc", "PhantomPayload", "Nobody"]) {
			assert.ok(reported.some((m) => m.includes(needle)), `${needle} unreported: ${reported.join(" | ")}`);
		}
	});

	it("accepts primitives, declared types, and an array shorthand of one", () => {
		const reported = lintManifests(host, []).findings
			.filter((f) => f.code === "undeclared-type")
			.map((f) => f.message);
		for (const clean of ['"ok" return', '"okArray" return', 'field "name"']) {
			assert.ok(!reported.some((m) => m.includes(clean)), `false positive on ${clean}`);
		}
	});

	it("resolves through the object array and union forms", () => {
		const nested = {
			xript: "0.8",
			name: "h",
			types: { Player: { description: "P.", fields: {} } },
			bindings: {
				a: { description: "Array of declared.", params: [], returns: { array: "Player" } },
				b: { description: "Union with a ghost.", params: [], returns: { union: ["Player", "Spectre"] } },
			},
		};
		const reported = lintManifests(nested, []).findings
			.filter((f) => f.code === "undeclared-type")
			.map((f) => f.message);
		assert.equal(reported.length, 1, `expected only Spectre: ${reported.join(" | ")}`);
		assert.ok(reported[0].includes("Spectre"));
	});

	it("resolves through map, optional, and function signatures, and treats function as a primitive", () => {
		const nested = {
			xript: "0.8",
			name: "h",
			types: { Cell: { description: "C.", fields: {} } },
			bindings: {
				a: { description: "Map of a ghost.", params: [], returns: { map: "Wraith" } },
				b: { description: "Optional ghost.", params: [], returns: { optional: "Shade" } },
				c: {
					description: "Callback params.",
					params: [
						{ name: "plain", type: "function" },
						{ name: "test", type: { function: { params: [{ name: "cell", type: "Cell" }, { name: "x", type: "Ghoul" }], returns: "Banshee" } } },
					],
				},
			},
		};
		const reported = lintManifests(nested, []).findings
			.filter((f) => f.code === "undeclared-type")
			.map((f) => f.message);
		for (const needle of ["Wraith", "Shade", "Ghoul", "Banshee"]) {
			assert.ok(reported.some((m) => m.includes(needle)), `${needle} unreported: ${reported.join(" | ")}`);
		}
		assert.ok(!reported.some((m) => m.includes('"function"') || m.includes('"Cell"')), reported.join(" | "));
	});
});

describe("callbacks only cross as binding parameters", () => {
	const host = {
		xript: "0.8",
		name: "callback-host",
		bindings: {
			find: { description: "Takes a predicate.", params: [{ name: "test", type: "function" }], returns: "boolean" },
			ns: { description: "Namespace.", members: { make: { description: "Returns a function.", params: [], returns: { optional: "function" } } } },
		},
		hooks: { onTick: { description: "Fires.", params: [{ name: "done", type: { function: {} } }] } },
		events: [{ id: "app.ready", description: "Ready.", payload: { array: "function" } }],
	};

	it("warns where a function is declared somewhere no callback reaches", () => {
		const reported = lintManifests(host, []).findings.filter((f) => f.code === "callback-does-not-cross");
		const messages = reported.map((f) => f.message);
		assert.equal(reported.length, 3, messages.join(" | "));
		assert.ok(reported.every((f) => f.severity === "warn"));
		for (const needle of ['binding "ns.make" return', 'hook "onTick" parameter "done"', 'event "app.ready" payload']) {
			assert.ok(messages.some((m) => m.includes(needle)), `${needle} unreported: ${messages.join(" | ")}`);
		}
	});

	it("stays quiet about a function parameter", () => {
		const reported = lintManifests(host, []).findings.filter((f) => f.code === "callback-does-not-cross");
		assert.ok(!reported.some((f) => f.message.includes('"find"')));
	});
});

describe("reserved xript identifier namespace", () => {
	// typegen emits its own types and globals under the `xript`/`Xript` prefix. A host type or
	// binding sharing that prefix collides with generated output in the emitted `.d.ts`. Reserving
	// the prefix (not a fixed list) keeps every current and future generated name collision-safe.
	it("reports a host type or binding in the reserved namespace, any case", () => {
		const host = {
			xript: "0.8",
			name: "colliding",
			types: {
				XriptSlots: { description: "Shadows the generated slot map.", fields: {} },
				xriptState: { description: "Lowercase still collides with the globals.", fields: {} },
				Fine: { description: "Clear of the namespace.", fields: {} },
			},
			bindings: {
				XriptEventId: { description: "Shadows the generated event-id union.", params: [] },
				log: { description: "Clear of the namespace.", params: [] },
			},
			slots: [{ id: "xript-anything", accepts: ["text/html"] }],
		};
		const reported = lintManifests(host, []).findings.filter((f) => f.code === "reserved-identifier");
		const messages = reported.map((f) => f.message);
		for (const needle of ['type "XriptSlots"', 'type "xriptState"', 'binding "XriptEventId"']) {
			assert.ok(messages.some((m) => m.includes(needle)), `${needle} unreported: ${messages.join(" | ")}`);
		}
		assert.ok(reported.every((f) => f.severity === "error"));
		assert.ok(!messages.some((m) => m.includes('"Fine"') || m.includes('"log"')), "false positive outside the namespace");
		// A slot id is a string literal in the emitted union, never an identifier, so it is not reserved.
		assert.ok(!messages.some((m) => m.includes("xript-anything")), "slot ids are not identifiers and must not be reserved");
	});

	// A record type "Foo" makes typegen emit a `FooAccessor` interface alongside it. A host that
	// also declares a type literally named "FooAccessor" produces a duplicate identifier. This is
	// the host's own two names colliding, so it is surfaced rather than forbidden by suffix.
	it("reports a type whose name collides with a generated record accessor", () => {
		const host = {
			xript: "0.8",
			name: "accessor-clash",
			types: {
				Player: { description: "A record.", fields: { name: { type: "string" } } },
				PlayerAccessor: { description: "Collides with the generated accessor for Player.", fields: { extra: { type: "string" } } },
				Enum: { description: "An enum, no accessor generated.", values: ["a", "b"] },
				EnumAccessor: { description: "No collision — Enum generates no accessor.", fields: { ok: { type: "string" } } },
			},
		};
		const reported = lintManifests(host, []).findings.filter((f) => f.code === "generated-accessor-collision");
		assert.equal(reported.length, 1, `expected only PlayerAccessor: ${reported.map((f) => f.message).join(" | ")}`);
		assert.ok(reported[0].message.includes("PlayerAccessor"));
		assert.equal(reported[0].severity, "error");
	});
});
