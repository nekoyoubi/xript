import { initXript } from "@xriptjs/runtime";
import { readFile } from "node:fs/promises";

const manifestRaw = await readFile(new URL("../manifest.json", import.meta.url), "utf-8");
const manifest = JSON.parse(manifestRaw);

const hostBindings = {
	log: (message) => console.log(`[mod] ${message}`),
};

const xript = await initXript();

export function createRuntime(capabilities = []) {
	return xript.createRuntime(manifest, {
		hostBindings,
		capabilities,
		console: { log: console.log, warn: console.warn, error: console.error },
	});
}
