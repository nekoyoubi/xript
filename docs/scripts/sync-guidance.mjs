import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const docsRoot = join(here, "..");
const guidanceSource = join(docsRoot, "..", "tools", "cli", "content", "guidance");
const guidanceTarget = join(docsRoot, "src", "content", "docs", "guidance");

const index = JSON.parse(await readFile(join(guidanceSource, "index.json"), "utf-8"));

await rm(guidanceTarget, { recursive: true, force: true });
await mkdir(guidanceTarget, { recursive: true });

for (const topic of index.topics) {
	const raw = await readFile(join(guidanceSource, topic.file), "utf-8");
	const body = raw.replace(/\r\n/g, "\n").replace(/^#\s+.*\n+/, "").trim();
	const frontmatter = `---\ntitle: ${JSON.stringify(topic.title)}\ndescription: ${JSON.stringify(topic.summary)}\n---\n\n`;
	await writeFile(join(guidanceTarget, `${topic.id}.md`), `${frontmatter}${body}\n`, "utf-8");
}

console.log(`sync-guidance: wrote ${index.topics.length} doctrine pages into src/content/docs/guidance/`);
