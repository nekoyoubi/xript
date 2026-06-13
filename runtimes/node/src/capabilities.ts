type CapabilityMode = "read" | "write";

interface ParsedCapability {
	mode: string;
	scope: string;
}

export function splitMode(cap: string): ParsedCapability {
	const i = cap.indexOf(":");
	if (i < 0) {
		return { mode: "write", scope: cap };
	}
	return { mode: cap.slice(0, i), scope: cap.slice(i + 1) };
}

function modeSatisfies(grantMode: string, requireMode: string): boolean {
	return grantMode === "write" || grantMode === requireMode;
}

function scopeSubsumes(grantScope: string, requireScope: string): boolean {
	return grantScope === requireScope || requireScope.startsWith(grantScope + ".");
}

export function satisfies(grant: string, require: string): boolean {
	const g = splitMode(grant);
	const r = splitMode(require);
	return modeSatisfies(g.mode, r.mode) && scopeSubsumes(g.scope, r.scope);
}

export function grantedSatisfies(granted: Set<string> | Iterable<string>, require: string): boolean {
	for (const grant of granted) {
		if (satisfies(grant, require)) return true;
	}
	return false;
}

export type { CapabilityMode };
