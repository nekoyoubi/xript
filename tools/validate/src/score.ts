import { validateManifest, crossValidate } from "./core.js";
import { gateCapabilities } from "./manifest-util.js";
import { satisfies } from "./capabilities.js";
import { isCommandSlot } from "./commands.js";
import { executionSurfaces, type Duration } from "./execution.js";

export interface UtilizationMetric {
	/**
	 * Fraction of the host's own non-reserved surface a supplied mod set covers. An empty
	 * surface scores `1` — vacuously, nothing is uncovered — which is right for a gate and
	 * wrong to render as a full bar. Read `total` before presenting this as a percentage.
	 */
	score: number;
	/** How many entries the fraction is over. `0` means the host declares none of this surface. */
	total: number;
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

/**
 * The host's declared fragment vocabularies. Informational, not part of the headline: a format
 * is not an independent extension surface, it refines the slot surface — a format only means
 * anything through a slot whose `accepts` names it. A declared format no slot accepts is
 * unreachable, which is what the figures are for.
 */
export interface FormatSurface {
	declared: string[];
	nodes: number;
	reachable: string[];
	unreachable: string[];
	vocabularies: string[];
	vocabulariesUnreachable: string[];
}

/**
 * The host's command slots. Informational, not part of the headline: a command slot IS a slot,
 * already counted by the slot surface — counting it again would double-count and would move every
 * existing host's denominator for exposing nothing new. The figures say what kind of command
 * surface the host drew: which slots bound the fill contract, which are gated, which resolve to a
 * single command, and which no supplied mod reaches.
 */
export interface CommandSurface {
	slots: string[];
	constrained: string[];
	gated: string[];
	singular: string[];
	unreachable: string[];
}

/**
 * Declared-intent coverage: the fraction of bindings, hooks and slots carrying an explicit
 * `execution`. A capacity measure like the rest of the headline — a host that has told mod
 * authors and integrators where its slow parts are exposes more usable surface than one that
 * has not. A host with no intent-bearing surface at all does not carry the signal, rather than
 * scoring zero or one on an empty denominator.
 */
export interface IntentSurface {
	score: number;
	declared: string[];
	undeclared: string[];
	byDuration: Record<Duration, number>;
}

export interface ScoreResult {
	/**
	 * The mean of every applicable signal, as a percentage. Four of the five capacity surfaces
	 * are yes/no and only ever rise; declared-intent coverage is a fraction, so a host that
	 * adds surface without declaring intent on it can move the headline down. That is the
	 * signal doing its job, and `diffScores` reports it as a coverage change rather than as
	 * lost capacity.
	 */
	headline: number;
	integrity: IntegrityResult;
	capacity: CapacityMetric;
	slots: UtilizationMetric;
	capabilities: UtilizationMetric;
	formats: FormatSurface;
	commands: CommandSurface;
	intent: IntentSurface;
	/**
	 * Every signal folded into the headline, by name. The headline is the mean of these. A
	 * signal absent from the map was not applicable to this host, which is what lets
	 * `diffScores` compare two results that were scored by different versions of the tool.
	 */
	signals: Record<string, number>;
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
	"Measures moddability capacity — how much of xript's extension surface the host exposes (bindings to call, slots to fill, events to observe, libraries to import, a capability model to gate them), against a ceiling of exposing all of it. It does not prove the surface is well-designed: a high score with a poorly drawn host/mod boundary is possible. Integrity violations are bugs. The slot and capability figures are informational mod-coverage of the host's own non-reserved surface, not part of the headline — exposing a slot no supplied mod fills is moddability, not waste. Declared fragment formats are reported alongside but are not part of the headline: a format refines the slot surface rather than adding one, since it only means anything through a slot whose 'accepts' names it. Command slots are reported alongside for the same reason: a command slot is a slot, already counted, so it refines the slot surface rather than adding a sixth one. Declared execution intent IS part of the headline: it is the one signal that is a fraction rather than a yes/no, measuring how much of the host's binding, hook, and slot surface tells an integrator what a call costs and where it may run. A host with no such surface does not carry the signal at all rather than scoring zero on it.";

const CAPACITY_SURFACES = ["bindings", "slots", "capabilities", "events", "libraries"] as const;

export const DECLARED_INTENT_SIGNAL = "declared-intent";

interface HostManifest {
	slots?: Array<{
		id?: string;
		accepts?: string[];
		capability?: string;
		reserved?: boolean;
		multiple?: boolean;
		payload?: object;
	}>;
	capabilities?: Record<string, unknown>;
	bindings?: Record<string, unknown>;
	events?: unknown[];
	formats?: Record<string, { nodes?: Record<string, unknown>; vocabularies?: string[] }>;
	vocabularies?: Record<string, { nodes?: Record<string, unknown> }>;
}

interface ModManifest {
	name?: string;
	capabilities?: string[];
	fragments?: Array<{ slot?: string }>;
	fills?: Record<string, unknown>;
	contributions?: { slots?: Record<string, unknown> };
}

/** The mean of a signal set, and zero for an empty one. */
function composite(signals: Record<string, number>): number {
	const values = Object.values(signals);
	if (values.length === 0) return 0;
	return values.reduce((sum, value) => sum + value, 0) / values.length;
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

/**
 * Counts the node surface a host actually exposes. A node is counted once per
 * (vocabulary, node name) pair reachable from at least one accepted format, so a
 * vocabulary shared by three formats counts once rather than three times — reuse must not
 * inflate the figure. A declared vocabulary no reachable format brings into scope counts
 * zero and is reported separately, the same way an unreachable format already is.
 */
function formatSurface(host: HostManifest): FormatSurface {
	const formats = host.formats ?? {};
	const vocabularies = host.vocabularies ?? {};
	const declared = Object.keys(formats);
	const declaredVocabularies = Object.keys(vocabularies);

	const accepted = new Set<string>();
	for (const slot of host.slots ?? []) {
		for (const format of slot.accepts ?? []) accepted.add(format);
	}

	const reachable = declared.filter((id) => accepted.has(id));
	const countedNodes = new Set<string>();
	const reachableVocabularies = new Set<string>();

	for (const formatId of reachable) {
		const format = formats[formatId];
		for (const nodeName of Object.keys(format?.nodes ?? {})) {
			countedNodes.add(`${formatId}#inline::${nodeName}`);
		}
		for (const ref of format?.vocabularies ?? []) {
			if (!Object.prototype.hasOwnProperty.call(vocabularies, ref)) continue;
			reachableVocabularies.add(ref);
			for (const nodeName of Object.keys(vocabularies[ref]?.nodes ?? {})) {
				countedNodes.add(`${ref}::${nodeName}`);
			}
		}
	}

	return {
		declared,
		nodes: countedNodes.size,
		reachable,
		unreachable: declared.filter((id) => !accepted.has(id)),
		vocabularies: declaredVocabularies.filter((id) => reachableVocabularies.has(id)),
		vocabulariesUnreachable: declaredVocabularies.filter((id) => !reachableVocabularies.has(id)),
	};
}

function commandSurface(host: HostManifest, filled: Set<string>): CommandSurface {
	const commandSlots = (host.slots ?? []).filter((slot) => isCommandSlot(slot) && slot.id);
	return {
		slots: commandSlots.map((slot) => slot.id as string),
		constrained: commandSlots.filter((slot) => slot.payload && typeof slot.payload === "object").map((slot) => slot.id as string),
		gated: commandSlots.filter((slot) => Boolean(slot.capability)).map((slot) => slot.id as string),
		singular: commandSlots.filter((slot) => slot.multiple !== true).map((slot) => slot.id as string),
		unreachable: commandSlots
			.filter((slot) => slot.reserved === true || !filled.has(slot.id as string))
			.map((slot) => slot.id as string),
	};
}

/**
 * Coverage of declared execution intent across the host's bindings, hooks and slots. Mod
 * exports are deliberately not counted: this measures what the HOST told integrators, and a
 * host does not author the mods.
 */
function intentSurface(host: unknown): IntentSurface {
	const surfaces = executionSurfaces(host).filter((surface) => surface.kind !== "export");
	const declared = surfaces.filter((surface) => surface.declared).map((surface) => surface.path);
	const undeclared = surfaces.filter((surface) => !surface.declared).map((surface) => surface.path);
	const byDuration: Record<Duration, number> = { instant: 0, brief: 0, long: 0, unbounded: 0 };
	for (const surface of surfaces) byDuration[surface.resolved.duration]++;
	return {
		score: surfaces.length ? declared.length / surfaces.length : 0,
		declared,
		undeclared,
		byDuration,
	};
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

	const declaredCaps = capabilityNames(hostManifest);
	for (const slot of hostManifest.slots ?? []) {
		const gate = slot.capability;
		if (gate && !declaredCaps.some((scope) => satisfies(scope, gate))) {
			violations.push(`slot "${slot.id ?? "?"}" references undeclared capability "${gate}"`);
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
	const intent = intentSurface(host);

	const signals: Record<string, number> = {};
	for (const surface of CAPACITY_SURFACES) signals[surface] = surfaceExposed(hostManifest, surface) ? 1 : 0;
	if (intent.declared.length + intent.undeclared.length > 0) {
		signals[DECLARED_INTENT_SIGNAL] = intent.score;
	}
	const headline = Math.round(100 * composite(signals));

	const inheritedSlots = new Set(options.inheritedSlots ?? []);
	const inheritedCaps = new Set(options.inheritedCapabilities ?? []);
	const reservedSlots = reservedSlotIds(hostManifest);
	const reservedCaps = reservedCapabilityNames(hostManifest);

	const ownSlots = slotIds(hostManifest).filter((id) => !inheritedSlots.has(id) && !reservedSlots.has(id));
	const usedSlots = modSlotReferences(modManifests);
	const usedSlotIds = ownSlots.filter((id) => usedSlots.has(id));
	const slotMetric: UtilizationMetric = {
		score: ownSlots.length ? usedSlotIds.length / ownSlots.length : 1,
		total: ownSlots.length,
		used: usedSlotIds,
		unused: ownSlots.filter((id) => !usedSlots.has(id)),
	};

	const ownCaps = capabilityNames(hostManifest).filter((name) => !inheritedCaps.has(name) && !reservedCaps.has(name));
	const referencedCaps = [...new Set([...modCapabilityRequests(modManifests), ...gateCapabilities(host)])];
	const usedCapNames = ownCaps.filter((name) => referencedCaps.some((ref) => satisfies(name, ref)));
	const usedCapSet = new Set(usedCapNames);
	const capabilityMetric: UtilizationMetric = {
		score: ownCaps.length ? usedCapNames.length / ownCaps.length : 1,
		total: ownCaps.length,
		used: usedCapNames,
		unused: ownCaps.filter((name) => !usedCapSet.has(name)),
	};

	const result: ScoreResult = {
		headline,
		integrity,
		capacity,
		slots: slotMetric,
		capabilities: capabilityMetric,
		formats: formatSurface(hostManifest),
		commands: commandSurface(hostManifest, usedSlots),
		intent,
		signals,
		disclaimer: DISCLAIMER,
	};
	if (options.min !== undefined) {
		result.gate = { min: options.min, passed: integrity.passed && headline >= options.min };
	}
	return result;
}

export interface MetricDiff {
	baseline: number;
	current: number;
	delta: number;
	/**
	 * How many entries each side's fraction was over, where the surface has a countable size.
	 * An empty surface scores 1 vacuously, so without these a slot deleted between baseline and
	 * current renders as coverage going 0% → 100% — a regression that reads as an improvement.
	 * Absent on the capacity diff, which is not a fraction over a set.
	 */
	baselineTotal?: number;
	currentTotal?: number;
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
	/**
	 * Command-slot movement, reported alongside the headline rather than folded into it. A gained
	 * command slot is new extension surface the slot metric already counts; the interesting deltas
	 * are a slot that stopped being gated or lost its `multiple`, which weaken a surface without
	 * moving the score.
	 */
	commands: { gained: string[]; lost: string[]; ungated: string[]; narrowed: string[] };
	/**
	 * Signal-set movement, reported separately from the headline. Adding a signal to `score`
	 * changes every existing host's composite, so a diff against a baseline scored before the
	 * signal existed would read as a regression for every host on upgrade. The headline above is
	 * therefore computed on the INTERSECTION of the two signal sets; a signal only one side
	 * carries is reported here and scored, but never gated on. A host that wants a new signal in
	 * its gate regenerates its baseline.
	 */
	signals: {
		shared: string[];
		baselineOnly: string[];
		currentOnly: string[];
		/** The score each not-shared signal earned on the side that carries it. */
		unshared: Record<string, number>;
		note?: string;
	};
	gate?: { minDelta: number; passed: boolean };
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

function metricDiff(baseline: UtilizationMetric, current: UtilizationMetric): MetricDiff {
	return {
		baseline: round3(baseline.score),
		current: round3(current.score),
		delta: round3(current.score - baseline.score),
		baselineTotal: baseline.total,
		currentTotal: current.total,
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

const EMPTY_COMMAND_SURFACE: CommandSurface = { slots: [], constrained: [], gated: [], singular: [], unreachable: [] };

function commandDiff(
	baseline: CommandSurface | undefined,
	current: CommandSurface | undefined,
): { gained: string[]; lost: string[]; ungated: string[]; narrowed: string[] } {
	const before = baseline ?? EMPTY_COMMAND_SURFACE;
	const after = current ?? EMPTY_COMMAND_SURFACE;
	const beforeGated = new Set(before.gated);
	const beforeSingular = new Set(before.singular);
	return {
		gained: after.slots.filter((id) => !before.slots.includes(id)),
		lost: before.slots.filter((id) => !after.slots.includes(id)),
		ungated: after.slots.filter((id) => beforeGated.has(id) && !after.gated.includes(id)),
		narrowed: after.singular.filter((id) => before.slots.includes(id) && !beforeSingular.has(id)),
	};
}

/**
 * The signal set a result carries. A result produced before signals were reported at all is
 * reconstructed from its capacity surfaces, which is exactly the set it was scored on.
 */
function signalsOf(result: ScoreResult): Record<string, number> {
	if (result.signals && Object.keys(result.signals).length > 0) return result.signals;
	const reconstructed: Record<string, number> = {};
	for (const surface of CAPACITY_SURFACES) {
		reconstructed[surface] = result.capacity.exposed.includes(surface) ? 1 : 0;
	}
	return reconstructed;
}

export function diffScores(baseline: ScoreResult, current: ScoreResult, options: { minDelta?: number } = {}): ScoreDiff {
	const baselineViolations = new Set(baseline.integrity.violations);
	const currentViolations = new Set(current.integrity.violations);
	const introduced = current.integrity.violations.filter((v) => !baselineViolations.has(v));
	const fixed = baseline.integrity.violations.filter((v) => !currentViolations.has(v));

	const baselineSignals = signalsOf(baseline);
	const currentSignals = signalsOf(current);
	const shared = Object.keys(currentSignals).filter((name) => name in baselineSignals);
	const baselineOnly = Object.keys(baselineSignals).filter((name) => !(name in currentSignals));
	const currentOnly = Object.keys(currentSignals).filter((name) => !(name in baselineSignals));

	const pick = (signals: Record<string, number>): Record<string, number> =>
		Object.fromEntries(shared.map((name) => [name, signals[name]]));
	const baselineHeadline = Math.round(100 * composite(pick(baselineSignals)));
	const currentHeadline = Math.round(100 * composite(pick(currentSignals)));
	const headlineDelta = currentHeadline - baselineHeadline;

	const unshared: Record<string, number> = {};
	for (const name of baselineOnly) unshared[name] = round3(baselineSignals[name]);
	for (const name of currentOnly) unshared[name] = round3(currentSignals[name]);

	const noteParts: string[] = [];
	for (const name of currentOnly) noteParts.push(`baseline lacks signal '${name}'`);
	for (const name of baselineOnly) noteParts.push(`current no longer carries signal '${name}'`);
	const note =
		noteParts.length > 0
			? `${noteParts.join("; ")}; composite compared on ${shared.length} shared signal${shared.length === 1 ? "" : "s"}${currentOnly.map((name) => `; new signal scores ${round3(currentSignals[name])}`).join("")}`
			: undefined;

	const direction = introduced.length > 0 || headlineDelta < 0 ? "regressed" : headlineDelta > 0 ? "improved" : "unchanged";

	const diff: ScoreDiff = {
		direction,
		headline: { baseline: baselineHeadline, current: currentHeadline, delta: headlineDelta },
		capacity: capacityDiff(baseline.capacity, current.capacity),
		slots: metricDiff(baseline.slots, current.slots),
		capabilities: metricDiff(baseline.capabilities, current.capabilities),
		integrity: { baselineViolations: baseline.integrity.violations.length, currentViolations: current.integrity.violations.length, introduced, fixed },
		commands: commandDiff(baseline.commands, current.commands),
		signals: { shared, baselineOnly, currentOnly, unshared, ...(note ? { note } : {}) },
	};
	if (options.minDelta !== undefined) {
		diff.gate = { minDelta: options.minDelta, passed: introduced.length === 0 && headlineDelta >= options.minDelta };
	}
	return diff;
}
