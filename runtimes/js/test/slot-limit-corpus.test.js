import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { initXript } from "../dist/index.js";

const corpus = JSON.parse(
	readFileSync(fileURLToPath(new URL("../../../spec/slot-limit-tests.json", import.meta.url)), "utf8"),
);
const schema = JSON.parse(
	readFileSync(fileURLToPath(new URL("../../../spec/manifest.schema.json", import.meta.url)), "utf8"),
);

let xript;

before(async () => {
	xript = await initXript();
});

function resolved(entry) {
	const options = { hostBindings: {}, capabilities: [] };
	if (entry.hardLimits) options.hardLimits = entry.hardLimits;
	const runtime = xript.createRuntime(entry.manifest, options);
	try {
		return runtime.effectiveSlotTimeoutMs(entry.slot);
	} finally {
		runtime.dispose();
	}
}

describe("slot limit corpus", () => {
	it("carries cases", () => {
		assert.ok(corpus.resolve.length > 0);
	});

	for (const entry of corpus.resolve) {
		it(entry.name, () => {
			assert.equal(resolved(entry), entry.expected);
		});
	}

	it("keeps the manifest schema block in step with the corpus", () => {
		const declared = schema.$defs.slotExecutionLimits;
		const canonical = corpus.schemaBlock;
		assert.equal(declared.properties.timeout_ms.type, canonical.properties.timeout_ms.type);
		assert.equal(declared.properties.timeout_ms.minimum, canonical.properties.timeout_ms.minimum);
		assert.equal(declared.additionalProperties, canonical.additionalProperties ?? false);
	});
});
