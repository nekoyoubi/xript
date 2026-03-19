#!/usr/bin/env node

import { readFileSync, execSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

const pkg = JSON.parse(readFileSync(resolve(root, "runtimes/js/package.json"), "utf8"));
const version = pkg.version;
const tag = `v${version}`;

const branch = execSync("git branch --show-current", { cwd: root, encoding: "utf8" }).trim();
if (branch !== "main") {
	console.error(`You're on '${branch}', not 'main'. Switch to main before releasing.`);
	process.exit(1);
}

const status = execSync("git status --porcelain", { cwd: root, encoding: "utf8" }).trim();
if (status) {
	console.error("Working tree is dirty. Commit or stash your changes first.");
	process.exit(1);
}

execSync("git fetch origin main", { cwd: root, stdio: "inherit" });
const behind = execSync("git rev-list HEAD..origin/main --count", { cwd: root, encoding: "utf8" }).trim();
if (behind !== "0") {
	console.error(`Local main is ${behind} commit(s) behind origin. Pull first.`);
	process.exit(1);
}

const changelog = readFileSync(resolve(root, "CHANGELOG.md"), "utf8");
const headerPattern = new RegExp(`^## ${tag.replace(/\./g, "\\.")}\\b(.*)$`, "m");
const match = changelog.match(headerPattern);

if (!match) {
	console.error(`No changelog entry found for ${tag} in CHANGELOG.md.`);
	console.error(`Package version is ${version}, but CHANGELOG.md has no ## ${tag} section.`);
	console.error("Add one before releasing.");
	process.exit(1);
}

const headerIndex = changelog.indexOf(match[0]);
const afterHeader = changelog.slice(headerIndex + match[0].length);
const nextHeader = afterHeader.search(/^## /m);
const body = (nextHeader === -1 ? afterHeader : afterHeader.slice(0, nextHeader)).trim();

const theme = match[1].replace(/^\s*—\s*/, "").trim();
const title = theme ? `${tag} — ${theme}` : tag;

console.log(`Releasing ${title}`);
console.log(`  version: ${version} (from @xriptjs/runtime)`);
console.log(`  tag:     ${tag}`);
console.log(`  body:    ${body.split("\n").length} lines from CHANGELOG.md\n`);

execSync(`gh release create ${tag} --title "${title}" --notes-file -`, {
	cwd: root,
	input: body,
	stdio: ["pipe", "inherit", "inherit"],
});

console.log(`\nRelease ${tag} created. Publish workflows should fire momentarily.`);
console.log(`View at: https://github.com/nekoyoubi/xript/releases/tag/${tag}`);
