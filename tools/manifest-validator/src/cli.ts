#!/usr/bin/env node

import { validateManifestFile } from "./index.js";

const files = process.argv.slice(2);

if (files.length === 0) {
	console.error("Usage: xript-validate <manifest.json> [manifest2.json ...]");
	process.exit(1);
}

let hasFailure = false;

for (const file of files) {
	const result = await validateManifestFile(file);

	if (result.valid) {
		console.log(`\x1b[32m\u2713\x1b[0m ${result.filePath}`);
	} else {
		hasFailure = true;
		console.error(`\x1b[31m\u2717\x1b[0m ${result.filePath}`);
		for (const error of result.errors) {
			console.error(`  ${error.path}: ${error.message}`);
		}
	}
}

process.exit(hasFailure ? 1 : 0);
