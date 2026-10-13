import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRuntime } from "../dist/index.js";

const corpus = JSON.parse(
	readFileSync(fileURLToPath(new URL("../../../spec/marshal-out-tests.json", import.meta.url)), "utf8"),
);

describe("sandbox-to-host marshalling corpus", () => {
	for (const entry of corpus.cases) {
		it(entry.name, () => {
			const runtime = createRuntime(corpus.manifest, { hostBindings: {} });
			try {
				assert.deepEqual(runtime.execute(entry.script).value, entry.expected);
			} finally {
				runtime.dispose();
			}
		});
	}
});
