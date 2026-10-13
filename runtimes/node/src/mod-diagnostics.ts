import type { FragmentDeclaration } from "./fragment.js";

/**
 * What a load-time mod diagnostic reports. Held to `spec/mod-load-tests.json` by every
 * runtime, so a code means the same thing whichever runtime raised it.
 *
 * - `missing-entry-script`: `entry` names a script the host did not supply
 * - `entry-failed`: evaluating the entry threw (a top-level throw, a refused import, a
 *   module whose exports could not be read)
 * - `markup-source-not-inline`: a fragment's `source` is markup, but `inline` is not
 *   `true`, so it was looked up as a file name and found nothing
 * - `missing-fragment-source`: a fragment's `source` names a file the host did not supply
 * - `deprecated-events-alias`: a fragment declares handlers under the deprecated `events`
 *   key; reported once per mod
 */
export type ModDiagnosticCode =
	| "missing-entry-script"
	| "entry-failed"
	| "markup-source-not-inline"
	| "missing-fragment-source"
	| "deprecated-events-alias";

/** A finding about a mod raised while loading it. */
export interface ModDiagnostic {
	code: ModDiagnosticCode;
	/** `error` for an entry that did not run; `warning` for a mod that loaded but likely not as its author meant. */
	severity: "error" | "warning";
	/** The mod's `name`. */
	mod: string;
	message: string;
	/** The entry script, for entry diagnostics. */
	script?: string;
	/** The fragment fill, for fragment diagnostics. */
	fragmentId?: string;
	/** The fill field the finding is about, e.g. `source` or `events`. */
	field?: string;
}

/** Receives every {@link ModDiagnostic} as it is raised, whatever the entry error policy. */
export type ModDiagnosticListener = (diagnostic: ModDiagnostic) => void;

/**
 * What `loadMod` does when a mod's entry cannot run: a script the host did not supply, or
 * one that throws while evaluating.
 *
 * - `throw` (the default): `loadMod` throws, and the mod is not registered
 * - `report`: the failure is recorded on `ModInstance.diagnostics` and sent to
 *   `onModDiagnostic`, and the mod is registered without whatever its entry did not run.
 *   This is for a host that would rather boot with one broken mod than not boot at all
 */
export type EntryErrorPolicy = "throw" | "report";

/**
 * True when a fragment `source` reads as content rather than a file name: markup that
 * opens with a tag, or a JSON document (a JSML tree is a JSON array).
 */
export function looksLikeMarkup(source: string): boolean {
	const trimmed = source.trim();
	if (trimmed.startsWith("<")) return true;
	if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) return false;
	try {
		JSON.parse(trimmed);
		return true;
	} catch {
		return false;
	}
}

function hasSource(sources: Record<string, string>, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(sources, key) && typeof sources[key] === "string";
}

/**
 * Looks a script or fragment file up in the host-supplied sources, by own key only. An
 * empty string is a supplied source with an empty body, not a missing one.
 */
export function suppliedSource(sources: Record<string, string>, key: string): string | undefined {
	return hasSource(sources, key) ? sources[key] : undefined;
}

/**
 * The load-time findings a mod's fragment declarations raise against the sources the host
 * supplied, in declaration order: a non-inline `source` that resolves to nothing, and the
 * deprecated `events` alias, once per mod.
 */
export function fragmentDeclarationDiagnostics(
	modName: string,
	fragments: readonly FragmentDeclaration[],
	sources: Record<string, string>,
): ModDiagnostic[] {
	const diagnostics: ModDiagnostic[] = [];
	let reportedEventsAlias = false;

	for (const fragment of fragments) {
		if (fragment.inline !== true && typeof fragment.source === "string" && !hasSource(sources, fragment.source)) {
			if (looksLikeMarkup(fragment.source)) {
				diagnostics.push({
					code: "markup-source-not-inline",
					severity: "warning",
					mod: modName,
					fragmentId: fragment.id,
					field: "source",
					message:
						`fragment "${fragment.id}" of mod "${modName}" carries markup in "source" without "inline": true, ` +
						`so it was looked up as a file name, found nothing, and mounts empty; set "inline": true`,
				});
			} else {
				diagnostics.push({
					code: "missing-fragment-source",
					severity: "warning",
					mod: modName,
					fragmentId: fragment.id,
					field: "source",
					message:
						`fragment "${fragment.id}" of mod "${modName}" names source "${fragment.source}", ` +
						`which was not supplied in fragmentSources, so it mounts empty`,
				});
			}
		}

		if (!reportedEventsAlias && fragment.events !== undefined) {
			reportedEventsAlias = true;
			diagnostics.push({
				code: "deprecated-events-alias",
				severity: "warning",
				mod: modName,
				fragmentId: fragment.id,
				field: "events",
				message:
					`mod "${modName}" declares fragment handlers under the deprecated "events" key ` +
					`(first on fragment "${fragment.id}"); rename it to "handlers"`,
			});
		}
	}

	return diagnostics;
}
