export type Severity = "error" | "warn" | "info";

export interface Finding {
	severity: Severity;
	code: string;
	message: string;
	suggestion: string;
}

export interface LintCounts {
	error: number;
	warn: number;
	info: number;
}

export interface LintResult {
	findings: Finding[];
	counts: LintCounts;
}

export interface LintOptions {
	strict?: boolean;
	/**
	 * Slot ids the host inherited from an `extends` base (or embedded canon) rather than
	 * declaring locally. An inherited-but-unfilled slot is not a defect, so the dead-slot
	 * check stays silent on these. Default (omitted) treats every slot as local.
	 */
	inheritedSlots?: string[];
	/**
	 * Capability names the host inherited from an `extends` base (or embedded canon) rather
	 * than declaring locally. An inherited-but-unreferenced capability is not vestigial, so
	 * the vestigial-capability check stays silent on these. Default (omitted) treats every
	 * capability as local.
	 */
	inheritedCapabilities?: string[];
	/**
	 * Type names the host inherited from an `extends` base (or embedded canon) that remain
	 * abstract in the resolved manifest — declared typed holes the host never filled. Each is
	 * a defect, surfaced as an `abstract-type-unfilled` error. A locally-declared abstract type
	 * is not inherited and is not flagged. Default (omitted) means nothing is unfilled.
	 */
	inheritedAbstractTypes?: string[];
}

import { gateCapabilities } from "./manifest-util.js";
import { satisfies } from "./capabilities.js";

interface HostSlot {
	id?: string;
	accepts?: string[];
	capability?: string;
	description?: string;
	reserved?: boolean;
}

interface HostManifest {
	slots?: HostSlot[];
	capabilities?: Record<string, { description?: string } | unknown>;
	libraries?: Record<string, { capability?: string; description?: string }>;
}

interface ModManifest {
	name?: string;
	capabilities?: string[];
	fragments?: Array<{ slot?: string }>;
	fills?: Record<string, unknown>;
	contributions?: { slots?: Record<string, unknown> };
}

function declaredSatisfiesRef(declared: Set<string>, ref: string): boolean {
	for (const scope of declared) {
		if (satisfies(scope, ref)) return true;
	}
	return false;
}

function slotFillReferences(mod: ModManifest): Set<string> {
	const refs = new Set<string>();
	if (mod.fills && typeof mod.fills === "object") for (const slotId of Object.keys(mod.fills)) refs.add(slotId);
	const legacySlots = mod.contributions?.slots;
	if (legacySlots && typeof legacySlots === "object") for (const slotId of Object.keys(legacySlots)) refs.add(slotId);
	for (const fragment of mod.fragments ?? []) if (fragment.slot) refs.add(fragment.slot);
	return refs;
}

export function lintManifests(host: unknown, mods: unknown[] = [], options: LintOptions = {}): LintResult {
	const hostManifest = (host ?? {}) as HostManifest;
	const modManifests = mods.map((mod) => (mod ?? {}) as ModManifest);
	const findings: Finding[] = [];

	const inheritedSlots = new Set(options.inheritedSlots ?? []);
	const inheritedCapabilities = new Set(options.inheritedCapabilities ?? []);
	const inheritedAbstractTypes = options.inheritedAbstractTypes ?? [];

	const slots = hostManifest.slots ?? [];
	const declaredSlotIds = new Set(slots.map((slot) => slot.id).filter((id): id is string => Boolean(id)));
	const declaredCapabilities = new Set(Object.keys(hostManifest.capabilities ?? {}));

	const filledSlotIds = new Set<string>();
	const requestedCapabilities = new Set<string>();
	for (const mod of modManifests) {
		for (const slotId of slotFillReferences(mod)) filledSlotIds.add(slotId);
		for (const cap of mod.capabilities ?? []) requestedCapabilities.add(cap);
	}

	for (const mod of modManifests) {
		const label = mod.name ? `mod "${mod.name}"` : "a mod";
		if (mod.fragments !== undefined || mod.contributions !== undefined) {
			findings.push({
				severity: "info",
				code: "legacy-shape",
				message: `${label} uses the deprecated contribution shape (${mod.fragments !== undefined ? "`fragments`" : "`contributions`"})`,
				suggestion: `Move its slot fills under \`fills\`, keyed by host slot id, so the mod is on the current contribution surface.`,
			});
		}
		for (const slotId of slotFillReferences(mod)) {
			if (!declaredSlotIds.has(slotId)) {
				findings.push({
					severity: "error",
					code: "filled-but-undeclared",
					message: `${label} fills slot "${slotId}" which the host does not declare`,
					suggestion: `Declare a slot with id "${slotId}" in the host manifest, or remove the fill.`,
				});
			}
		}
		for (const cap of mod.capabilities ?? []) {
			if (!declaredSatisfiesRef(declaredCapabilities, cap)) {
				findings.push({
					severity: "error",
					code: "undeclared-capability",
					message: `${label} requests capability "${cap}" which the host does not declare`,
					suggestion: `Declare capability "${cap}" in the host manifest, or drop it from the mod.`,
				});
			}
		}
	}

	for (const slot of slots) {
		if (slot.capability && !declaredSatisfiesRef(declaredCapabilities, slot.capability)) {
			findings.push({
				severity: "error",
				code: "undeclared-capability",
				message: `slot "${slot.id ?? "?"}" gates on capability "${slot.capability}" which the host does not declare`,
				suggestion: `Declare capability "${slot.capability}" in the host manifest, or change the slot's gate.`,
			});
		}
	}

	for (const [specifier, library] of Object.entries(hostManifest.libraries ?? {})) {
		if (library?.capability && !declaredSatisfiesRef(declaredCapabilities, library.capability)) {
			findings.push({
				severity: "error",
				code: "undeclared-capability",
				message: `library "${specifier}" gates on capability "${library.capability}" which the host does not declare`,
				suggestion: `Declare capability "${library.capability}" in the host manifest, or change the library's gate.`,
			});
		}
	}

	for (const slot of slots) {
		const id = slot.id;
		if (id && !filledSlotIds.has(id) && !slot.reserved && !inheritedSlots.has(id)) {
			findings.push({
				severity: "warn",
				code: "dead-slot",
				message: `slot "${id}" is declared but no supplied mod fills it`,
				suggestion: `Mark the slot \`"reserved": true\` if it is intentionally declared for canon parity or future mods, or drop it.`,
			});
		}
	}

	const gatedCapabilities = gateCapabilities(hostManifest);
	for (const [name, def] of Object.entries(hostManifest.capabilities ?? {})) {
		const reserved = def && typeof def === "object" && (def as { reserved?: boolean }).reserved === true;
		const usedByGate = [...gatedCapabilities].some((ref) => satisfies(name, ref));
		const usedByMod = [...requestedCapabilities].some((ref) => satisfies(name, ref));
		if (!usedByGate && !usedByMod && !reserved && !inheritedCapabilities.has(name)) {
			findings.push({
				severity: "warn",
				code: "vestigial-capability",
				message: `capability "${name}" is declared but no slot, binding, hook, or mod references it`,
				suggestion: `Mark it \`"reserved": true\` if it is declared for canon parity, gate a slot, binding, or hook on it, or drop it.`,
			});
		}
	}

	for (const name of inheritedAbstractTypes) {
		findings.push({
			severity: "error",
			code: "abstract-type-unfilled",
			message: `type "${name}" was inherited as abstract and is never filled`,
			suggestion: `Redeclare type "${name}" with concrete \`fields\` or \`values\` to fill the inherited abstract definition.`,
		});
	}

	for (const slot of slots) {
		if (!slot.capability) {
			findings.push({
				severity: "info",
				code: "ungated-slot",
				message: `slot "${slot.id ?? "?"}" declares no capability — any mod may fill it`,
				suggestion: `Gate the slot with a capability if filling it should require a grant.`,
			});
		}
	}

	for (const slot of slots) {
		if (!slot.description) {
			findings.push({
				severity: "info",
				code: "undescribed",
				message: `slot "${slot.id ?? "?"}" has no description`,
				suggestion: `Add a description so mod authors know what the slot is for.`,
			});
		}
	}
	for (const [name, def] of Object.entries(hostManifest.capabilities ?? {})) {
		const description = def && typeof def === "object" ? (def as { description?: string }).description : undefined;
		if (!description) {
			findings.push({
				severity: "info",
				code: "undescribed",
				message: `capability "${name}" has no description`,
				suggestion: `Add a description so mod authors know what the capability grants.`,
			});
		}
	}

	for (const finding of escalationFindings(declaredCapabilities)) findings.push(finding);

	const counts: LintCounts = { error: 0, warn: 0, info: 0 };
	for (const finding of findings) counts[finding.severity]++;

	return { findings, counts };
}

/**
 * Scope segments whose name conventionally connotes broad or administrative authority.
 * A child scope ending in one of these, nested under a declared (broadly grantable)
 * ancestor, is a candidate monotonic-privilege violation: a grant on the ancestor would
 * subsume the escalation child by prefix even though the child's authority exceeds it.
 */
const ESCALATION_SEGMENTS = new Set(["admin", "shell", "exec", "root", "sudo", "all", "host"]);

/**
 * Heuristic, well-formed-only pass behind the per-host monotonic-privilege audit discipline:
 * the runtime cannot verify privilege ordering, so this flags candidate escalations by name.
 * A clean result is NOT a proof of monotonicity. A declared capability whose final dotted
 * segment is an escalation word and which has a declared dotted ancestor is surfaced, since a
 * broad grant on that ancestor would silently sweep the escalation child in by prefix.
 */
function escalationFindings(declaredCapabilities: Set<string>): Finding[] {
	const findings: Finding[] = [];
	for (const cap of declaredCapabilities) {
		const segments = cap.split(".");
		if (segments.length < 2) continue;
		const leaf = segments[segments.length - 1];
		if (!ESCALATION_SEGMENTS.has(leaf)) continue;

		const ancestors: string[] = [];
		for (let i = 1; i < segments.length; i++) ancestors.push(segments.slice(0, i).join("."));
		const grantableAncestor = ancestors.find((ancestor) => declaredCapabilities.has(ancestor));
		if (!grantableAncestor) continue;

		findings.push({
			severity: "warn",
			code: "capability-escalation",
			message: `capability "${cap}" names an escalation segment ("${leaf}") nested under broadly grantable ancestor "${grantableAncestor}"`,
			suggestion: `A grant on "${grantableAncestor}" subsumes "${cap}" by prefix. If "${cap}" confers more than its ancestor, re-root it under a separate top-level scope rather than nest it. Verify by inspection — a clean lint is not a proof of monotonicity.`,
		});
	}
	return findings;
}
