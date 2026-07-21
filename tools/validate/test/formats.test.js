import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	validateManifest,
	crossValidate,
	lintManifests,
	scoreManifests,
	resolveProvenance,
} from "../dist/index.js";

const widgetFormat = {
	description: "The widget vocabulary this host renders.",
	syntax: "jsml",
	nodes: {
		Panel: {
			description: "A titled container.",
			props: {
				heading: { type: "string" },
				collapsible: { type: "boolean" },
			},
		},
		Link: {
			description: "A navigational link.",
			props: {
				href: { type: "string", sink: "uri" },
				label: { type: "string" },
			},
		},
		Progress: {
			description: "A progress bar.",
			children: "none",
			bindTo: "value",
			props: {
				value: { type: "number" },
				max: { type: "number" },
				style: { type: "object" },
			},
		},
	},
};

const host = {
	xript: "0.8",
	name: "widget-host",
	capabilities: { ui: { description: "Mount UI into a slot." } },
	slots: [
		{
			id: "sidebar",
			accepts: ["application/x-widgets+json"],
			capability: "ui",
			description: "The left sidebar.",
		},
	],
	formats: { "application/x-widgets+json": widgetFormat },
};

function fragmentMod(source) {
	return {
		xript: "0.8",
		name: "widget-mod",
		version: "1.0.0",
		capabilities: ["ui"],
		fills: {
			sidebar: [
				{
					id: "panel",
					format: "application/x-widgets+json",
					source: JSON.stringify(source),
					inline: true,
				},
			],
		},
	};
}

describe("formats — schema", () => {
	it("validates a host declaring a fragment-format vocabulary", async () => {
		const result = await validateManifest(host);
		assert.equal(result.valid, true, JSON.stringify(result.errors));
	});

	it("rejects redeclaring a built-in format", async () => {
		const result = await validateManifest({
			...host,
			formats: { ...host.formats, "text/html": { syntax: "html", nodes: { Panel: {} } } },
		});
		assert.equal(result.valid, false);
	});

	it("rejects a format with an unknown syntax", async () => {
		const result = await validateManifest({
			...host,
			formats: { "application/x-widgets+json": { syntax: "yaml", nodes: { Panel: {} } } },
		});
		assert.equal(result.valid, false);
		assert.ok(result.errors.some((e) => e.path.endsWith("/syntax")));
	});

	it("rejects a prop declaring a sink outside the sink lattice", async () => {
		const result = await validateManifest({
			...host,
			formats: {
				"application/x-widgets+json": {
					syntax: "jsml",
					nodes: { Panel: { props: { heading: { type: "string", sink: "sql" } } } },
				},
			},
		});
		assert.equal(result.valid, false);
	});

	it("accepts arbitrary JSON Schema keywords inside a prop", async () => {
		const result = await validateManifest({
			...host,
			formats: {
				"application/x-widgets+json": {
					syntax: "jsml",
					nodes: {
						Panel: { props: { heading: { type: "string", maxLength: 80, pattern: "^[A-Z]" } } },
					},
				},
			},
		});
		assert.equal(result.valid, true, JSON.stringify(result.errors));
	});
});

describe("formats — crossValidate", () => {
	it("accepts a fill whose nodes and props the vocabulary declares", async () => {
		const mod = fragmentMod([
			"Panel",
			{ heading: "Stats", collapsible: true },
			["Progress", { value: 42, max: 100, style: { fg: "Green" } }],
		]);
		const result = await crossValidate(host, mod);
		assert.equal(result.valid, true, JSON.stringify(result.errors));
	});

	it("fails a fill naming a node the vocabulary does not declare", async () => {
		const mod = fragmentMod(["Panle", { heading: "Typo" }]);
		const result = await crossValidate(host, mod);
		assert.equal(result.valid, false);
		const error = result.errors.find((e) => e.keyword === "cross-fill-vocabulary");
		assert.ok(error, JSON.stringify(result.errors));
		assert.match(error.message, /Panle/);
	});

	it("reports an undeclared prop as a warning, not an error", async () => {
		const mod = fragmentMod(["Panel", { heading: "Stats", maxHealth: 10 }]);
		const result = await crossValidate(host, mod);
		assert.equal(result.valid, true, JSON.stringify(result.errors));
		assert.ok(result.warnings?.some((w) => w.keyword === "cross-fill-vocabulary" && /maxHealth/.test(w.message)));
	});

	it("reports a prop value rejected by its sink", async () => {
		const mod = fragmentMod(["Link", { href: "javascript:alert(1)", label: "Click" }]);
		const result = await crossValidate(host, mod);
		assert.ok(result.warnings?.some((w) => /href/.test(w.message)));
	});

	it("fails a fragment fill whose format the slot does not accept", async () => {
		const mod = {
			xript: "0.8",
			name: "m",
			version: "1.0.0",
			capabilities: ["ui"],
			fills: { sidebar: [{ format: "text/html", source: "<p>hi</p>", inline: true }] },
		};
		const result = await crossValidate(host, mod);
		assert.equal(result.valid, false);
		assert.ok(result.errors.some((e) => e.keyword === "cross-fill-format"));
	});

	it("fails a fragment fill whose format no vocabulary declares", async () => {
		const openHost = {
			...host,
			slots: [{ ...host.slots[0], accepts: ["application/x-ghost+json"] }],
		};
		const mod = {
			xript: "0.8",
			name: "m",
			version: "1.0.0",
			capabilities: ["ui"],
			fills: { sidebar: [{ format: "application/x-ghost+json", source: "[]", inline: true }] },
		};
		const result = await crossValidate(openHost, mod);
		assert.equal(result.valid, false);
		const error = result.errors.find((e) => e.keyword === "cross-fill-format");
		assert.ok(error);
		assert.match(error.message, /formats/);
	});

	it("leaves a data fill alone: it carries no source, so it is not markup", async () => {
		const dataHost = {
			...host,
			slots: [{ id: "records", accepts: ["application/json"], capability: "ui", description: "Data." }],
			formats: host.formats,
		};
		const mod = {
			xript: "0.8",
			name: "m",
			version: "1.0.0",
			capabilities: ["ui"],
			fills: { records: [{ format: "application/json", members: [1, 2, 3] }] },
		};
		const result = await crossValidate(dataHost, mod);
		assert.equal(result.valid, true, JSON.stringify(result.errors));
	});

	it("checks an inline fragment on the legacy fragments[] path too", async () => {
		const mod = {
			xript: "0.8",
			name: "m",
			version: "1.0.0",
			capabilities: ["ui"],
			fragments: [
				{
					id: "f",
					slot: "sidebar",
					format: "application/x-widgets+json",
					source: JSON.stringify(["Buton", {}]),
					inline: true,
				},
			],
		};
		const result = await crossValidate(host, mod);
		assert.equal(result.valid, false);
		assert.ok(result.errors.some((e) => e.keyword === "cross-fill-vocabulary"));
	});

	it("does not read a non-inline source: a file path is not markup", async () => {
		const mod = {
			xript: "0.8",
			name: "m",
			version: "1.0.0",
			capabilities: ["ui"],
			fills: { sidebar: [{ format: "application/x-widgets+json", source: "fragments/panel.json" }] },
		};
		const result = await crossValidate(host, mod);
		assert.equal(result.valid, true, JSON.stringify(result.errors));
	});
});

describe("formats — lint", () => {
	const filling = {
		xript: "0.8",
		name: "m",
		version: "1.0.0",
		capabilities: ["ui"],
		fills: { sidebar: [{ format: "application/x-widgets+json", source: "p.json" }] },
	};

	function codes(result) {
		return result.findings.map((f) => f.code);
	}

	it("stays quiet on a well-formed vocabulary", () => {
		const result = lintManifests(host, [filling]);
		assert.equal(result.counts.error, 0, JSON.stringify(result.findings));
		assert.ok(!codes(result).includes("dead-format"));
	});

	it("errors on a redeclared built-in format", () => {
		const result = lintManifests(
			{ ...host, formats: { ...host.formats, "text/html": { syntax: "html", nodes: {} } } },
			[filling],
		);
		assert.ok(codes(result).includes("builtin-format-redeclared"));
	});

	it("errors on a non-text sink declared on a prop that is not a string", () => {
		const result = lintManifests(
			{
				...host,
				formats: {
					"application/x-widgets+json": {
						...widgetFormat,
						nodes: {
							...widgetFormat.nodes,
							Icon: { description: "An icon.", props: { svg: { type: "object", sink: "html" } } },
						},
					},
				},
			},
			[filling],
		);
		assert.ok(codes(result).includes("sink-requires-string"));
	});

	it("errors on a declared prop name the sanitizer always rejects", () => {
		const result = lintManifests(
			{
				...host,
				formats: {
					"application/x-widgets+json": {
						...widgetFormat,
						nodes: {
							...widgetFormat.nodes,
							Button: { description: "A button.", props: { onClick: { type: "string" } } },
						},
					},
				},
			},
			[filling],
		);
		assert.ok(codes(result).includes("prop-name-reserved"));
	});

	it("errors on a bind target the node does not declare", () => {
		const result = lintManifests(
			{
				...host,
				formats: {
					"application/x-widgets+json": {
						...widgetFormat,
						nodes: {
							...widgetFormat.nodes,
							Gauge: { description: "A gauge.", children: "none", bindTo: "amount", props: { value: { type: "number" } } },
						},
					},
				},
			},
			[filling],
		);
		assert.ok(codes(result).includes("bind-target-undeclared"));
	});

	it("warns when one prop name carries two different sinks in one format", () => {
		const result = lintManifests(
			{
				...host,
				formats: {
					"application/x-widgets+json": {
						...widgetFormat,
						nodes: {
							...widgetFormat.nodes,
							Image: { description: "An image.", props: { href: { type: "string", sink: "image-uri" } } },
						},
					},
				},
			},
			[filling],
		);
		assert.ok(codes(result).includes("prop-sink-conflict"));
	});

	it("warns on a declared format no slot accepts", () => {
		const result = lintManifests(
			{
				...host,
				slots: [{ ...host.slots[0], accepts: ["text/html"] }],
			},
			[],
		);
		assert.ok(codes(result).includes("dead-format"));
	});

	it("stays quiet on an inherited format no local slot accepts", () => {
		const result = lintManifests(
			{ ...host, slots: [{ ...host.slots[0], accepts: ["text/html"] }] },
			[],
			{ inheritedFormats: ["application/x-widgets+json"] },
		);
		assert.ok(!codes(result).includes("dead-format"));
	});

	it("notes an undescribed format and node", () => {
		const result = lintManifests(
			{
				...host,
				formats: {
					"application/x-widgets+json": { syntax: "jsml", nodes: { Panel: {} } },
				},
			},
			[filling],
		);
		const undescribed = result.findings.filter((f) => f.code === "undescribed");
		assert.ok(undescribed.some((f) => /format "application\/x-widgets\+json"/.test(f.message)));
		assert.ok(undescribed.some((f) => /node "Panel"/.test(f.message)));
	});
});

describe("formats — score", () => {
	it("reports declared vocabularies without moving the capacity headline", async () => {
		const withoutFormats = { ...host };
		delete withoutFormats.formats;
		const plain = await scoreManifests(withoutFormats, []);
		const vocabulary = await scoreManifests(host, []);

		assert.equal(vocabulary.headline, plain.headline, "a vocabulary refines the slot surface, it does not add one");
		assert.deepEqual(vocabulary.formats.declared, ["application/x-widgets+json"]);
		assert.deepEqual(vocabulary.formats.reachable, ["application/x-widgets+json"]);
		assert.deepEqual(vocabulary.formats.unreachable, []);
		assert.equal(vocabulary.formats.nodes, 3);
		assert.deepEqual(plain.formats.declared, []);
	});

	it("reports a declared format no slot accepts as unreachable", async () => {
		const result = await scoreManifests({ ...host, slots: [{ ...host.slots[0], accepts: ["text/html"] }] }, []);
		assert.deepEqual(result.formats.unreachable, ["application/x-widgets+json"]);
		assert.deepEqual(result.formats.reachable, []);
	});
});

describe("formats — extends provenance", () => {
	let tmpDir;

	before(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "xript-formats-"));
	});

	after(async () => {
		if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
	});

	it("reports a format that came from the base as inherited", async () => {
		const basePath = join(tmpDir, "base.json");
		await writeFile(basePath, JSON.stringify(host), "utf-8");

		const child = {
			xript: "0.8",
			name: "child-host",
			extends: basePath,
			formats: {
				"application/x-charts+json": {
					description: "Charts.",
					syntax: "jsml",
					nodes: { Bar: { description: "A bar." } },
				},
			},
		};

		const provenance = await resolveProvenance(child, tmpDir);
		assert.deepEqual(provenance.inheritedFormats, ["application/x-widgets+json"]);
		assert.equal(provenance.resolved.formats["application/x-charts+json"].nodes.Bar.description, "A bar.");
		assert.ok(provenance.resolved.formats["application/x-widgets+json"].nodes.Panel);
	});

	it("resolves a refined vocabulary into a manifest that still validates", async () => {
		const basePath = join(tmpDir, "base-refine.json");
		await writeFile(basePath, JSON.stringify(host), "utf-8");

		const child = {
			xript: "0.8",
			name: "child-host",
			extends: basePath,
			formats: {
				"application/x-widgets+json": {
					refines: true,
					syntax: "jsml",
					nodes: { Badge: { description: "A badge.", props: { text: { type: "string" } } } },
				},
			},
		};

		const { resolved } = await resolveProvenance(child, tmpDir);
		assert.ok(!("refines" in resolved.formats["application/x-widgets+json"]));
		const result = await validateManifest(resolved);
		assert.equal(result.valid, true, JSON.stringify(result.errors));
	});
});

describe("deprecated j5ml spellings", () => {
	const deprecations = (result) => (result.warnings ?? []).filter((w) => w.keyword === "deprecated");

	it("warns on the deprecated media type in a slot's accepts", async () => {
		const manifest = {
			...host,
			slots: [{ ...host.slots[0], accepts: ["text/html", "application/jsml+json"] }],
		};
		const result = await validateManifest(manifest);
		assert.equal(result.valid, true, JSON.stringify(result.errors));
		const warned = deprecations(result);
		assert.equal(warned.length, 2);
		const media = warned.find((w) => w.path === "/slots/0/accepts/1");
		assert.ok(media, JSON.stringify(warned));
		assert.match(media.message, /application\/j5ml\+json/);
	});

	it("warns on the deprecated syntax spelling, with an escaped pointer", async () => {
		const result = await validateManifest(host);
		const warned = deprecations(result);
		const syntax = warned.find((w) => w.path.endsWith("/syntax"));
		assert.ok(syntax, JSON.stringify(warned));
		assert.equal(syntax.path, "/formats/application~1x-widgets+json/syntax");
		assert.match(syntax.message, /'jsml' is a deprecated spelling of 'j5ml'/);
	});

	it("stays silent on the canonical spellings", async () => {
		const manifest = {
			...host,
			slots: [{ ...host.slots[0], accepts: ["application/j5ml+json"] }],
			formats: {
				"application/x-widgets+json": { ...widgetFormat, syntax: "j5ml" },
			},
		};
		const result = await validateManifest(manifest);
		assert.equal(result.valid, true, JSON.stringify(result.errors));
		assert.deepEqual(deprecations(result), []);
	});
});
