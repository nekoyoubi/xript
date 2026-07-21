import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { treeToJsml } from "@xriptjs/sanitize";
import { sanitizeSource, FragmentFormatError } from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const corpusPath = resolve(__dirname, "../../../spec/fragment-vocabulary-tests.json");
const corpus = JSON.parse(await readFile(corpusPath, "utf-8"));

function treeToCorpusJson(tree) {
	return tree.map(node => {
		if (node.kind === "text") return { text: node.value };
		const entry = {
			name: node.name,
			props: { ...node.props },
			children: treeToCorpusJson(node.children),
		};
		if (node.selfClosing) entry.selfClosing = true;
		return entry;
	});
}

function diagnosticsToCorpusJson(diagnostics) {
	return diagnostics.map(diagnostic => {
		const entry = {
			code: diagnostic.code,
			severity: diagnostic.severity,
			path: diagnostic.path,
			node: diagnostic.node,
		};
		if (diagnostic.prop !== undefined) entry.prop = diagnostic.prop;
		entry.message = diagnostic.message;
		return entry;
	});
}

describe("fragment vocabulary conformance corpus", () => {
	for (const testCase of corpus) {
		it(testCase.description, () => {
			const options = {
				formats: testCase.formats ?? null,
				vocabularies: testCase.vocabularies ?? null,
			};

			if (testCase.expectedError) {
				assert.throws(
					() => sanitizeSource(testCase.source ?? "", testCase.format, options),
					(err) => {
						assert.ok(err instanceof FragmentFormatError);
						assert.equal(err.format, testCase.format);
						assert.equal(err.message, testCase.expectedError.message);
						return true;
					},
				);
				return;
			}

			const result = sanitizeSource(testCase.source, testCase.format, options);

			assert.equal(result.contentType, testCase.expected.contentType, "contentType");
			assert.equal(result.html, testCase.expected.html, "html");
			assert.deepEqual(treeToCorpusJson(result.tree), testCase.expected.tree, "tree");
			if (testCase.expected.jsml !== undefined) {
				assert.deepEqual(treeToJsml(result.tree), testCase.expected.jsml, "jsml");
			}
			assert.deepEqual(
				diagnosticsToCorpusJson(result.diagnostics),
				testCase.expected.diagnostics,
				"diagnostics",
			);
			assert.deepEqual(
				result.strippedElements,
				testCase.expected.strippedElements,
				"strippedElements",
			);
			assert.deepEqual(
				result.strippedAttributes,
				testCase.expected.strippedAttributes,
				"strippedAttributes",
			);
		});
	}
});
