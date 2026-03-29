export interface ScanResult {
	bindings: Record<string, unknown>;
	capabilities: Record<string, ScannedCapability>;
	diagnostics: ScanDiagnostic[];
}

export interface ScannedCapability {
	description: string;
	risk: "low" | "medium" | "high";
	referencedBy: string[];
}

export interface ScanDiagnostic {
	file: string;
	line: number;
	message: string;
	severity: "warning" | "error";
}

export interface MergeResult {
	manifest: unknown;
	added: string[];
	removed: string[];
	unchanged: string[];
	capabilityGaps: string[];
}

export async function scanDirectory(dir: string): Promise<ScanResult> {
	const { scanDirectoryImpl } = await import("./scanner.js");
	return scanDirectoryImpl(dir);
}

export async function scanFile(filePath: string): Promise<ScanResult> {
	const { scanFileImpl } = await import("./scanner.js");
	return scanFileImpl(filePath);
}

export async function mergeIntoManifest(existing: unknown, scanned: ScanResult): Promise<MergeResult> {
	const { mergeImpl } = await import("./merger.js");
	return mergeImpl(existing, scanned);
}
