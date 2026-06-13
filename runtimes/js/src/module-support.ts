import { CommonJSDetectedError } from "./errors.js";

const REQUIRE_CALL = /\brequire\s*\(/;
const MODULE_EXPORTS = /\bmodule\.exports\b/;
const EXPORTS_ASSIGN = /\bexports\s*(?:\.[A-Za-z_$][\w$]*|\[)\s*=/;

export function detectCommonJS(source: string): string | null {
	if (REQUIRE_CALL.test(source)) return "require()";
	if (MODULE_EXPORTS.test(source)) return "module.exports";
	if (EXPORTS_ASSIGN.test(source)) return "exports.x";
	return null;
}

export function assertNoCommonJS(source: string): void {
	const artifact = detectCommonJS(source);
	if (artifact) throw new CommonJSDetectedError(artifact);
}

const STATIC_IMPORT = /(?:^|[\n;])\s*import\b[^;'"`]*?from\s*["']([^"']+)["']/;
const BARE_SIDE_EFFECT_IMPORT = /(?:^|[\n;])\s*import\s*["']([^"']+)["']/;
const EXPORT_FROM = /(?:^|[\n;])\s*export\b[^;'"`]*?from\s*["']([^"']+)["']/;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*["']([^"']+)["']/;

export function findImportSpecifier(source: string): string | null {
	for (const pattern of [STATIC_IMPORT, BARE_SIDE_EFFECT_IMPORT, EXPORT_FROM, DYNAMIC_IMPORT]) {
		const match = pattern.exec(source);
		if (match) return match[1];
	}
	return null;
}

export interface FoundImport {
	specifier: string;
	dynamic: boolean;
}

export function findImportSpecifiers(source: string): FoundImport[] {
	const found: FoundImport[] = [];
	for (const [pattern, dynamic] of [
		[STATIC_IMPORT, false],
		[BARE_SIDE_EFFECT_IMPORT, false],
		[EXPORT_FROM, false],
		[DYNAMIC_IMPORT, true],
	] as Array<[RegExp, boolean]>) {
		const global = new RegExp(pattern.source, "g");
		for (const match of source.matchAll(global)) {
			found.push({ specifier: match[1], dynamic });
		}
	}
	return found;
}
