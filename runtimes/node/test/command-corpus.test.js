import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	COMMAND_SLOT_ACCEPT,
	ModManifestValidationError,
	mergeCommandArgs,
	normalizeModFills,
	resolveCommand,
	resolveCommands,
	resolveCommandsAll,
	slotKindForFill,
} from "../dist/index.js";

const corpusPath = fileURLToPath(new URL("../../../spec/command-tests.json", import.meta.url));
const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));

const OPTIONAL_KEYS = ["description", "icon", "group", "input", "output"];

function modInstance(name, commandFills) {
	return { name, commandFills };
}

function normalizeMod({ name, capabilities, fills }, slots) {
	return normalizeModFills(
		{ xript: "0.8", name, version: "1.0.0", fills },
		slots,
		new Set(capabilities ?? []),
	);
}

describe("command corpus — branch order", () => {
	assert.equal(corpus.commandAccept, COMMAND_SLOT_ACCEPT);

	corpus.branchOrder.forEach((testCase) => {
		it(testCase.description, () => {
			assert.equal(slotKindForFill({ accepts: testCase.accepts }, testCase.fill), testCase.expected);

			if (testCase.priorKind !== undefined) {
				const withoutCommand = testCase.accepts.filter((a) => a !== COMMAND_SLOT_ACCEPT);
				assert.equal(
					slotKindForFill({ accepts: withoutCommand }, testCase.fill),
					testCase.priorKind,
					"the pre-v0.8.0 reading of the same fill",
				);
			}
		});
	});
});

describe("command corpus — normalization", () => {
	corpus.normalize.forEach((testCase) => {
		it(testCase.description, () => {
			const slots = [{ id: testCase.slot, accepts: [COMMAND_SLOT_ACCEPT], multiple: true }];
			const manifest = { xript: "0.8", name: testCase.mod, version: "1.0.0", fills: { [testCase.slot]: testCase.fills } };

			if (!testCase.expected.ok) {
				let error = null;
				try {
					normalizeModFills(manifest, slots, new Set());
				} catch (thrown) {
					error = thrown;
				}
				assert.ok(error instanceof ModManifestValidationError, "expected a fill-time rejection");
				const expected = testCase.expected.error;
				const issue = error.issues.find((i) => i.code === expected.code);
				assert.ok(issue, `expected an issue coded '${expected.code}', got ${JSON.stringify(error.issues)}`);
				for (const key of ["fill", "id", "handler", "arg"]) {
					if (expected[key] === undefined) continue;
					assert.equal(issue.detail?.[key], expected[key], `issue detail.${key}`);
				}
				return;
			}

			const { commandFills } = normalizeModFills(manifest, slots, new Set());
			const commands = resolveCommandsAll(testCase.slot, [modInstance(testCase.mod, commandFills)]);
			assert.equal(commands.length, testCase.expected.commands.length);

			testCase.expected.commands.forEach((expected, index) => {
				const actual = commands[index];
				for (const [key, value] of Object.entries(expected)) {
					assert.deepEqual(actual[key], value, `command ${expected.id} key '${key}'`);
				}
				for (const key of OPTIONAL_KEYS) {
					if (key in expected) continue;
					assert.ok(!(key in actual), `command ${expected.id} should not carry '${key}'`);
				}
			});
		});
	});
});

describe("command corpus — bound arguments", () => {
	corpus.boundArgs.forEach((testCase) => {
		it(testCase.description, () => {
			assert.deepEqual(mergeCommandArgs(testCase.args, testCase.callArgs), testCase.expected);
		});
	});
});

describe("command corpus — resolution", () => {
	corpus.resolution.forEach((testCase) => {
		it(testCase.description, () => {
			const slots = testCase.slots;
			const slotId = slots[0].id;

			const instances = [];
			for (const mod of testCase.mods) {
				let normalized;
				try {
					normalized = normalizeMod(mod, slots);
				} catch (error) {
					// a mod without the slot's capability contributes nothing at all
					assert.ok(error instanceof ModManifestValidationError, error);
					continue;
				}
				instances.push(modInstance(mod.name, normalized.commandFills));
			}

			const resolved = resolveCommands(slotId, instances, slots);
			assert.deepEqual(resolved.map((c) => c.qualifiedId), testCase.expected.order);
			assert.deepEqual(
				resolved.filter((c) => c.collides).map((c) => c.qualifiedId),
				testCase.expected.collides,
			);

			if (testCase.lookup !== undefined) {
				const found = resolveCommand(testCase.lookup, instances, slots, testCase.preferences);
				assert.equal(found?.qualifiedId ?? null, testCase.expected.resolved);
			}
		});
	});
});
