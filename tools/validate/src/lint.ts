export type Severity = "error" | "warn" | "info";

/**
 * The identifier namespace xript reserves for the types and globals `typegen` emits — the
 * `Xript`-cased type helpers (`XriptSlots`, `XriptEventId`, `XriptCapability`, …) and the
 * `xript`-cased globals (the `xript` sandbox object, the `xriptExecution` routing tables). A host
 * type or binding whose name falls in this namespace collides with generated output in the emitted
 * `.d.ts` — a duplicate-identifier error the adopter meets at compile time, three steps from the
 * manifest. Reserving the prefix rather than a fixed list of names keeps every future generated
 * identifier collision-safe without extending a list or writing a migration.
 */
export const RESERVED_IDENTIFIER_PREFIX = "Xript";

/** True when a host-declared type or binding name falls in the reserved xript identifier namespace. */
export function isReservedIdentifier(name: string): boolean {
	return /^xript/i.test(name);
}

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

/**
 * A host's `capabilities` is a record of declarations; a *mod's* is an array of requested
 * names. Iterating the array as a record names each capability by its index, which is how
 * a mod manifest linted by mistake produced findings about a capability called "0".
 */
function capabilityDeclarations(manifest: { capabilities?: unknown }): Record<string, unknown> {
	const declared = manifest.capabilities;
	if (typeof declared !== "object" || declared === null || Array.isArray(declared)) return {};
	return declared as Record<string, unknown>;
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
	/**
	 * Fragment-format ids the host inherited from an `extends` base rather than declaring
	 * locally. An inherited format no local slot happens to accept is not a defect, so the
	 * dead-format check stays silent on these. Default (omitted) treats every format as local.
	 */
	inheritedFormats?: string[];
	/**
	 * Vocabulary ids the host inherited from an `extends` base rather than declaring locally.
	 * An inherited vocabulary no local format brings into scope is not a defect, so the
	 * dead-vocabulary check stays silent on these. Default (omitted) treats every vocabulary
	 * as local.
	 */
	inheritedVocabularies?: string[];
	/**
	 * Fragment sources keyed by a fill's `source` value, for fills that name a file. Without
	 * them the expression analyzer reads inline fills only — it reports what it can read
	 * rather than guessing at markup it has not seen.
	 */
	fragmentSources?: Record<string, string>;
	/** Resolved binding value types per fill id. Absent types disable the type-aware checks. */
	bindingTypes?: Record<string, Record<string, ExpressionType>>;
}

const schemeErrorCodes: ReadonlySet<string> = new Set(["prohibited-scheme", "invalid-schemes"]);

import { analyzeExpressions, type ExpressionType } from "./expressions.js";
import { fragmentFillFindings } from "./fills.js";
import { gateCapabilities } from "./manifest-util.js";
import {
	compareDuration,
	executionSurfaces,
	resolveExecutionIntent,
	widenExecutionIntent,
} from "./execution.js";
import { satisfies } from "./capabilities.js";
import { nonCanonicalSpellings, parseTypeRef, resolveTypeWords, returnTypeRef, typeRefNames, typeRefToTypeScript, type TypeNode } from "./type-ref.js";
import {
	commandDefects,
	commandFillViews,
	declaredExportNames,
	exportCapability,
	isCommandSlot,
} from "./commands.js";
import {
	FormatProfileError,
	RESERVED_FORMAT_IDS,
	STRIPPED_ELEMENTS,
	resolveFormatProfile,
	speaksHtml,
	type PropDefinition,
	type NodeDefinition,
} from "@xriptjs/sanitize";

interface HostSlot {
	id?: string;
	accepts?: string[];
	capability?: string;
	description?: string;
	reserved?: boolean;
	multiple?: boolean;
}

interface HostFormat {
	description?: string;
	syntax?: string;
	vocabularies?: string[];
	schemes?: string[];
	nodes?: Record<string, NodeDefinition>;
}

interface HostVocabulary {
	description?: string;
	nodes?: Record<string, NodeDefinition>;
}

interface HostManifest {
	slots?: HostSlot[];
	capabilities?: Record<string, { description?: string } | unknown>;
	libraries?: Record<string, { capability?: string; description?: string }>;
	formats?: Record<string, HostFormat>;
	vocabularies?: Record<string, HostVocabulary>;
	events?: Array<{ id?: string; capability?: string }>;
	types?: Record<string, unknown>;
}

interface ModManifest {
	name?: string;
	capabilities?: string[];
	fragments?: Array<{ slot?: string }>;
	fills?: Record<string, unknown>;
	contributions?: { slots?: Record<string, unknown> };
	entry?: unknown;
}

/**
 * The scope half of a capability reference, with any `read:`/`write:` prefix removed.
 */
function scopeOf(ref: string): string {
	const i = ref.indexOf(":");
	return i < 0 ? ref : ref.slice(i + 1);
}

/**
 * The declared scope a reference sits strictly below, if any — i.e. the reference names a
 * descendant of something declared rather than a declared node itself.
 *
 * A host whose scope children are created at run time (one per configured root) declares
 * `instances` on the parent to say so. Absent that, a mod naming a node the host never
 * declared and never said would exist is guessing, and the grant will not be there.
 */
function strictAncestorOf(declared: Set<string>, ref: string): string | undefined {
	const scope = scopeOf(ref);
	let best: string | undefined;
	for (const candidate of declared) {
		if (scope === candidate) return undefined;
		if (!scope.startsWith(candidate + ".")) continue;
		if (best === undefined || candidate.length > best.length) best = candidate;
	}
	return best;
}

function declaredSatisfiesRef(declared: Set<string>, ref: string): boolean {
	for (const scope of declared) {
		if (satisfies(scope, ref)) return true;
	}
	return false;
}

interface TypeRefSite {
	ref: unknown;
	where: string;
}

interface ParamSite {
	param: Record<string, unknown>;
	where: string;
}

/**
 * Every `typeRef` the host manifest declares, with where it was declared. Covers binding params
 * and returns (through nested namespaces), hook params, event payloads, and the fields of a
 * declared type, since a type may reference another.
 */
function typeRefSites(manifest: HostManifest): { refs: TypeRefSite[]; params: ParamSite[] } {
	const refs: TypeRefSite[] = [];
	const params: ParamSite[] = [];
	const add = (ref: unknown, where: string): void => {
		if (ref !== undefined) refs.push({ ref, where });
	};
	const addParams = (list: unknown, owner: string): void => {
		if (!Array.isArray(list)) return;
		for (const param of list) {
			if (typeof param !== "object" || param === null) continue;
			const p = param as Record<string, unknown>;
			const where = `${owner} parameter "${typeof p.name === "string" ? p.name : "?"}"`;
			add(p.type, where);
			params.push({ param: p, where });
		}
	};

	const walk = (bindings: unknown, prefix: string): void => {
		if (typeof bindings !== "object" || bindings === null) return;
		for (const [name, def] of Object.entries(bindings as Record<string, unknown>)) {
			if (typeof def !== "object" || def === null) continue;
			const qualified = prefix ? `${prefix}.${name}` : name;
			const d = def as { members?: unknown; params?: unknown[]; returns?: unknown };
			if (d.members !== undefined) {
				walk(d.members, qualified);
				continue;
			}
			addParams(d.params, `binding "${qualified}"`);
			add(returnTypeRef(d.returns), `binding "${qualified}" return`);
		}
	};
	walk((manifest as { bindings?: unknown }).bindings, "");

	const hooks = (manifest as { hooks?: Record<string, { params?: unknown[] }> }).hooks ?? {};
	for (const [hookName, def] of Object.entries(hooks)) addParams(def?.params, `hook "${hookName}"`);

	for (const event of (manifest as { events?: Array<{ id?: string; payload?: unknown }> }).events ?? []) {
		add(event?.payload, `event "${event?.id ?? "?"}" payload`);
	}

	const types = (manifest as { types?: Record<string, { fields?: Record<string, { type?: unknown }> }> }).types ?? {};
	for (const [typeName, def] of Object.entries(types)) {
		for (const [fieldName, field] of Object.entries(def?.fields ?? {})) {
			add(field?.type, `type "${typeName}" field "${fieldName}"`);
		}
	}

	return { refs, params };
}

/** Every custom type name the host manifest references, with where it was referenced from. */
function typeReferences(manifest: HostManifest): Array<{ name: string; ref: string; where: string }> {
	const found: Array<{ name: string; ref: string; where: string }> = [];
	for (const { ref, where } of typeRefSites(manifest).refs) {
		const printed = typeof ref === "string" ? ref : JSON.stringify(ref);
		for (const name of typeRefNames(ref)) found.push({ name, ref: printed, where });
	}
	return found;
}

/**
 * Accepted-but-loose spellings: type words (`int`, `bool`, `array`, ...), the `T?` suffix, and
 * the `optional` alias on a parameter. Every one parses and generates; these findings point at
 * the one spelling the tools document, so manifests across a project read alike.
 */
function spellingFindings(manifest: HostManifest): Finding[] {
	const findings: Finding[] = [];
	const { refs, params } = typeRefSites(manifest);
	for (const { ref, where } of refs) {
		const seen = new Set<string>();
		for (const spelling of nonCanonicalSpellings(ref)) {
			if (seen.has(spelling.word)) continue;
			seen.add(spelling.word);
			const rendered = typeRefToTypeScript(ref);
			findings.push({
				severity: "info",
				code: spelling.loose ? "loose-type-word" : "noncanonical-type-spelling",
				message: spelling.loose
					? `${where} uses the type word "${spelling.word}", which generates as \`${rendered}\` and leaves its shape unstated`
					: `${where} spells a type as "${spelling.word}"; it generates as \`${rendered}\``,
				suggestion: spelling.loose
					? `Name the shape precisely with ${spelling.canonical}, so generated types and docs carry it.`
					: `Write \`${spelling.canonical}\`, the canonical spelling.`,
			});
		}
	}
	for (const { param, where } of params) {
		if (param.optional === undefined) continue;
		findings.push({
			severity: "info",
			code: "param-optional-alias",
			message: `${where} uses \`optional\`, an accepted alias of \`required\``,
			suggestion: `Write \`"required": ${param.optional === true ? "false" : "true"}\` instead, the canonical spelling.`,
		});
	}
	return findings;
}

function containsFunctionType(ref: unknown): boolean {
	if (ref === undefined) return false;
	const walk = (node: TypeNode): boolean => {
		switch (node.kind) {
			case "function":
			case "signature":
				return true;
			case "array":
				return walk(node.element);
			case "map":
				return walk(node.value);
			case "optional":
				return walk(node.inner);
			case "union":
				return node.members.some(walk);
			default:
				return false;
		}
	};
	return walk(resolveTypeWords(parseTypeRef(ref)));
}

/** Where the host manifest declares a function type somewhere no callback can reach. */
function functionTypesOutsideParams(manifest: HostManifest): string[] {
	const found: string[] = [];
	const walk = (bindings: unknown, prefix: string): void => {
		if (typeof bindings !== "object" || bindings === null) return;
		for (const [name, def] of Object.entries(bindings as Record<string, unknown>)) {
			if (typeof def !== "object" || def === null) continue;
			const qualified = prefix ? `${prefix}.${name}` : name;
			const d = def as { members?: unknown; returns?: unknown };
			if (d.members !== undefined) {
				walk(d.members, qualified);
				continue;
			}
			if (containsFunctionType(returnTypeRef(d.returns))) found.push(`binding "${qualified}" return`);
		}
	};
	walk((manifest as { bindings?: unknown }).bindings, "");

	const hooks = (manifest as { hooks?: Record<string, { params?: unknown[] }> }).hooks ?? {};
	for (const [hookName, def] of Object.entries(hooks)) {
		for (const param of def?.params ?? []) {
			const p = param as { name?: string; type?: unknown };
			if (containsFunctionType(p?.type)) found.push(`hook "${hookName}" parameter "${p?.name ?? "?"}"`);
		}
	}

	for (const event of (manifest as { events?: Array<{ id?: string; payload?: unknown }> }).events ?? []) {
		if (containsFunctionType(event?.payload)) found.push(`event "${event?.id ?? "?"}" payload`);
	}
	return found;
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
	const inheritedFormats = new Set(options.inheritedFormats ?? []);
	const inheritedVocabularies = new Set(options.inheritedVocabularies ?? []);

	const slots = hostManifest.slots ?? [];
	const declaredSlotIds = new Set(slots.map((slot) => slot.id).filter((id): id is string => Boolean(id)));
	const declaredCapabilities = new Set(Object.keys(capabilityDeclarations(hostManifest)));

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
				continue;
			}
			const parent = strictAncestorOf(declaredCapabilities, cap);
			if (parent !== undefined && capabilityDeclarations(hostManifest)[parent] !== undefined) {
				const declaration = capabilityDeclarations(hostManifest)[parent] as { instances?: unknown };
				if (declaration?.instances === undefined) {
					findings.push({
						severity: "warn",
						code: "dynamic-scope-undeclared",
						message: `${label} requests capability "${cap}", a scope below "${parent}" that the host never declares and never says is created at run time`,
						suggestion: `If children of "${parent}" are instantiated by the host (one per configured root, account, or project), declare \`instances\` on it to say so. Otherwise declare "${scopeOf(cap)}" itself, or correct the reference — a grant for a scope the host does not model will not be issued.`,
					});
				}
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

	// Bindings, hooks and events carry a `capability` too. Only slots, libraries and mod
	// requests were checked, so a host could gate a binding on a scope it never declared:
	// `xript scan` reported the gap, and `validate` and `lint` both passed it clean. A gate on
	// an undeclared scope is undiscoverable — it appears in no generated doc, and a mod that
	// asks for it is told the host does not declare it.
	for (const surface of executionSurfaces(hostManifest)) {
		if (surface.kind !== "binding" && surface.kind !== "hook") continue;
		if (!surface.capability || declaredSatisfiesRef(declaredCapabilities, surface.capability)) continue;
		findings.push({
			severity: "error",
			code: "undeclared-capability",
			message: `${surface.kind} "${surface.name}" gates on capability "${surface.capability}" which the host does not declare`,
			suggestion: `Declare capability "${scopeOf(surface.capability)}" in the host manifest, or change the gate.`,
		});
	}

	for (const event of hostManifest.events ?? []) {
		if (!event?.capability || declaredSatisfiesRef(declaredCapabilities, event.capability)) continue;
		findings.push({
			severity: "error",
			code: "undeclared-capability",
			message: `event "${event.id ?? "?"}" gates subscription on capability "${event.capability}" which the host does not declare`,
			suggestion: `Declare capability "${scopeOf(event.capability)}" in the host manifest, or change the gate.`,
		});
	}

	// A type reference to a name nobody declared passes the schema (a `typeRef` string is just a
	// string) and then emits a `.d.ts` that does not compile — `Cannot find name 'NoSuchType'`.
	// Same shape as an undeclared capability gate: a reference to something absent, sailing
	// through validation and breaking downstream.
	const declaredTypes = new Set(Object.keys((hostManifest.types ?? {}) as Record<string, unknown>));
	for (const { name, ref, where } of typeReferences(hostManifest)) {
		if (declaredTypes.has(name)) continue;
		findings.push({
			severity: "error",
			code: "undeclared-type",
			message: `${where} references type "${name}", which the manifest does not declare`,
			suggestion: `Declare "${name}" under \`types\`, or use a primitive (\`string\`, \`number\`, \`boolean\`, \`void\`, \`null\`, \`undefined\`, \`any\`, \`unknown\`), an array shorthand (\`${name}[]\`), or a \`{ "union": [...] }\`. \`typegen\` emits this reference verbatim, so an undeclared name becomes a declaration file that will not compile.${ref === name ? "" : ` (from \`${ref}\`)`}`,
		});
	}

	// A script function crosses the boundary only as an argument to a binding call, where it
	// arrives as a call-scoped callback. Anywhere else (a binding's return value, a hook's
	// arguments, an event payload) it is marshalled as data and arrives as nothing, so a
	// declaration promising one there promises something no runtime delivers.
	for (const where of functionTypesOutsideParams(hostManifest)) {
		findings.push({
			severity: "warn",
			code: "callback-does-not-cross",
			message: `${where} declares a function, but only a function passed into a binding call crosses the sandbox boundary`,
			suggestion: "A function in a return value, hook argument, or event payload arrives as nothing. Pass data there instead, or take the callback as a binding parameter.",
		});
	}

	// typegen emits its own types and globals under the `xript`/`Xript` prefix (`XriptSlots`,
	// `XriptEventId`, `XriptCapability`, the `xript` sandbox global, the execution tables). A host
	// type or binding sharing that prefix collides with generated output in the emitted `.d.ts` —
	// the same shape as an undeclared type: a name that passes the schema and then breaks the
	// declaration file. Reserving the prefix keeps every current and future generated name safe.
	const hostBindingNames = Object.keys(
		((hostManifest as { bindings?: Record<string, unknown> }).bindings ?? {}) as Record<string, unknown>,
	);
	for (const [kind, names] of [
		["type", [...declaredTypes]],
		["binding", hostBindingNames],
	] as const) {
		for (const name of names) {
			if (!isReservedIdentifier(name)) continue;
			findings.push({
				severity: "error",
				code: "reserved-identifier",
				message: `${kind} "${name}" falls in the reserved \`${RESERVED_IDENTIFIER_PREFIX}\` identifier namespace, which xript uses for the types and globals \`typegen\` emits`,
				suggestion: `Rename it so it does not start with \`xript\` (any case). The namespace is reserved so generated identifiers like \`XriptSlots\` and the \`xript\` sandbox global never collide with a host's own declarations in the emitted \`.d.ts\`.`,
			});
		}
	}

	// A record type "Foo" makes typegen emit a `FooAccessor` interface of typed get/set accessors
	// alongside it. A host that also declares a type literally named "FooAccessor" gets two
	// `interface FooAccessor` in the emitted `.d.ts`. Unlike the reserved prefix this is the host's
	// own two names colliding, not a framework imposition, so it is surfaced rather than forbidden
	// by reserving an `Accessor` suffix a host might legitimately want.
	for (const [name, def] of Object.entries((hostManifest.types ?? {}) as Record<string, { fields?: Record<string, unknown> }>)) {
		const hasFields = def && typeof def === "object" && def.fields && Object.keys(def.fields).length > 0;
		if (!hasFields || !declaredTypes.has(`${name}Accessor`)) continue;
		findings.push({
			severity: "error",
			code: "generated-accessor-collision",
			message: `type "${name}Accessor" collides with the accessor interface \`typegen\` generates for record type "${name}"`,
			suggestion: `Rename one of them. A record type "${name}" emits an \`interface ${name}Accessor\` of typed get/set accessors, so a second type named "${name}Accessor" produces a duplicate identifier in the generated \`.d.ts\`.`,
		});
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
	for (const [name, def] of Object.entries(capabilityDeclarations(hostManifest))) {
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
			if (isCommandSlot(slot)) continue;
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
	for (const [name, def] of Object.entries(capabilityDeclarations(hostManifest))) {
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

	for (const finding of spellingFindings(hostManifest)) findings.push(finding);

	for (const finding of commandFindings(hostManifest, modManifests)) findings.push(finding);

	for (const finding of formatFindings(hostManifest, inheritedFormats, inheritedVocabularies)) {
		findings.push(finding);
	}

	for (const finding of escalationFindings(declaredCapabilities)) findings.push(finding);

	for (const finding of fragmentFillFindings(mods, options.fragmentSources)) findings.push(finding);

	for (const finding of executionFindings(host, mods)) findings.push(finding);

	for (const finding of analyzeExpressions(mods, {
		fragmentSources: options.fragmentSources,
		bindingTypes: options.bindingTypes,
		formats: hostManifest.formats ?? null,
		vocabularies: hostManifest.vocabularies ?? null,
	})) {
		findings.push(finding);
	}

	const counts: LintCounts = { error: 0, warn: 0, info: 0 };
	for (const finding of findings) counts[finding.severity]++;

	return { findings, counts };
}

/**
 * Audits the host's command slots and the command fills aimed at them. Fill-shape defects are
 * errors, because they are the errors a runtime raises at load. The slot-level findings are the
 * two shapes a host usually gets wrong on its first command slot: forgetting `multiple` (which
 * yields a one-item palette) and leaving the contribution surface ungated. The informational
 * findings describe a command surface that is legal but tells tooling less than it could.
 */
function commandFindings(host: HostManifest, mods: ModManifest[]): Finding[] {
	const findings: Finding[] = [];
	const commandSlots = (host.slots ?? []).filter((slot) => isCommandSlot(slot) && slot.id);
	if (commandSlots.length === 0) return findings;

	for (const slot of commandSlots) {
		const id = slot.id as string;
		if (slot.multiple !== true) {
			findings.push({
				severity: "warn",
				code: "command-slot-singular",
				message: `command slot "${id}" is not \`"multiple": true\` — it resolves to exactly one command across all mods`,
				suggestion: `Set \`"multiple": true\` if the slot is a palette or menu that should list every contributed command. Cardinality means the same thing here as for every other slot kind.`,
			});
		}
		if (!slot.capability) {
			findings.push({
				severity: "warn",
				code: "command-slot-ungated",
				message: `command slot "${id}" declares no capability — any mod may contribute an invocable action to it`,
				suggestion: `Gate the slot with a capability. Contributing a command is a privilege; leaving it open is legal but usually an oversight.`,
			});
		}
	}

	for (const mod of mods) {
		const label = mod.name ? `mod "${mod.name}"` : "a mod";
		const exportNames = declaredExportNames(mod);
		for (const slot of commandSlots) {
			const slotId = slot.id as string;
			const fillValue = mod.fills?.[slotId];
			if (fillValue === undefined) continue;

			for (const defect of commandDefects(fillValue, slotId, exportNames)) {
				findings.push({
					severity: "error",
					code: defect.code,
					message: `${label} fills command slot "${slotId}": ${defect.message}`,
					suggestion: defect.suggestion,
				});
			}

			const views = commandFillViews(fillValue);
			for (const view of views) {
				if (view.hasInput || Object.keys(view.args).length === 0) continue;
				findings.push({
					severity: "info",
					code: "command-opaque-args",
					message: `${label} binds arguments to command "${view.id}" but declares no \`input\` — the bound keys are undiscoverable to tooling`,
					suggestion: `Declare an \`input\` schema describing the effective argument object so typegen and docgen can describe the command.`,
				});
			}

			if (slot.capability && exportNames && views.length > 0) {
				const differentiated = views.some((view) => exportCapability(mod, view.handler) !== undefined);
				if (!differentiated) {
					findings.push({
						severity: "info",
						code: "command-uniform-authority",
						message: `${label} contributes ${views.length} command${views.length === 1 ? "" : "s"} to gated slot "${slotId}", none of whose handlers declare an export capability — every command in the slot carries identical authority`,
						suggestion: `That may be intended. To differentiate, declare \`capability\` on the export a command names (entry.exports[handler].capability), re-rooted under a separate top-level scope if it confers more than the slot's gate.`,
					});
				}
			}
		}
	}

	for (const slot of commandSlots) {
		const slotId = slot.id as string;
		const owners = new Map<string, string[]>();
		for (const mod of mods) {
			const fillValue = mod.fills?.[slotId];
			if (fillValue === undefined) continue;
			for (const view of commandFillViews(fillValue)) {
				const list = owners.get(view.id) ?? [];
				list.push(mod.name ?? "?");
				owners.set(view.id, list);
			}
		}
		for (const [commandId, list] of owners) {
			if (list.length < 2) continue;
			findings.push({
				severity: "info",
				code: "command-id-collision",
				message: `command id "${commandId}" is declared in slot "${slotId}" by ${list.length} mods (${[...list].sort().join(", ")})`,
				suggestion: `Nothing is dropped or renamed — each resolves under its qualified id "\${mod}:${commandId}" and is marked as colliding. Decide a display policy, or ask the mods to pick distinct ids.`,
			});
		}
	}

	return findings;
}

/**
 * Audits declared execution intent — the `execution` blocks a host puts on its bindings, hooks
 * and slots, and a mod puts on its exports.
 *
 * There is deliberately NO reentrancy rule here. Under a pool a host binding is called from N
 * threads and must be reentrant, but that is a property of host code the linter never sees, and
 * a rule pretending otherwise would be worse than silence. The contract is documented instead.
 */
function executionFindings(host: unknown, mods: unknown[]): Finding[] {
	const findings: Finding[] = [];
	const surfaces = executionSurfaces(host);

	for (const surface of surfaces) {
		const { duration, affinity } = surface.resolved;
		const label = `${surface.kind} "${surface.name}"`;

		if (surface.kind === "binding" && surface.async === true && duration === "instant") {
			findings.push({
				severity: "info",
				code: "execution-async-instant",
				message: `${label} is \`async\` but declares \`duration: instant\` — a future that is always already settled`,
				suggestion: `Drop \`async\` if the value is settled by the time the call returns, or raise \`duration\` if the call actually costs something. \`async\` declares the shape of the value, \`execution.duration\` declares the cost.`,
			});
		}

		// Only a slot or a hook can carry `limits`, and only their fills are script the
		// runtime can actually interrupt. A binding is host code: the schema has no
		// `limits` on it, and a timeout would not reach inside it if it did.
		if (
			(duration === "long" || duration === "unbounded") &&
			surface.limits !== true &&
			(surface.kind === "slot" || surface.kind === "hook")
		) {
			findings.push({
				severity: "warn",
				code: "execution-long-no-limits",
				message: `${label} declares \`duration: ${duration}\` but overrides no \`limits\` — its fills inherit an ambient budget tuned for something briefer`,
				suggestion: `Add a \`limits\` override admitting the cost this surface claims.`,
			});
		}

		if ((duration === "long" || duration === "unbounded") && surface.kind === "binding") {
			findings.push({
				severity: "warn",
				code: "execution-long-binding-blocks",
				message: `binding "${surface.name}" declares \`duration: ${duration}\` — it blocks the calling script's budget for as long as it runs, and no xript timeout can interrupt it`,
				suggestion: `A budget bounds script execution only: once control is inside host code, nothing on this side can stop it. Route the call instead — give it its own runtime, or hand the script a handle it polls — rather than reaching for \`limits\`, which a binding cannot declare.`,
			});
		}

		if (surface.kind === "hook" && duration === "unbounded") {
			findings.push({
				severity: "warn",
				code: "execution-unbounded-in-hook",
				message: `hook "${surface.name}" resolves to \`duration: unbounded\` — hook fan-out is on the firing path and a host usually cannot defer it`,
				suggestion: `Move the unbounded work behind a binding the handler calls, or lower the hook's declared duration to what firing it actually costs.`,
			});
		}

		if (surface.kind === "binding" && affinity === "pinned" && !surface.capability && !surface.hasParams) {
			findings.push({
				severity: "info",
				code: "execution-pinned-stateless",
				message: `binding "${surface.name}" declares \`affinity: pinned\` but gates on no capability and takes no parameters — it looks stateless`,
				suggestion: `\`pinned\` means the call reads or writes per-runtime mod state. If it does not, \`any\` is the honest claim and lets a host pool it.`,
			});
		}

		if (surface.kind === "binding" && !surface.declared && isNetworkedCapability(surface.capability)) {
			findings.push({
				severity: "info",
				code: "execution-missing-on-networked",
				message: `binding "${surface.name}" gates on \`${surface.capability}\` but declares no \`execution\` — networked and filesystem surfaces are the two most likely to run long`,
				suggestion: `Declare \`execution\` on it so a host knows whether to route the call off its interactive lane.`,
			});
		}
	}

	for (const mod of mods) {
		const modManifest = (mod ?? {}) as ModManifest & { name?: string };
		const label = modManifest.name ? `mod "${modManifest.name}"` : "a mod";
		for (const [slotId, exportName] of exportFills(modManifest)) {
			const hostSide = resolveExecutionIntent(host, `slots/${slotId}`);
			const modSide = resolveExecutionIntent(mod, `exports/${exportName}`);
			const gap = compareDuration(modSide.duration, hostSide.duration);
			if (gap < 2) continue;
			findings.push({
				severity: "info",
				code: "execution-intent-conflict",
				message: `${label} declares export "${exportName}" as \`duration: ${modSide.duration}\` against slot "${slotId}"'s \`${hostSide.duration}\` — two or more steps apart`,
				suggestion: `Legal, and the widened result (\`${widenExecutionIntent(hostSide, modSide).duration}\`) is what a host routes on. A gap this wide usually means one of the two claims is wrong.`,
			});
		}
	}

	return findings;
}

function isNetworkedCapability(capability: string | undefined): boolean {
	if (!capability) return false;
	const scope = capability.includes(":") ? capability.slice(capability.indexOf(":") + 1) : capability;
	return scope === "net" || scope === "fs" || scope.startsWith("net.") || scope.startsWith("fs.");
}

/** Every (slot id, export name) pair a mod's fills name, across the fill shapes that name one. */
function exportFills(mod: ModManifest): Array<[string, string]> {
	const pairs: Array<[string, string]> = [];
	for (const [slotId, value] of Object.entries(mod.fills ?? {})) {
		const entries = Array.isArray(value) ? value : [value];
		for (const entry of entries) {
			if (!entry || typeof entry !== "object") continue;
			const handler = (entry as { handler?: unknown }).handler;
			if (typeof handler === "string") pairs.push([slotId, handler]);
			const fns = (entry as { fns?: unknown }).fns;
			if (fns && typeof fns === "object") {
				for (const fn of Object.values(fns as Record<string, unknown>)) {
					if (typeof fn === "string") pairs.push([slotId, fn]);
				}
			}
		}
	}
	return pairs;
}

function sinkOf(prop: PropDefinition): string {
	return typeof prop.sink === "string" ? prop.sink : "text";
}

/**
 * Audits the host's fragment formats over their RESOLVED vocabulary scope rather than over a
 * format's inline `nodes` alone. The safety model turns on where a prop's value lands, so the
 * checks that carry weight are the ones that would make a sink unenforceable: a sink on a
 * non-string prop, a bind target that names nothing, a prop name the sanitizer always rejects,
 * and one prop name declared with two different sinks across the scope (which leaves `setProp`
 * on that name with no single answer). A vocabulary shared by several formats is audited once.
 */
function formatFindings(
	host: HostManifest,
	inheritedFormats: Set<string>,
	inheritedVocabularies: Set<string>,
): Finding[] {
	const formats = host.formats && typeof host.formats === "object" ? host.formats : undefined;
	const vocabularies =
		host.vocabularies && typeof host.vocabularies === "object" ? host.vocabularies : undefined;
	if (!formats && !vocabularies) return [];

	const findings: Finding[] = [];
	const acceptedFormats = new Set<string>();
	for (const slot of host.slots ?? []) {
		for (const accepted of slot.accepts ?? []) acceptedFormats.add(accepted);
	}

	const referencedVocabularies = new Set<string>();
	const reportedNodeFindings = new Set<string>();

	for (const [formatId, format] of Object.entries(formats ?? {})) {
		if (RESERVED_FORMAT_IDS.has(formatId)) {
			findings.push({
				severity: "error",
				code: "builtin-format-redeclared",
				message: `format "${formatId}" is a reserved built-in and cannot be redeclared`,
				suggestion: `Register a new media type for the vocabulary (e.g. "application/x-${(host as { name?: string }).name ?? "host"}+json") and name it in the slot's \`accepts\`.`,
			});
			continue;
		}

		if (!acceptedFormats.has(formatId) && !inheritedFormats.has(formatId)) {
			findings.push({
				severity: "warn",
				code: "dead-format",
				message: `format "${formatId}" is declared but no slot accepts it`,
				suggestion: `Name "${formatId}" in some slot's \`accepts\` so a mod can fill a slot with it, or drop the declaration.`,
			});
		}

		if (!format?.description) {
			findings.push({
				severity: "info",
				code: "undescribed",
				message: `format "${formatId}" has no description`,
				suggestion: `Add a description so mod authors know what the format is and what renders it.`,
			});
		}

		let profile;
		try {
			profile = resolveFormatProfile(
				formatId,
				formats as Record<string, unknown>,
				(vocabularies ?? null) as Record<string, unknown> | null,
			);
		} catch (err) {
			if (!(err instanceof FormatProfileError)) throw err;
			findings.push({
				severity: "error",
				code: schemeErrorCodes.has(err.code)
					? err.code
					: err.code === "unknown-vocabulary"
						? "unknown-vocabulary"
						: "invalid-format-scope",
				message: err.message,
				suggestion:
					err.code === "prohibited-scheme"
						? `Drop the scheme from \`schemes\`. \`javascript\` and \`vbscript\` are refused in every fragment no matter what a host declares, so listing one buys nothing and misrepresents what the format allows.`
						: err.code === "invalid-schemes"
							? `Declare \`schemes\` as an array of lowercase scheme names without the colon, e.g. ["https", "mailto"].`
							: err.code === "unknown-vocabulary"
								? `Declare the vocabulary in the host manifest's \`vocabularies\` block, or reference one that exists.`
								: `Fix the format declaration so its vocabulary scope resolves; until it does, no fill of this format can be checked.`,
			});
			continue;
		}
		if (!profile) continue;

		if (Array.isArray(format?.schemes) && profile.schemes.size === 0) {
			findings.push({
				severity: "info",
				code: "closed-schemes",
				message: `format "${formatId}" declares an empty \`schemes\`, so no absolute URI survives a fill of it`,
				suggestion: `An empty list is read as deliberate closure, not as a shorthand for the default set. Drop the key to inherit the default (\`http\`, \`https\`, \`mailto\`, \`data\`), or name the schemes the host actually resolves.`,
			});
		}

		const htmlInScope = speaksHtml(profile);
		const sinksByProp = new Map<string, Set<string>>();
		const claimedBy = new Map<string, string>();

		for (const entry of profile.scope) {
			if (entry.kind !== "declared") continue;
			if (entry.id) referencedVocabularies.add(entry.id);

			const scopeKey = entry.id ?? `${formatId}#inline`;
			const where = entry.id ? `vocabulary "${entry.id}"` : `format "${formatId}"`;
			const once = (nodeName: string, propName: string, code: string): boolean => {
				const key = `${scopeKey}::${nodeName}::${propName}::${code}`;
				if (reportedNodeFindings.has(key)) return false;
				reportedNodeFindings.add(key);
				return true;
			};

			for (const [nodeName, node] of Object.entries(entry.nodes)) {
				const owner = claimedBy.get(nodeName);
				if (owner === undefined) {
					claimedBy.set(nodeName, where);
				} else if (once(nodeName, "", "vocabulary-node-shadowed")) {
					findings.push({
						severity: "info",
						code: "vocabulary-node-shadowed",
						message: `node "${nodeName}" is declared by ${where} but format "${formatId}" resolves it through ${owner}, which is listed first`,
						suggestion: `Reorder the format's \`vocabularies\` if the other declaration should win, or rename one of the nodes so the shadowing is not silent.`,
					});
				}

				if (
					!htmlInScope
					&& STRIPPED_ELEMENTS.has(nodeName.toLowerCase())
					&& once(nodeName, "", "stripped-name-shadowed")
				) {
					findings.push({
						severity: "info",
						code: "stripped-name-shadowed",
						message: `node "${nodeName}" in ${where} names an element the HTML sanitizer always strips`,
						suggestion: `The name is legal here because no HTML vocabulary is in scope, but bringing \`html\` into scope alongside it will refuse the format. Rename the node if it may ever share a scope with HTML.`,
					});
				}

				if (!node?.description && once(nodeName, "", "undescribed")) {
					findings.push({
						severity: "info",
						code: "undescribed",
						message: `node "${nodeName}" in ${where} has no description`,
						suggestion: `Add a description so mod authors know what the node renders.`,
					});
				}

				const props = node?.props ?? {};

				for (const [propName, prop] of Object.entries(props)) {
					if (/^on/i.test(propName)) {
						if (once(nodeName, propName, "prop-name-reserved")) {
							findings.push({
								severity: "error",
								code: "prop-name-reserved",
								message: `prop "${propName}" on node "${nodeName}" in ${where} begins with "on" and is always rejected by the sanitizer`,
								suggestion: `Rename the prop. Event wiring goes through a fragment handler, never through a prop the renderer could hand to a DOM element.`,
							});
						}
						continue;
					}

					const sink = sinkOf(prop);
					if (sink !== "text") {
						if (prop.type !== "string" && once(nodeName, propName, "sink-requires-string")) {
							findings.push({
								severity: "error",
								code: "sink-requires-string",
								message: `prop "${propName}" on node "${nodeName}" in ${where} declares sink "${sink}" but is not typed "string"`,
								suggestion: `Add \`"type": "string"\` to the prop. A sink runs a string sanitizer, so a non-string value can only be dropped.`,
							});
						}
						const seen = sinksByProp.get(propName) ?? new Set<string>();
						seen.add(sink);
						sinksByProp.set(propName, seen);
					}
				}

				const bindTo = node?.bindTo;
				if (
					typeof bindTo === "string"
					&& bindTo !== "children"
					&& !(bindTo in props)
					&& once(nodeName, bindTo, "bind-target-undeclared")
				) {
					findings.push({
						severity: "error",
						code: "bind-target-undeclared",
						message: `node "${nodeName}" in ${where} binds to prop "${bindTo}" which it does not declare`,
						suggestion: `Declare prop "${bindTo}" on the node, or set \`"bindTo": "children"\` to bind into the node's content.`,
					});
				}
			}
		}

		for (const [propName, sinks] of sinksByProp) {
			if (sinks.size > 1) {
				findings.push({
					severity: "warn",
					code: "prop-sink-conflict",
					message: `prop "${propName}" is declared with conflicting sinks (${[...sinks].sort().join(", ")}) in format "${formatId}"`,
					suggestion: `A fragment op setting "${propName}" resolves its sink by union across the format's whole scope and has no single answer here, so the op is refused. Give the prop one sink across the scope, or name the variants apart.`,
				});
			}
		}
	}

	for (const [vocabularyId, vocabulary] of Object.entries(vocabularies ?? {})) {
		if (!referencedVocabularies.has(vocabularyId) && !inheritedVocabularies.has(vocabularyId)) {
			findings.push({
				severity: "warn",
				code: "dead-vocabulary",
				message: `vocabulary "${vocabularyId}" is declared but no format brings it into scope`,
				suggestion: `Name "${vocabularyId}" in some format's \`vocabularies\` array, or drop the declaration.`,
			});
		}

		if (!vocabulary?.description) {
			findings.push({
				severity: "info",
				code: "undescribed-vocabulary",
				message: `vocabulary "${vocabularyId}" has no description`,
				suggestion: `Add a description so mod authors know what the vocabulary covers and which formats speak it.`,
			});
		}
	}

	return findings;
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
