#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
	console.error("Usage: node scripts/bump-version.mjs <version>");
	console.error("Example: node scripts/bump-version.mjs 0.3.1");
	process.exit(1);
}

const root = resolve(import.meta.dirname, "..");

const npmPackages = [
	"tools/sanitize/package.json",
	"tools/validate/package.json",
	"tools/typegen/package.json",
	"tools/docgen/package.json",
	"tools/init/package.json",
	"tools/cli/package.json",
	"runtimes/js/package.json",
	"runtimes/node/package.json",
];

const internalDeps = {
	"@xriptjs/sanitize": [`^${version}`],
	"@xriptjs/runtime": [`^${version}`],
	"@xriptjs/validate": [`^${version}`],
	"@xriptjs/typegen": [`^${version}`],
	"@xriptjs/docgen": [`^${version}`],
	"@xriptjs/init": [`^${version}`],
};

const rustCrates = [
	"runtimes/rust/Cargo.toml",
	"renderers/ratatui/Cargo.toml",
	"tools/wiz/Cargo.toml",
];

const csproj = "runtimes/csharp/src/Xript.Runtime/Xript.Runtime.csproj";

let updated = 0;

for (const rel of npmPackages) {
	const abs = resolve(root, rel);
	const pkg = JSON.parse(readFileSync(abs, "utf8"));
	pkg.version = version;
	for (const [dep, [range]] of Object.entries(internalDeps)) {
		if (pkg.dependencies?.[dep]) pkg.dependencies[dep] = range;
	}
	writeFileSync(abs, JSON.stringify(pkg, null, "\t") + "\n");
	updated++;
	console.log(`  ${rel} -> ${version}`);
}

const docsPath = resolve(root, "docs/package.json");
const docs = JSON.parse(readFileSync(docsPath, "utf8"));
for (const [dep, [range]] of Object.entries(internalDeps)) {
	if (docs.dependencies?.[dep]) docs.dependencies[dep] = range;
}
writeFileSync(docsPath, JSON.stringify(docs, null, "\t") + "\n");
updated++;
console.log(`  docs/package.json -> deps updated`);

for (const rel of rustCrates) {
	const abs = resolve(root, rel);
	let toml = readFileSync(abs, "utf8");
	toml = toml.replace(
		/^(version\s*=\s*)"[^"]*"/m,
		`$1"${version}"`
	);
	toml = toml.replace(
		/^(xript-runtime\s*=\s*\{.*?version\s*=\s*)"[^"]*"/gm,
		`$1"${version}"`
	);
	toml = toml.replace(
		/^(xript-ratatui\s*=\s*\{.*?version\s*=\s*)"[^"]*"/gm,
		`$1"${version}"`
	);
	writeFileSync(abs, toml);
	updated++;
	console.log(`  ${rel} -> ${version}`);
}

const csprojPath = resolve(root, csproj);
let xml = readFileSync(csprojPath, "utf8");
xml = xml.replace(/<Version>[^<]*<\/Version>/, `<Version>${version}</Version>`);
writeFileSync(csprojPath, xml);
updated++;
console.log(`  ${csproj} -> ${version}`);

console.log(`\n${updated} files updated to ${version}`);
console.log(`Run 'npm install' to refresh the lockfile.`);
