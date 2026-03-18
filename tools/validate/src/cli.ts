#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { validateManifestFile, crossValidate, validateManifest, validateModManifest } from "./index.js";

const args = process.argv.slice(2);
const crossIndex = args.indexOf("--cross");
const isCross = crossIndex !== -1;

const files = args.filter((a) => !a.startsWith("-"));

if (isCross) {
	if (files.length !== 2) {
		console.error("Usage: xript-validate --cross <app-manifest.json> <mod-manifest.json>");
		process.exit(1);
	}

	const [appPath, modPath] = files;

	let appRaw: string;
	let modRaw: string;
	try {
		appRaw = await readFile(resolve(appPath), "utf-8");
	} catch {
		console.error(`\x1b[31m\u2717\x1b[0m could not read file: ${resolve(appPath)}`);
		process.exit(1);
	}
	try {
		modRaw = await readFile(resolve(modPath), "utf-8");
	} catch {
		console.error(`\x1b[31m\u2717\x1b[0m could not read file: ${resolve(modPath)}`);
		process.exit(1);
	}

	let appManifest: unknown;
	let modManifest: unknown;
	try {
		appManifest = JSON.parse(appRaw);
	} catch {
		console.error(`\x1b[31m\u2717\x1b[0m invalid JSON in ${resolve(appPath)}`);
		process.exit(1);
	}
	try {
		modManifest = JSON.parse(modRaw);
	} catch {
		console.error(`\x1b[31m\u2717\x1b[0m invalid JSON in ${resolve(modPath)}`);
		process.exit(1);
	}

	const appResult = await validateManifest(appManifest);
	if (!appResult.valid) {
		console.error(`\x1b[31m\u2717\x1b[0m ${resolve(appPath)} (app manifest invalid)`);
		for (const error of appResult.errors) {
			console.error(`  ${error.path}: ${error.message}`);
		}
		process.exit(1);
	}

	const modResult = await validateModManifest(modManifest);
	if (!modResult.valid) {
		console.error(`\x1b[31m\u2717\x1b[0m ${resolve(modPath)} (mod manifest invalid)`);
		for (const error of modResult.errors) {
			console.error(`  ${error.path}: ${error.message}`);
		}
		process.exit(1);
	}

	const crossResult = await crossValidate(appManifest, modManifest);
	if (crossResult.valid) {
		console.log(`\x1b[32m\u2713\x1b[0m cross-validation passed`);
	} else {
		console.error(`\x1b[31m\u2717\x1b[0m cross-validation failed`);
		for (const error of crossResult.errors) {
			console.error(`  ${error.path}: ${error.message}`);
		}
		process.exit(1);
	}
} else {
	if (files.length === 0) {
		console.error("Usage: xript-validate <manifest.json> [manifest2.json ...]");
		console.error("       xript-validate --cross <app-manifest.json> <mod-manifest.json>");
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
}
