import { readdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

const SITE_FALLBACK = "https://xript.dev";

const SUMMARY =
	"xript (eXtensible Runtime Interface Protocol Tooling) is a platform specification for making any application moddable through sandboxed JavaScript. A single manifest declares the bindings, capabilities, hooks, types, and slots a host exposes; everything else — TypeScript definitions, docs, validation — derives from it.";

const SECTIONS = [
	{ title: "Introduction", slugs: ["", "getting-started", "vision", "adoption-tiers", "changelog"] },
	{
		title: "Doctrine",
		slugs: [
			"guidance/when-to-use",
			"guidance/surfaces",
			"guidance/mod-zero",
			"guidance/boundary",
			"guidance/openness",
			"guidance/tiers",
		],
	},
	{
		title: "Hosting xript",
		slugs: [
			"guidance/hosting",
			"guidance/host-fragments",
			"guidance/host-formats",
			"guidance/host-capabilities",
			"guidance/host-slots",
			"guidance/host-roles",
			"guidance/host-hooks",
			"guidance/host-commands",
			"guidance/host-safety",
		],
	},
	{
		title: "Authoring Mods",
		slugs: ["mods/first-mod", "guidance/authoring"],
	},
	{
		title: "Specification",
		slugs: [
			"spec/index",
			"spec/manifest",
			"spec/extends",
			"spec/mod-manifest",
			"spec/fragments",
			"spec/fragment-formats",
			"spec/renderers",
			"spec/expressions",
			"spec/capabilities",
			"spec/bindings",
			"spec/hooks",
			"spec/execution",
			"spec/commands",
			"spec/modules",
			"spec/harness",
			"spec/debugging",
			"spec/security",
			"spec/annotations",
		],
	},
	{ title: "Runtimes", slugs: ["runtimes/overview", "runtimes/js-wasm", "runtimes/node", "runtimes/rust", "runtimes/csharp"] },
	{ title: "Tools", slugs: ["tools/cli", "tools/mcp", "tools/score", "tools/lint", "tools/wiz", "tools/fragment-workbench"] },
	{ title: "Examples", slugs: ["examples/expression-evaluator", "examples/plugin-system", "examples/game-mod-system", "examples/ui-dashboard", "examples/fragment-vocabulary"] },
	{ title: "Demos", slugs: ["demos/expression-playground", "demos/plugin-workshop", "demos/dungeon-modding", "demos/fragment-builder"] },
];

async function walk(dir) {
	const out = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...(await walk(full)));
		else if (entry.name.endsWith(".md") || entry.name.endsWith(".mdx")) out.push(full);
	}
	return out;
}

function unquote(value) {
	return value.replace(/^["']|["']$/g, "").trim();
}

function parsePage(input) {
	const raw = input.replace(/\r\n/g, "\n");
	const match = raw.match(/^---\n([\s\S]*?)\n---\n?/);
	const frontmatter = match ? match[1] : "";
	const body = match ? raw.slice(match[0].length) : raw;
	const title = unquote((frontmatter.match(/^title:\s*(.+)$/m) ?? [])[1] ?? "Untitled");
	const description = unquote((frontmatter.match(/^description:\s*(.+)$/m) ?? [])[1] ?? "");
	const cleanBody = body
		.split("\n")
		.filter((line) => !/^import\s.+from\s.+;?$/.test(line.trim()))
		.join("\n")
		.trim();
	return { title, description, body: cleanBody };
}

function slugOf(contentDir, file) {
	const rel = relative(contentDir, file).replace(/\\/g, "/").replace(/\.(md|mdx)$/, "");
	return rel === "index" ? "" : rel;
}

export function llmsTxt() {
	let contentDir;
	let site = SITE_FALLBACK;
	return {
		name: "llms-txt",
		hooks: {
			"astro:config:done": ({ config }) => {
				contentDir = join(fileURLToPath(config.srcDir), "content", "docs");
				if (config.site) site = config.site.replace(/\/$/, "");
			},
			"astro:build:done": async ({ dir, logger }) => {
				const files = await walk(contentDir);
				const pages = new Map();
				for (const file of files) {
					pages.set(slugOf(contentDir, file), parsePage(await readFile(file, "utf-8")));
				}

				const url = (slug) => `${site}/${slug ? `${slug}/` : ""}`;
				const placed = new Set();

				const indexLines = [`# xript`, "", `> ${SUMMARY}`, ""];
				const fullParts = [`# xript — Full Documentation`, "", `> ${SUMMARY}`, "", `Source: ${site}`, ""];

				for (const section of SECTIONS) {
					indexLines.push(`## ${section.title}`, "");
					for (const slug of section.slugs) {
						const page = pages.get(slug);
						if (!page) {
							logger.warn(`llms-txt: no page for slug "${slug}"`);
							continue;
						}
						placed.add(slug);
						if (slug !== "") indexLines.push(`- [${page.title}](${url(slug)})${page.description ? `: ${page.description}` : ""}`);
						fullParts.push("", "----------------------------------------", "", `# ${page.title}`, `Source: ${url(slug)}`, "", page.body, "");
					}
					indexLines.push("");
				}

				const orphans = [...pages.keys()].filter((slug) => !placed.has(slug));
				if (orphans.length) {
					// A warning in a long build log is the same as no check: `spec/renderers` and
					// `spec/expressions` sat unsectioned from the day they shipped. An orphan means
					// llms.txt is structurally wrong, and the person adding the page is the one who
					// knows where it belongs.
					throw new Error(
						`llms-txt: ${orphans.length} page(s) are in no section: ${orphans.join(", ")}. ` +
							"Add each to a SECTIONS entry in docs/integrations/llms-txt.mjs.",
					);
				}

				await writeFile(new URL("./llms.txt", dir), `${indexLines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`, "utf-8");
				await writeFile(new URL("./llms-full.txt", dir), `${fullParts.join("\n").replace(/\n{4,}/g, "\n\n\n").trim()}\n`, "utf-8");
				logger.info(`llms-txt: wrote llms.txt and llms-full.txt (${pages.size} pages)`);
			},
		},
	};
}
