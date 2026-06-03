import { validateManifest, crossValidate } from "./index.js";
import { gateCapabilities } from "./manifest-util.js";

export interface UtilizationMetric {
	score: number;
	used: string[];
	unused: string[];
}

/**
 * Moddability capacity: how much of xript's extension surface the host exposes,
 * against a ceiling of exposing all of it. A category counts as exposed when the
 * host declares at least one of it. Capacity only ever rises as a host exposes
 * more surface — inheriting slots through `extends` raises it, it never falls
 * for declaring a slot the host does not fill itself.
 */
export interface CapacityMetric {
	score: number;
	exposed: string[];
	absent: string[];
}

export interface IntegrityResult {
	passed: boolean;
	violations: string[];
	checks: number;
}

export interface ScoreResult {
	headline: number;
	integrity: IntegrityResult;
	capacity: CapacityMetric;
	slots: UtilizationMetric;
	capabilities: UtilizationMetric;
	gate?: { min: number; passed: boolean };
	disclaimer: string;
}

export interface ScoreOptions {
	min?: number;
	/** Slot ids the host inherited from an `extends` base rather than declaring locally. Excluded from the informational coverage figures. */
	inheritedSlots?: string[];
	/** Capability names the host inherited from an `extends` base rather than declaring locally. Excluded from the informational coverage figures. */
	inheritedCapabilities?: string[];
}

const DISCLAIMER =
	"Measures moddability capacity — how much of xript's extension surface the host exposes (bindings to call, slots to fill, events to observe, a capability model to gate them), against a ceiling of exposing all of it. It does not prove the surface is well-designed: a high score with a poorly drawn host/mod boundary is possible. Integrity violations are bugs. The slot and capability figures are informational mod-coverage of the host's own non-reserved surface, not part of the headline — exposing a slot no supplied mod fills is moddability, not waste.";

const CAPACITY_SURFACES = ["bindings", "slots", "capabilities", "events"] as const;

interface HostManifest {
	slots?: Array<{ id?: string; capability?: string; reserved?: boolean }>;
	capabilities?: Record<string, unknown>;
	bindings?: Record<string, unknown>;
	events?: unknown[];
}

interface ModManifest {
	name?: string;
	capabilities?: string[];
	fragments?: Array<{ slot?: string }>;
	fills?: Record<string, unknown>;
	contributions?: { slots?: Record<string, unknown> };
}

function slotIds(host: HostManifest): string[] {
	return (host.slots ?? []).map((slot) => slot.id).filter((id): id is string => Boolean(id));
}

function capabilityNames(host: HostManifest): string[] {
	return Object.keys(host.capabilities ?? {});
}

function surfaceExposed(host: HostManifest, key: (typeof CAPACITY_SURFACES)[number]): boolean {
	const value = (host as Record<string, unknown>)[key];
	if (Array.isArray(value)) return value.length > 0;
	if (value && typeof value === "object") return Object.keys(value).length > 0;
	return false;
}

function capacityOf(host: HostManifest): CapacityMetric {
	const exposed = CAPACITY_SURFACES.filter((surface) => surfaceExposed(host, surface));
	const absent = CAPACITY_SURFACES.filter((surface) => !surfaceExposed(host, surface));
	return { score: exposed.length / CAPACITY_SURFACES.length, exposed: [...exposed], absent: [...absent] };
}

function reservedSlotIds(host: HostManifest): Set<string> {
	return new Set((host.slots ?? []).filter((slot) => slot.reserved && slot.id).map((slot) => slot.id as string));
}

function reservedCapabilityNames(host: HostManifest): Set<string> {
	return new Set(
		Object.entries(host.capabilities ?? {})
			.filter(([, def]) => def && typeof def === "object" && (def as { reserved?: boolean }).reserved === true)
			.map(([name]) => name),
	);
}

function modSlotReferences(mods: ModManifest[]): Set<string> {
	const refs = new Set<string>();
	for (const mod of mods) {
		if (mod.fills && typeof mod.fills === "object") for (const slotId of Object.keys(mod.fills)) refs.add(slotId);
		const legacySlots = mod.contributions?.slots;
		if (legacySlots && typeof legacySlots === "object") for (const slotId of Object.keys(legacySlots)) refs.add(slotId);
		for (const fragment of mod.fragments ?? []) if (fragment.slot) refs.add(fragment.slot);
	}
	return refs;
}

function modCapabilityRequests(mods: ModManifest[]): Set<string> {
	const refs = new Set<string>();
	for (const mod of mods) for (const capability of mod.capabilities ?? []) refs.add(capability);
	return refs;
}

export async function scoreManifests(host: unknown, mods: unknown[], options: ScoreOptions = {}): Promise<ScoreResult> {
	const hostManifest = (host ?? {}) as HostManifest;
	const modManifests = mods.map((mod) => (mod ?? {}) as ModManifest);

	const violations: string[] = [];
	const hostValidation = await validateManifest(host);
	for (const error of hostValidation.errors) violations.push(`host ${error.path}: ${error.message}`);

	const declaredCaps = new Set(capabilityNames(hostManifest));
	for (const slot of hostManifest.slots ?? []) {
		if (slot.capability && !declaredCaps.has(slot.capability)) {
			violations.push(`slot "${slot.id ?? "?"}" references undeclared capability "${slot.capability}"`);
		}
	}

	for (const mod of modManifests) {
		const cross = await crossValidate(host, mod);
		for (const error of cross.errors) violations.push(`mod "${mod.name ?? "?"}" ${error.path}: ${error.message}`);
	}

	const integrity: IntegrityResult = {
		passed: violations.length === 0,
		violations,
		checks: 1 + (hostManifest.slots ?? []).length + modManifests.length,
	};

	const capacity = capacityOf(hostManifest);
	const headline = Math.round(100 * capacity.score);

	const inheritedSlots = new Set(options.inheritedSlots ?? []);
	const inheritedCaps = new Set(options.inheritedCapabilities ?? []);
	const reservedSlots = reservedSlotIds(hostManifest);
	const reservedCaps = reservedCapabilityNames(hostManifest);

	const ownSlots = slotIds(hostManifest).filter((id) => !inheritedSlots.has(id) && !reservedSlots.has(id));
	const usedSlots = modSlotReferences(modManifests);
	const usedSlotIds = ownSlots.filter((id) => usedSlots.has(id));
	const slotMetric: UtilizationMetric = {
		score: ownSlots.length ? usedSlotIds.length / ownSlots.length : 1,
		used: usedSlotIds,
		unused: ownSlots.filter((id) => !usedSlots.has(id)),
	};

	const ownCaps = capabilityNames(hostManifest).filter((name) => !inheritedCaps.has(name) && !reservedCaps.has(name));
	const referencedCaps = new Set([...modCapabilityRequests(modManifests), ...gateCapabilities(host)]);
	const usedCapNames = ownCaps.filter((name) => referencedCaps.has(name));
	const capabilityMetric: UtilizationMetric = {
		score: ownCaps.length ? usedCapNames.length / ownCaps.length : 1,
		used: usedCapNames,
		unused: ownCaps.filter((name) => !referencedCaps.has(name)),
	};

	const result: ScoreResult = { headline, integrity, capacity, slots: slotMetric, capabilities: capabilityMetric, disclaimer: DISCLAIMER };
	if (options.min !== undefined) {
		result.gate = { min: options.min, passed: integrity.passed && headline >= options.min };
	}
	return result;
}

export interface MetricDiff {
	baseline: number;
	current: number;
	delta: number;
	gained: string[];
	lost: string[];
}

export interface ScoreDiff {
	direction: "improved" | "regressed" | "unchanged";
	headline: { baseline: number; current: number; delta: number };
	capacity: MetricDiff;
	slots: MetricDiff;
	capabilities: MetricDiff;
	integrity: { baselineViolations: number; currentViolations: number; introduced: string[]; fixed: string[] };
	gate?: { minDelta: number; passed: boolean };
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

function metricDiff(baseline: UtilizationMetric, current: UtilizationMetric): MetricDiff {
	return {
		baseline: round3(baseline.score),
		current: round3(current.score),
		delta: round3(current.score - baseline.score),
		gained: current.used.filter((id) => !baseline.used.includes(id)),
		lost: current.unused.filter((id) => !baseline.unused.includes(id)),
	};
}

function capacityDiff(baseline: CapacityMetric, current: CapacityMetric): MetricDiff {
	return {
		baseline: round3(baseline.score),
		current: round3(current.score),
		delta: round3(current.score - baseline.score),
		gained: current.exposed.filter((surface) => !baseline.exposed.includes(surface)),
		lost: current.absent.filter((surface) => !baseline.absent.includes(surface)),
	};
}

export function diffScores(baseline: ScoreResult, current: ScoreResult, options: { minDelta?: number } = {}): ScoreDiff {
	const baselineViolations = new Set(baseline.integrity.violations);
	const currentViolations = new Set(current.integrity.violations);
	const introduced = current.integrity.violations.filter((v) => !baselineViolations.has(v));
	const fixed = baseline.integrity.violations.filter((v) => !currentViolations.has(v));
	const headlineDelta = current.headline - baseline.headline;

	const direction = introduced.length > 0 || headlineDelta < 0 ? "regressed" : headlineDelta > 0 ? "improved" : "unchanged";

	const diff: ScoreDiff = {
		direction,
		headline: { baseline: baseline.headline, current: current.headline, delta: headlineDelta },
		capacity: capacityDiff(baseline.capacity, current.capacity),
		slots: metricDiff(baseline.slots, current.slots),
		capabilities: metricDiff(baseline.capabilities, current.capabilities),
		integrity: { baselineViolations: baseline.integrity.violations.length, currentViolations: current.integrity.violations.length, introduced, fixed },
	};
	if (options.minDelta !== undefined) {
		diff.gate = { minDelta: options.minDelta, passed: introduced.length === 0 && headlineDelta >= options.minDelta };
	}
	return diff;
}
