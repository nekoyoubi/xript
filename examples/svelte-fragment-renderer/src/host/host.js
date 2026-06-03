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

/**
 * Load a mod's manifest plus its entry and fragment sources from disk,
 * mirroring `examples/ui-dashboard`.
 *
 * @param {string} modDir
 */
function fragmentFills(manifest) {
	if (manifest.fills) {
		const flat = [];
		for (const [slot, entries] of Object.entries(manifest.fills)) {
			for (const entry of entries) {
				flat.push({ slot, ...entry });
			}
		}
		return flat;
	}
	return manifest.fragments ?? [];
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
	const fragments = fragmentFills(modManifest);
	for (const frag of fragments) {
		if (!frag.inline) {
			sources[frag.source] = await readFile(new URL(`../../mods/${modDir}/${frag.source}`, import.meta.url), "utf-8");
		}
	}
	return { manifest: { ...modManifest, fragments }, sources };
}

export { appState };
