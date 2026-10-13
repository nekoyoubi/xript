export function readEntryBlock(manifest: unknown): { script: string; format: string; exports: string[] } | null {
	if (typeof manifest !== "object" || manifest === null) return null;
	const entry = (manifest as Record<string, unknown>).entry;
	if (typeof entry === "string") {
		return { script: entry, format: "script", exports: [] };
	}
	if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
	const block = entry as Record<string, unknown>;
	const script = typeof block.script === "string" ? block.script : "";
	if (!script) return null;
	const format = typeof block.format === "string" ? block.format : "script";
	const exportsMap = block.exports;
	const exportNames =
		typeof exportsMap === "object" && exportsMap !== null
			? Object.keys(exportsMap as Record<string, unknown>)
			: [];
	return { script, format, exports: exportNames };
}
