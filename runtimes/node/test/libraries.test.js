import { describe, it } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {
	createRuntime,
	ImportDeniedError,
	CapabilityDeniedError,
	LibraryUnavailableError,
	LibraryRegistrationError,
} from "../dist/index.js";

const hasVmModules = typeof vm.SourceTextModule === "function";
const skipModuleEval = hasVmModules ? false : "requires --experimental-vm-modules";

const DOC_LIB = `export function shout(s){ return s.toUpperCase() + "!"; }
export const NAME = "doc-lib";`;

const hostManifest = {
	xript: "0.7",
	name: "library-host",
	capabilities: {
		lib: { description: "shared libraries" },
	},
	libraries: {
		"@example/doc": { description: "doc helpers", capability: "lib.doc", version: "^1.0.0" },
		"open-lib": { description: "ungated helpers" },
	},
};

function modManifest() {
	return {
		xript: "0.7",
		name: "lib-consumer",
		version: "1.0.0",
		entry: { script: "mod.js", format: "module", exports: { use: { description: "uses the lib" } } },
	};
}

function makeRuntime(options = {}) {
	return createRuntime(hostManifest, { hostBindings: {}, ...options });
}

describe("approved libraries (node SourceTextModule)", { skip: skipModuleEval }, () => {
	it("links an approved library into a mod with full-fidelity calls", async () => {
		const runtime = makeRuntime({ capabilities: ["lib.doc"], libraries: { "@example/doc": DOC_LIB } });
		await runtime.loadModAsync(modManifest(), {
			fragmentSources: { "mod.js": `import { shout, NAME } from "@example/doc";\nexport function use(s){ return NAME + ": " + shout(s); }` },
		});
		assert.equal(runtime.invokeExport("use", ["hi"]), "doc-lib: HI!");
	});

	it("satisfies the library gate through capability subsumption", async () => {
		const runtime = makeRuntime({ capabilities: ["lib"], libraries: { "@example/doc": DOC_LIB } });
		await runtime.loadModAsync(modManifest(), {
			fragmentSources: { "mod.js": `import { shout } from "@example/doc";\nexport function use(s){ return shout(s); }` },
		});
		assert.equal(runtime.invokeExport("use", ["ok"]), "OK!");
	});

	it("denies an undeclared specifier with ImportDeniedError", async () => {
		const runtime = makeRuntime({ capabilities: ["lib"], libraries: { "@example/doc": DOC_LIB } });
		await assert.rejects(
			() =>
				runtime.loadModAsync(modManifest(), {
					fragmentSources: { "mod.js": `import _ from "lodash";\nexport function use(){ return 1; }` },
				}),
			(error) => error instanceof ImportDeniedError && error.specifier === "lodash",
		);
	});

	it("denies an ungranted library with CapabilityDeniedError", async () => {
		const runtime = makeRuntime({ libraries: { "@example/doc": DOC_LIB } });
		await assert.rejects(
			() =>
				runtime.loadModAsync(modManifest(), {
					fragmentSources: { "mod.js": `import { shout } from "@example/doc";\nexport function use(){ return 1; }` },
				}),
			(error) => error instanceof CapabilityDeniedError && error.capability === "lib.doc",
		);
	});

	it("allows an ungated library with no grants at all", async () => {
		const runtime = makeRuntime({ libraries: { "open-lib": `export function id(x){ return x; }` } });
		await runtime.loadModAsync(modManifest(), {
			fragmentSources: { "mod.js": `import { id } from "open-lib";\nexport function use(x){ return id(x); }` },
		});
		assert.equal(runtime.invokeExport("use", [9]), 9);
	});

	it("names the host bug when a declared library was never registered", async () => {
		const runtime = makeRuntime({ capabilities: ["lib"] });
		await assert.rejects(
			() =>
				runtime.loadModAsync(modManifest(), {
					fragmentSources: { "mod.js": `import { shout } from "@example/doc";\nexport function use(){ return 1; }` },
				}),
			(error) => error instanceof LibraryUnavailableError && error.specifier === "@example/doc",
		);
	});

	it("rejects registering a source for an undeclared specifier", () => {
		assert.throws(
			() => makeRuntime({ libraries: { rogue: `export const x = 1;` } }),
			(error) => error instanceof LibraryRegistrationError && error.specifier === "rogue",
		);
	});

	it("rejects a library that is not import-clean", () => {
		assert.throws(
			() => makeRuntime({ libraries: { "@example/doc": `import _ from "lodash";\nexport function shout(){}` } }),
			(error) => error instanceof LibraryRegistrationError && /import-clean/.test(error.message),
		);
	});

	it("rejects a library carrying CommonJS artifacts", () => {
		assert.throws(
			() => makeRuntime({ libraries: { "@example/doc": `const _ = require("lodash"); module.exports = {};` } }),
			(error) => error instanceof LibraryRegistrationError && /CommonJS/.test(error.message),
		);
	});

	it("still denies dynamic import of an approved specifier", async () => {
		const runtime = makeRuntime({ capabilities: ["lib"], libraries: { "@example/doc": DOC_LIB } });
		await assert.rejects(
			() =>
				runtime.loadModAsync(modManifest(), {
					fragmentSources: { "mod.js": `export async function use(){ const m = await import("@example/doc"); return m.NAME; }` },
				}),
			(error) => error instanceof ImportDeniedError && error.specifier === "@example/doc",
		);
	});

	it("shares one library instance across imports in a runtime", async () => {
		const runtime = makeRuntime({
			capabilities: ["lib"],
			libraries: { "open-lib": `export const bag = []; export function push(x){ bag.push(x); return bag.length; }` },
		});
		await runtime.loadModAsync(modManifest(), {
			fragmentSources: { "mod.js": `import { push } from "open-lib";\nexport function use(x){ return push(x); }` },
		});
		assert.equal(runtime.invokeExport("use", ["a"]), 1);
		assert.equal(runtime.invokeExport("use", ["b"]), 2);
	});
});
