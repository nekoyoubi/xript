import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRuntime } from "../dist/index.js";

const corpus = JSON.parse(readFileSync(fileURLToPath(new URL("../../../spec/stack-tests.json", import.meta.url)), "utf8"));

describe("stack corpus", () => {
	for (const testCase of corpus.cases) {
		it(testCase.name, () => {
			const runtime = createRuntime(corpus.manifest, {});
			try {
				const outcome = runtime.execute(corpus.template.replace("SCRIPT", () => testCase.script)).value;
				assert.ok(outcome === "caught" || outcome === "ok", `got ${outcome}`);
				assert.equal(runtime.execute(corpus.after).value, corpus.afterExpected);
			} finally {
				assert.doesNotThrow(() => runtime.dispose());
			}
		});
	}
});
