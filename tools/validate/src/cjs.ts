const REQUIRE_CALL = /\brequire\s*\(/;
const MODULE_EXPORTS = /\bmodule\s*\.\s*exports\b/;
const EXPORTS_ASSIGN = /\bexports\s*\.\s*[A-Za-z_$][\w$]*\s*=/;
const EXPORTS_INDEX = /\bexports\s*\[/;

export type CommonJsArtifact = "require()" | "module.exports" | "exports.x";

export function detectCommonJs(source: string): CommonJsArtifact | null {
	if (REQUIRE_CALL.test(source)) return "require()";
	if (MODULE_EXPORTS.test(source)) return "module.exports";
	if (EXPORTS_ASSIGN.test(source) || EXPORTS_INDEX.test(source)) return "exports.x";
	return null;
}

export const COMMONJS_GUIDE_URL = "https://xript.dev/guides/authoring-mods-in-typescript";

export function commonJsMessage(artifact: CommonJsArtifact): string {
	return (
		`CommonJS artifacts detected in mod entry (found: ${artifact}). ` +
		`xript mods must be authored as ES modules (entry.format: "module", top-level export) ` +
		`or as classic scripts using xript.exports.register — never CommonJS. ` +
		`Fix your tsconfig to emit ESM (module: "esnext", moduleResolution: "bundler"/"nodenext") ` +
		`or remove the require()/module.exports usage. See ${COMMONJS_GUIDE_URL}.`
	);
}
