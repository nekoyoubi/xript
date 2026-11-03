import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020Module from "ajv/dist/2020.js";

const Ajv2020 = Ajv2020Module.default ?? Ajv2020Module;
const __dirname = dirname(fileURLToPath(import.meta.url));
const specDir = resolve(__dirname, "../../../spec");
const read = async (file) => JSON.parse(await readFile(resolve(specDir, file), "utf-8"));

const schema = await read("expression-reference.schema.json");
const reference = await read("expression-reference.json");

describe("expression reference schema", () => {
	const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);

	it("accepts the published reference", () => {
		const ok = validate(reference);
		assert.ok(ok, JSON.stringify(validate.errors, null, 2));
	});

	it("is the schema the reference names", () => {
		assert.equal(reference.$schema, schema.$id);
	});

	it("rejects a builtin with no examples", () => {
		const broken = structuredClone(reference);
		broken.builtins[0].examples = [];
		assert.equal(validate(broken), false);
	});

	it("rejects a parameter type outside the value domain", () => {
		const broken = structuredClone(reference);
		broken.builtins[0].params[0].type = "integer";
		assert.equal(validate(broken), false);
	});

	it("rejects an unknown field, so a misspelling cannot pass as documentation", () => {
		const broken = structuredClone(reference);
		broken.builtins[0].sumary = "typo";
		assert.equal(validate(broken), false);
	});
});
