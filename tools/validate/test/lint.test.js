import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { lintManifests } from "../dist/index.js";

const host = {
	xript: "0.3",
	name: "linted-host",
	slots: [
		{ id: "filled", accepts: ["text/html"], capability: "capUsed", description: "A filled slot." },
		{ id: "dead", accepts: ["text/html"], capability: "capUsed", description: "A dead slot." },
	],
	capabilities: {
		capUsed: { description: "Used cap." },
		capVestigial: { description: "Unused cap." },
	},
};

const mod = {
	xript: "0.3",
	name: "m",
	version: "1.0.0",
	capabilities: ["capUsed"],
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
		const result = lintManifests(host, [{ ...mod, capabilities: ["capUsed", "capMissing"] }]);
		assert.ok(codes(result, "error").includes("undeclared-capability"));
	});

	it("flags a dead slot as a warning", () => {
		const result = lintManifests(host, [mod]);
		const warnings = result.findings.filter((f) => f.severity === "warn");
		assert.ok(warnings.some((f) => f.code === "dead-slot" && /dead/.test(f.message)));
	});

	it("flags a vestigial capability as a warning", () => {
		const result = lintManifests(host, [mod]);
		assert.ok(result.findings.some((f) => f.code === "vestigial-capability" && /capVestigial/.test(f.message)));
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
			capabilities: ["capUsed"],
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
			slots: [{ id: "statusbar", accepts: ["text/html"], capability: "capUsed", description: "Inherited then refined." }],
			capabilities: { capUsed: { description: "Used cap." } },
		};
		const fillingMod = {
			xript: "0.3",
			name: "m",
			version: "1.0.0",
			capabilities: ["capUsed"],
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
});
