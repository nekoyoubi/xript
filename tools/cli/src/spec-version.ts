import {
	CURRENT_SPEC_VERSION,
	SUPPORTED_SPEC_VERSIONS,
	describeTargetVersion,
	validateManifestFile,
	validateManifestVersioned,
	type Finding,
	type LintResult,
	type ValidationResult,
	type VersionedValidationOptions,
} from "@xriptjs/validate";

/**
 * The convention every manifest-taking command and MCP tool follows: an optional target
 * manifest version, defaulting to the one the manifest declares (`$schema`, then `xript`), and
 * the answer reported against that version's schema rather than whatever the toolchain's own
 * version happens to be.
 */
export const SPEC_FLAG = "--spec";

/** Pulls `--spec <version>` out of an argument list, returning the version and the remaining args. */
export function takeSpecFlag(args: string[]): { version?: string; rest: string[]; missing: boolean } {
	const index = args.indexOf(SPEC_FLAG);
	if (index === -1) return { rest: args, missing: false };
	const version = args[index + 1];
	if (version === undefined || version.startsWith("-")) return { rest: args.filter((_, i) => i !== index), missing: true };
	return { version, rest: args.filter((_, i) => i !== index && i !== index + 1), missing: false };
}

/** What the toolchain speaks, for `--version` and `xript_server_info`. */
export function speaksSummary(): { manifestVersions: string[]; defaultManifestVersion: string } {
	return { manifestVersions: [...SUPPORTED_SPEC_VERSIONS], defaultManifestVersion: CURRENT_SPEC_VERSION };
}

export interface VersionCheck {
	result: ValidationResult;
	/** Lines describing the target and any violation of its schema, for a generator to surface. */
	notes: string[];
	/** True when the version itself could not be honored (an unsupported explicit version). */
	fatal: boolean;
}

function notesFor(result: ValidationResult): VersionCheck {
	const fatal = result.errors.some((error) => error.keyword === "version");
	if (fatal) return { result, notes: result.errors.map((error) => error.message), fatal };
	const notes: string[] = [];
	const target = result.target ? describeTargetVersion(result.target) : undefined;
	if (!result.valid) {
		notes.push(`not valid against ${target ?? "the manifest schema"}:`);
		for (const error of result.errors) notes.push(`  ${error.path}: ${error.message}`);
	} else if (result.target?.note && target) {
		notes.push(`answering for ${target}`);
	}
	return { result, notes, fatal };
}

/** Checks a manifest file against the schema of the version it targets. */
export async function checkFileVersion(path: string, version?: string): Promise<VersionCheck> {
	return notesFor(await validateManifestFile(path, version !== undefined ? { version } : {}));
}

/**
 * For a generator command: checks the manifest file against its target version and writes any
 * finding to stderr as a warning, leaving stdout to the generated output. Returns false only when
 * the requested version cannot be honored at all.
 */
export async function reportVersion(path: string, version?: string): Promise<boolean> {
	const check = await checkFileVersion(path, version);
	if (check.fatal) {
		for (const note of check.notes) console.error(`Error: ${note}`);
		return false;
	}
	for (const note of check.notes) console.error(`\x1b[33m!\x1b[0m ${note}`);
	return true;
}

/**
 * Lint findings for a manifest checked against its target version: an error per schema violation,
 * and a note when the manifest named a version the toolchain does not speak. `label` names the
 * manifest in each message (`host`, `mod "panel"`).
 */
export async function versionFindings(manifest: unknown, label: string, options: VersionedValidationOptions = {}): Promise<Finding[]> {
	const result = await validateManifestVersioned(manifest, options);
	const versionError = result.errors.find((error) => error.keyword === "version");
	if (versionError) throw new Error(versionError.message);
	const target = result.target ? describeTargetVersion(result.target) : "the manifest schema";
	const findings: Finding[] = result.errors.map((error) => ({
		severity: "error",
		code: "schema-version",
		message: `${label} is not valid against ${target}: ${error.path} ${error.message}`,
		suggestion: `Fix the manifest for the version it targets, or target a different version with \`--spec\` (or the \`version\` argument over MCP) if it was written for one.`,
	}));
	if (result.target?.note) {
		findings.push({
			severity: "info",
			code: "version-fallback",
			message: `${label}: ${result.target.note}`,
			suggestion: `Declare a manifest version this toolchain speaks (${SUPPORTED_SPEC_VERSIONS.join(", ")}) in \`xript\`.`,
		});
	}
	return findings;
}

/** Folds extra findings into a lint result, keeping its counts true. */
export function withFindings(result: LintResult, extra: Finding[]): LintResult {
	const findings = [...extra, ...result.findings];
	const counts = { error: 0, warn: 0, info: 0 };
	for (const finding of findings) counts[finding.severity]++;
	return { findings, counts };
}

/** Checks an in-memory manifest against the schema of the version it targets. */
export async function checkManifestVersion(manifest: unknown, options: VersionedValidationOptions = {}): Promise<VersionCheck> {
	return notesFor(await validateManifestVersioned(manifest, options));
}
