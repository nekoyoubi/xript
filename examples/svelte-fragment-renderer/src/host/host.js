import { initXript } from "@xriptjs/runtime";
import { readFile } from "node:fs/promises";

const manifestRaw = await readFile(new URL("../../manifest.json", import.meta.url), "utf-8");
const manifest = JSON.parse(manifestRaw);

const appState = {
	counter: { value: 0 },
};

const hostBindings = {
	log: (message) => console.log(`[mod] ${message}`),
	counter: {
		getValue: () => appState.counter.value,
		increment: () => {
			appState.counter.value += 1;
			return appState.counter.value;
		},
	},
};

const xript = await initXript();

export function createRuntime(capabilities = ["ui-mount"]) {
	return xript.createRuntime(manifest, {
		hostBindings,
		capabilities,
		console: { log: console.log, warn: console.warn, error: console.error },
	});
}

export async function loadModFiles(modDir) {
	const modManifestRaw = await readFile(new URL(`../../mods/${modDir}/mod-manifest.json`, import.meta.url), "utf-8");
	const modManifest = JSON.parse(modManifestRaw);

	const sources = {};
	if (modManifest.entry) {
		const entries = Array.isArray(modManifest.entry) ? modManifest.entry : [modManifest.entry];
		for (const entry of entries) {
			sources[entry] = await readFile(new URL(`../../mods/${modDir}/${entry}`, import.meta.url), "utf-8");
		}
	}
	for (const entries of Object.values(modManifest.fills ?? {})) {
		for (const fill of entries) {
			if (!fill.inline && fill.source) {
				sources[fill.source] = await readFile(new URL(`../../mods/${modDir}/${fill.source}`, import.meta.url), "utf-8");
			}
		}
	}
	return { manifest: modManifest, sources };
}

export { appState };
