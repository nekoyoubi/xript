import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const docsRoot = join(here, "..");
const guidanceSource = join(docsRoot, "..", "tools", "cli", "content", "guidance");
const guidanceTarget = join(docsRoot, "src", "content", "docs", "guidance");
const specSource = join(docsRoot, "..", "spec");

const index = JSON.parse(await readFile(join(guidanceSource, "index.json"), "utf-8"));

await rm(guidanceTarget, { recursive: true, force: true });
await mkdir(guidanceTarget, { recursive: true });

for (const topic of index.topics) {
	const raw = await readFile(join(guidanceSource, topic.file), "utf-8");
	const body = raw.replace(/\r\n/g, "\n").replace(/^#\s+.*\n+/, "").trim();
	const frontmatter = `---\ntitle: ${JSON.stringify(topic.title)}\ndescription: ${JSON.stringify(topic.summary)}\n---\n\n`;
	await writeFile(join(guidanceTarget, `${topic.id}.md`), `${frontmatter}${body}\n`, "utf-8");
}

const changelogRaw = await readFile(join(docsRoot, "..", "CHANGELOG.md"), "utf-8");
const changelogBody = changelogRaw.replace(/\r\n/g, "\n").replace(/^#\s+Changelog\s*\n+/, "").trim();
const changelogFrontmatter = `---
title: Changelog
description: "What changed in each xript release - new surfaces, breaking schema changes, and migration notes."
---

`;
await writeFile(join(docsRoot, "src", "content", "docs", "changelog.md"), `${changelogFrontmatter}${changelogBody}\n`, "utf-8");

const schemaTarget = join(docsRoot, "public", "schema");
const SCHEMAS = [
	{ file: "manifest.schema.json", dir: "manifest", versions: ["v0.7.json", "v0.6.json", "v0.3.json", "v0.1.json"] },
	{ file: "mod-manifest.schema.json", dir: "mod-manifest", versions: ["v0.7.json", "v0.6.json", "v0.3.json"] },
	{ file: "capability-prompt.schema.json", dir: "capability-prompt", versions: ["v0.5.json"] },
	{ file: "install-descriptor.schema.json", dir: "install-descriptor", versions: ["v0.5.json"] },
	{ file: "discovery-result.schema.json", dir: "discovery-result", versions: ["v0.5.json"] },
	{ file: "debug-messages.schema.json", dir: "debug-messages", versions: ["v0.5.json"] },
	{ file: "harness.schema.json", dir: "harness", versions: ["v0.7.json"] },
	{ file: "harness-steps.schema.json", dir: "harness-steps", versions: ["v0.7.json"] },
];
for (const schema of SCHEMAS) {
	const raw = await readFile(join(specSource, schema.file), "utf-8");
	await mkdir(join(schemaTarget, schema.dir), { recursive: true });
	for (const version of schema.versions) {
		await writeFile(join(schemaTarget, schema.dir, version), raw, "utf-8");
	}
}

const SPEC_REPO = "https://github.com/nekoyoubi/xript/blob/main/spec/";
const SPEC_SLUGS = {
	"manifest.md": "manifest", "mod-manifest.md": "mod-manifest", "fragments.md": "fragments",
	"fragment-formats.md": "fragment-formats", "capabilities.md": "capabilities", "bindings.md": "bindings",
	"hooks.md": "hooks", "modules.md": "modules", "extends.md": "extends", "harness.md": "harness",
	"debug-protocol.md": "debugging", "security.md": "security", "annotations.md": "annotations",
};
const SCHEMA_URLS = {
	"manifest.schema.json": "/schema/manifest/v0.7.json",
	"mod-manifest.schema.json": "/schema/mod-manifest/v0.7.json",
	"harness.schema.json": "/schema/harness/v0.7.json",
	"harness-steps.schema.json": "/schema/harness-steps/v0.7.json",
	"capability-prompt.schema.json": "/schema/capability-prompt/v0.5.json",
	"install-descriptor.schema.json": "/schema/install-descriptor/v0.5.json",
	"discovery-result.schema.json": "/schema/discovery-result/v0.5.json",
	"debug-messages.schema.json": "/schema/debug-messages/v0.5.json",
};
const SPEC_PAGES = [
	{ file: "manifest.md", title: "Manifest Specification", description: "The xript manifest format: how applications declare their scripting API." },
	{ file: "mod-manifest.md", title: "Mod Manifest", description: "What a mod declares: capabilities, entry, exports, and fills keyed by host slot id." },
	{ file: "fragments.md", title: "Fragment Protocol", description: "Inert templates, data-bind, data-if, handlers, and the command buffer." },
	{ file: "fragment-formats.md", title: "Fragment Formats", description: "The format catalog a slot's accepts names, and what a host must do to paint each." },
	{ file: "capabilities.md", title: "Capability Model", description: "Default-deny grants, prefix subsumption, and the read/write mode lattice." },
	{ file: "bindings.md", title: "Bindings", description: "Host functions and namespaces: errors, versioning, type mapping, and naming grammars." },
	{ file: "hooks.md", title: "Hooks", description: "Event-typed slots, the dispatch contract, and live event delivery." },
	{ file: "modules.md", title: "Module-Format Mods", description: "ES module entries, the import deny, approved libraries, and TypeScript authoring." },
	{ file: "extends.md", title: "Manifest Inheritance (extends)", description: "How a manifest builds on base manifests: add-new, fill, refine, collision rules, and cycle detection." },
	{ file: "harness.md", title: "Host Harness", description: "Synthetic hosts for testing: stub bindings, journaled calls, library sources, and replayable step scenarios." },
	{ file: "debug-protocol.md", title: "Debugging", description: "The DAP-shaped debug protocol and per-engine fidelity across the four runtimes." },
	{ file: "security.md", title: "Security Model", description: "The sandbox guarantees, the threat model, and what xript refuses to allow." },
	{ file: "annotations.md", title: "Annotations", description: "@xript source annotations scanned into manifest bindings and capabilities." },
];

function siteSpecLinks(body) {
	return body
		.replace(/\]\((?:\.\/)?([a-z-]+)\.md(#[a-z0-9-]+)?\)/g, (match, file, anchor) => {
			const slug = SPEC_SLUGS[`${file}.md`];
			return slug ? `](/spec/${slug}/${anchor ?? ""})` : match;
		})
		.replace(/\]\((?:\.\/)?([a-z-]+\.schema\.json)\)/g, (match, file) => {
			const url = SCHEMA_URLS[file];
			return url ? `](${url})` : match;
		})
		.replace(/\]\((?:\.\/)?([a-z-]+-tests\.json)\)/g, (match, file) => `](${SPEC_REPO}${file})`);
}

const specPagesTarget = join(docsRoot, "src", "content", "docs", "spec");
await mkdir(specPagesTarget, { recursive: true });
for (const page of SPEC_PAGES) {
	const raw = await readFile(join(specSource, page.file), "utf-8");
	const body = siteSpecLinks(raw.replace(/\r\n/g, "\n").replace(/^#\s+.*\n+/, "").trim());
	const frontmatter = `---\ntitle: ${JSON.stringify(page.title)}\ndescription: ${JSON.stringify(page.description)}\n---\n\n`;
	await writeFile(join(specPagesTarget, `${SPEC_SLUGS[page.file]}.md`), `${frontmatter}${body}\n`, "utf-8");
}

console.log(`sync-guidance: ${index.topics.length} doctrine pages, the changelog, ${SCHEMAS.length} schema families, and ${SPEC_PAGES.length} generated spec pages`);
