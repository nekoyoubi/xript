import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import {
	HOOK_SLOT_ACCEPT,
	resolveExtends,
	splitMode,
	scopeSubsumes,
	executionSurfaces,
	resolveExecutionIntent,
	isDefaultIntent,
	DURATION_PROSE,
	ASYNC_SHAPE_REMARK,
	LIMITS_REACH_REMARK,
	HOST_BINDING_THREAD_CONTRACT,
	resolveFormatProfile,
	FormatProfileError,
	type NodeDefinition,
	type PropDefinition,
} from "@xriptjs/validate";
import { commandSlots, generateHostCommandsSection, generateModCommandsSection, modCommands } from "./commands.js";

export { resolveExtends, ManifestResolutionError } from "@xriptjs/validate";
export { commandSlots, modCommands, summarizeSchema } from "./commands.js";

interface HookDef {
	description: string;
	phases?: string[];
	params?: Parameter[];
	capability?: string;
	async?: boolean;
	deprecated?: string;
}

function slotsDeclareBudgetNote(slots: SlotDef[]): boolean {
	return slots.some((slot) => slot.limits?.timeout_ms !== undefined);
}

interface SlotDef {
	id: string;
	accepts: string[];
	capability?: string;
	multiple?: boolean;
	style?: string;
	limits?: { timeout_ms?: number };
}

interface Manifest {
	xript: string;
	name: string;
	version?: string;
	title?: string;
	description?: string;
	bindings?: Record<string, Binding>;
	hooks?: Record<string, HookDef>;
	capabilities?: Record<string, Capability>;
	types?: Record<string, TypeDefinition>;
	slots?: SlotDef[];
	contributions?: Contributions;
	events?: EventDef[];
	fills?: Record<string, Fill[]>;
	libraries?: Record<string, LibraryDef>;
	formats?: Record<string, unknown>;
	vocabularies?: Record<string, unknown>;
	entry?: string | string[] | EntryBlock;
}

interface EntryBlock {
	script?: string;
	format?: string;
	exports?: Record<string, { description?: string; capability?: string }>;
}

interface LibraryDef {
	description?: string;
	capability?: string;
	version?: string;
	deprecated?: string;
}

type Binding = FunctionBinding | NamespaceBinding;

interface FunctionBinding {
	description: string;
	params?: Parameter[];
	returns?: TypeRef;
	async?: boolean;
	capability?: string;
	examples?: Example[];
	deprecated?: string;
}

interface NamespaceBinding {
	description: string;
	members: Record<string, Binding>;
}

interface Parameter {
	name: string;
	type: TypeRef;
	description?: string;
	default?: unknown;
	required?: boolean;
}

type TypeRef = string | ComplexTypeRef;

interface ComplexTypeRef {
	array?: TypeRef;
	union?: TypeRef[];
	map?: TypeRef;
	optional?: TypeRef;
}

interface Capability {
	description: string;
	risk?: string;
	/** Declares that this scope's children are created by the host at run time. */
	instances?: { description?: string; example?: string };
}

interface TypeDefinition {
	description: string;
	fields?: Record<string, FieldDefinition>;
	values?: string[];
	open?: boolean;
}

interface FieldDefinition {
	type: TypeRef;
	description?: string;
	optional?: boolean;
	default?: unknown;
	enum?: unknown[];
	open?: boolean;
}

interface ProviderRole {
	role: string;
	fns: Record<string, string>;
}

interface Contributions {
	provides?: ProviderRole[];
}

interface EventDef {
	id: string;
	description: string;
	payload?: TypeRef;
	capability?: string;
}

interface FragmentHandler {
	selector: string;
	on: string;
	handler: string;
}

interface Fill {
	format?: string;
	source?: string;
	inline?: boolean;
	id?: string;
	handlers?: FragmentHandler[];
	events?: FragmentHandler[];
}

interface Example {
	title?: string;
	code: string;
	description?: string;
}

export interface DocgenOptions {
	linkFormat?: "default" | "no-extension";
	frontmatter?: string;
	grantShapes?: boolean;
	/**
	 * The host manifest a mod manifest fills. Supplying it makes the slot kind of every fill exact
	 * rather than sniffed, and lets a command's Requires column fall back to the slot's gate.
	 */
	host?: unknown;
}

export interface DocgenResult {
	pages: DocPage[];
}

export interface DocPage {
	slug: string;
	title: string;
	content: string;
}

function isNamespace(binding: Binding): binding is NamespaceBinding {
	return "members" in binding;
}

/**
 * Appends `[]`, parenthesising first when the element type is a union or intersection.
 *
 * Without it, `{ array: { union: ["string", "number"] } }` documents as `string | number[]`,
 * which reads as a union with an array rather than an array of a union — and the signature block
 * is fenced as TypeScript, so the wrong type is published as code an adopter copies.
 */
function needsParensAsElement(ref: TypeRef): boolean {
	if (typeof ref === "string") return false;
	// `optional` renders as `X | undefined`, which needs the same grouping a union does.
	return Boolean(ref.union) || ref.optional !== undefined;
}

function docArrayOf(ref: TypeRef, rendered: string): string {
	return needsParensAsElement(ref) ? `(${rendered})[]` : `${rendered}[]`;
}

function formatTypeRef(ref: TypeRef): string {
	if (typeof ref === "string") {
		const primitives = ["string", "number", "boolean", "void", "null"];
		if (primitives.includes(ref)) return `\`${ref}\``;
		if (ref.endsWith("[]")) return `\`${ref.slice(0, -2)}\`[]`;
		return `\`${ref}\``;
	}
	if (ref.array !== undefined) return docArrayOf(ref.array, formatTypeRef(ref.array));
	if (ref.union) return ref.union.map(formatTypeRef).join(" \\| ");
	if (ref.map !== undefined) return `Record<string, ${formatTypeRef(ref.map)}>`;
	// `undefined` is a type name like any other here, and every other one is backticked.
	if (ref.optional !== undefined) return `${formatTypeRef(ref.optional)} \\| \`undefined\``;
	return "`unknown`";
}

function typeRefToCode(ref: TypeRef): string {
	if (typeof ref === "string") {
		if (ref.endsWith("[]")) return `${ref.slice(0, -2)}[]`;
		return ref;
	}
	if (ref.array !== undefined) return docArrayOf(ref.array, typeRefToCode(ref.array));
	if (ref.union) return ref.union.map(typeRefToCode).join(" | ");
	if (ref.map !== undefined) return `Record<string, ${typeRefToCode(ref.map)}>`;
	if (ref.optional !== undefined) return `${typeRefToCode(ref.optional)} | undefined`;
	return "unknown";
}

function isOptionalParam(param: Parameter): boolean {
	return param.default !== undefined || param.required === false;
}

/**
 * Escapes free text destined for a markdown table cell. A literal `|` would be read as a column
 * separator and a newline would end the row, so a description carrying either breaks the table.
 * A backslash-escaped pipe still renders as `|`, so this is safe to apply anywhere.
 */
function escapeCell(text: string): string {
	return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function accessLabel(mode: string): string {
	return mode === "read" ? "read access" : mode === "write" ? "write access" : `\`${mode}:\` access`;
}

function describeCapability(cap: string): string {
	const { mode, scope } = splitMode(cap);
	return `Requires capability: \`${cap}\` (${accessLabel(mode)} to the \`${scope}\` scope, satisfied by a grant on that scope or any dotted ancestor).`;
}

interface CapabilityRequirement {
	capability: string;
	kind: "binding" | "hook" | "slot" | "event";
	label: string;
	link?: string;
}

function collectCapabilityRequirements(manifest: Manifest, options?: DocgenOptions): CapabilityRequirement[] {
	const reqs: CapabilityRequirement[] = [];
	const ext = linkExt(options);

	const walkBinding = (qualified: string, binding: Binding, topLevelName: string): void => {
		if (isNamespace(binding)) {
			for (const [memberName, member] of Object.entries(binding.members)) {
				walkBinding(`${qualified}.${memberName}`, member, topLevelName);
			}
			return;
		}
		if (binding.capability) {
			reqs.push({
				capability: binding.capability,
				kind: "binding",
				label: `\`${qualified}()\``,
				link: `./bindings/${topLevelName}${ext}`,
			});
		}
	};

	if (manifest.bindings) {
		for (const [name, binding] of Object.entries(manifest.bindings)) {
			walkBinding(name, binding, name);
		}
	}

	if (manifest.hooks) {
		for (const [name, hook] of Object.entries(manifest.hooks)) {
			if (hook.capability) {
				reqs.push({ capability: hook.capability, kind: "hook", label: `\`${name}\``, link: `./hooks/${name}${ext}` });
			}
		}
	}

	if (manifest.slots) {
		for (const slot of manifest.slots) {
			if (slot.capability) {
				reqs.push({ capability: slot.capability, kind: "slot", label: `\`${slot.id}\`` });
			}
		}
	}

	if (manifest.events) {
		for (const event of manifest.events) {
			if (event.capability) {
				reqs.push({ capability: event.capability, kind: "event", label: `\`${event.id}\`` });
			}
		}
	}

	return reqs;
}

function linkExt(options?: DocgenOptions): string {
	return options?.linkFormat === "no-extension" ? "" : ".md";
}

/**
 * The Execution section: one table over every surface that can declare intent, the preamble
 * that says what intent is and is not, and the host-binding thread contract above it. Omitted
 * entirely when a manifest declares no intent anywhere, so a host that has not adopted the
 * surface sees no new noise.
 */
/**
 * The mod's host-invokable exports. Carries an Execution column because an export's declared
 * intent is half of what a host routes on: the host slot the export fills makes its own claim,
 * and the two are widened, with the more expensive claim winning.
 */
function generateExportsSection(manifest: Manifest): string[] {
	const entry = manifest.entry;
	const exports = entry && typeof entry === "object" && !Array.isArray(entry) ? entry.exports : undefined;
	if (!exports || Object.keys(exports).length === 0) return [];

	const lines: string[] = [];
	lines.push("## Exports");
	lines.push("");
	lines.push(
		"Named callables the host invokes on this mod. Each export's `Execution` is what the mod claims the call costs; the host slot it fills makes its own claim, and a host routes on the wider of the two.",
	);
	lines.push("");
	lines.push("| Export | Capability | Execution | Description |");
	lines.push("|--------|------------|-----------|-------------|");
	for (const [name, def] of Object.entries(exports)) {
		const cap = def?.capability ? `\`${def.capability}\`` : "—";
		const intent = resolveExecutionIntent(manifest, `exports/${name}`);
		lines.push(`| \`${name}\` | ${cap} | \`${intent.duration}\` / \`${intent.affinity}\` | ${escapeCell(def?.description ?? "")} |`);
	}
	lines.push("");
	return lines;
}

function generateExecutionSection(manifest: Manifest): string[] {
	const surfaces = executionSurfaces(manifest);
	if (!surfaces.some((surface) => surface.declared) && !isObject((manifest as { execution?: unknown }).execution)) {
		return [];
	}

	const lines: string[] = [];
	lines.push("## Execution");
	lines.push("");
	lines.push(
		"Declared execution intent: how long a host should expect a call to take (`duration`) and where it may run (`affinity`). This is a routing signal and nothing more — it is not `limits`, which is enforcement, and it is not a capability, so declaring `unbounded` buys no privilege. A surface that declares nothing resolves to the manifest-wide `execution`, and absent that to the defaults `brief` / `any`.",
	);
	lines.push("");
	lines.push(
		"`async` is a separate axis and does not imply any of this: it declares the SHAPE of the value a host binding returns, not the cost of the call, and it does not promise the interpreter yields. A binding may be synchronous and `unbounded`, or `async` and `instant`.",
	);
	lines.push("");
	lines.push(
		"One thing intent cannot buy: xript's execution budget bounds SCRIPT execution, not host-binding execution. Once control is inside a host binding the interpreter is not running, so no xript timeout, cancellation token, or drop-cancel is observed until the binding returns. Bounding a binding that may block is the host's own job.",
	);
	lines.push("");
	lines.push(`> **${HOST_BINDING_THREAD_CONTRACT}**`);
	lines.push("");
	lines.push("| Surface | Kind | Duration | Affinity | Declared |");
	lines.push("|---------|------|----------|----------|----------|");
	for (const surface of surfaces) {
		lines.push(
			`| \`${surface.name}\` | ${surface.kind} | \`${surface.resolved.duration}\` | \`${surface.resolved.affinity}\` | ${surface.declared ? "Yes" : "inherited"} |`,
		);
	}
	lines.push("");
	return lines;
}

function isObject(value: unknown): boolean {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The per-surface execution note that rides on a binding, hook, or export page. The two
 * unconditional remarks are the same ones typegen emits, for the same reason: a reader who
 * lands on the page rather than the table still has to be told what `async` and what a timeout
 * actually do.
 */
function executionNote(manifest: unknown, path: string, isAsync = false): string[] {
	const resolved = resolveExecutionIntent(manifest, path);
	const lines: string[] = [];
	if (!isDefaultIntent(resolved)) {
		lines.push(`**Execution:** \`duration: ${resolved.duration}\` — ${DURATION_PROSE[resolved.duration]}. \`affinity: ${resolved.affinity}\`.`);
		lines.push("");
	}
	if (isAsync) {
		lines.push(`> ${ASYNC_SHAPE_REMARK}`);
		lines.push("");
	}
	if (resolved.duration === "long" || resolved.duration === "unbounded") {
		lines.push(`> ${LIMITS_REACH_REMARK}`);
		lines.push("");
	}
	return lines;
}

function generateIndexPage(manifest: Manifest, options?: DocgenOptions): DocPage {
	const lines: string[] = [];
	const displayName = manifest.title || manifest.name;

	lines.push(`# ${displayName} API Reference`);
	lines.push("");
	if (manifest.description) {
		lines.push(manifest.description);
		lines.push("");
	}
	if (manifest.version) {
		lines.push(`**API Version:** ${manifest.version}`);
		lines.push("");
	}

	if (manifest.bindings) {
		lines.push("## API Surface");
		lines.push("");

		const topLevel: string[] = [];
		const namespaces: string[] = [];

		for (const [name, binding] of Object.entries(manifest.bindings)) {
			if (isNamespace(binding)) {
				namespaces.push(name);
			} else {
				topLevel.push(name);
			}
		}

		if (topLevel.length > 0) {
			lines.push("### Global Functions");
			lines.push("");
			for (const name of topLevel) {
				const binding = manifest.bindings[name] as FunctionBinding;
				const ext = linkExt(options);
				lines.push(`- [\`${name}()\`](./bindings/${name}${ext})${binding.description ? ` — ${binding.description}` : ""}`);
			}
			lines.push("");
		}

		if (namespaces.length > 0) {
			lines.push("### Namespaces");
			lines.push("");
			for (const name of namespaces) {
				const binding = manifest.bindings[name] as NamespaceBinding;
				const memberCount = Object.keys(binding.members).length;
				const ext = linkExt(options);
				const count = `(${memberCount} ${memberCount === 1 ? "function" : "functions"})`;
				lines.push(
					`- [\`${name}\`](./bindings/${name}${ext})${binding.description ? ` — ${binding.description} ` : " "}${count}`,
				);
			}
			lines.push("");
		}
	}

	if (manifest.hooks) {
		lines.push("## Hooks");
		lines.push("");

		for (const [name, hook] of Object.entries(manifest.hooks)) {
			const phaseInfo =
				hook.phases && hook.phases.length > 0 ? ` *(${hook.phases.join(", ")})*` : "";
			const ext = linkExt(options);
			lines.push(`- [\`${name}\`](./hooks/${name}${ext}) — ${hook.description}${phaseInfo}`);
		}
		lines.push("");
	}

	lines.push(...generateExportsSection(manifest));
	lines.push(...generateExecutionSection(manifest));

	if (manifest.events && manifest.events.length > 0) {
		lines.push("## Events");
		lines.push("");
		lines.push(
			"The named events this host emits, with their payload types. This is a discovery declaration (a catalog of what the host broadcasts), not a presumption of who listens. Sandbox scripts, the host UI, and external subscribers can all consume these events; the manifest only states that they are emitted.",
		);
		lines.push("");
		lines.push(
			"Keep three neighbors distinct: bindings are *what you can call*, slots and fragment handlers are *what handles*, and events are *what the host emits*. An event-typed slot (`accepts: application/x-xript-hook`) is an extension point an addon fills with a handler; a fragment fill's `handlers` are DOM responses wired onto rendered markup; an event here is a broadcast the host produces, with no consumer presupposed.",
		);
		lines.push("");
		lines.push(
			"A script subscribes to an event with `events.on(\"<event.id>\", handler)` (alias `events.subscribe`). Subscription is capability-gated per event at registration time, reusing the hook gate model: a grant satisfies an event's declared capability by mode-lattice and prefix-subsumption, and a denied subscription throws. Events without a capability are open to any script.",
		);
		lines.push("");
		const eventsHaveCapability = manifest.events.some((event) => event.capability);
		if (eventsHaveCapability) {
			lines.push("| Event | Payload | Capability | Description |");
			lines.push("|-------|---------|------------|-------------|");
			for (const event of manifest.events) {
				const payload = event.payload !== undefined ? formatTypeRef(event.payload) : "—";
				const cap = event.capability ? `\`${event.capability}\`` : "—";
				lines.push(`| \`${event.id}\` | ${payload} | ${cap} | ${escapeCell(event.description)} |`);
			}
		} else {
			lines.push("| Event | Payload | Description |");
			lines.push("|-------|---------|-------------|");
			for (const event of manifest.events) {
				const payload = event.payload !== undefined ? formatTypeRef(event.payload) : "—";
				lines.push(`| \`${event.id}\` | ${payload} | ${escapeCell(event.description)} |`);
			}
		}
		lines.push("");
	}

	if (manifest.libraries && Object.keys(manifest.libraries).length > 0) {
		lines.push("## Libraries");
		lines.push("");
		lines.push(
			"Approved importable libraries. Imports are default-deny; these specifiers are the curated allow-list that lifts it, gated per-library by capability. An imported library runs inside the sandbox at the importing mod's own privilege (full-fidelity calls, no JSON boundary) and is a self-contained pre-bundled ES module with no imports of its own.",
		);
		lines.push("");
		lines.push("| Library | Version | Capability | Description |");
		lines.push("|---------|---------|------------|-------------|");
		for (const [specifier, library] of Object.entries(manifest.libraries)) {
			const version = library.version ? `\`${library.version}\`` : "—";
			const cap = library.capability ? `\`${library.capability}\`` : "—";
			const deprecated = library.deprecated ? ` **Deprecated:** ${library.deprecated}` : "";
			lines.push(`| \`${specifier}\` | ${version} | ${cap} | ${escapeCell(library.description ?? "")}${deprecated} |`);
		}
		lines.push("");
	}

	if (manifest.types) {
		lines.push("## Types");
		lines.push("");
		for (const [name, def] of Object.entries(manifest.types)) {
			const kind = def.values ? "enum" : "interface";
			const ext = linkExt(options);
			lines.push(`- [\`${name}\`](./types/${name}${ext}) — ${def.description} *(${kind})*`);
		}
		lines.push("");
	}

	const hostCommandSlots = commandSlots(manifest.slots);
	if (hostCommandSlots.length > 0) {
		lines.push(...generateHostCommandsSection(hostCommandSlots));
	}

	const uiSlots = (manifest.slots ?? []).filter((slot) => !hostCommandSlots.some((command) => command.id === slot.id));
	if (uiSlots.length > 0) {
		lines.push("## UI Slots");
		lines.push("");
		lines.push("Available mounting points for mod UI fragments.");
		lines.push("");
		if (slotsDeclareBudgetNote(uiSlots)) {
			lines.push(
				"**Budget** is the deadline calls into that slot's fills run under, overriding this manifest's `limits`. A slot may raise it as well as lower it; the embedder's hard limits still clamp the result. Slots reading *inherited* run under the manifest budget.",
			);
			lines.push("");
		}
		const slotsDeclareIntent = uiSlots.some((slot) => (slot as { execution?: unknown }).execution !== undefined);
		const slotsDeclareBudget = uiSlots.some((slot) => slot.limits?.timeout_ms !== undefined);
		lines.push(
			`| Slot | Accepts | Multiple | Style | Capability |${slotsDeclareIntent ? " Execution |" : ""}${slotsDeclareBudget ? " Budget |" : ""}`,
		);
		lines.push(
			`|------|---------|----------|-------|------------|${slotsDeclareIntent ? "-----------|" : ""}${slotsDeclareBudget ? "--------|" : ""}`,
		);
		for (const slot of uiSlots) {
			const accepts = slot.accepts.join(", ");
			const multiple = slot.multiple ? "Yes" : "No";
			const style = slot.style || "inherit";
			const cap = slot.capability ? `\`${slot.capability}\`` : "—";
			const intent = resolveExecutionIntent(manifest, `slots/${slot.id}`);
			const execution = slotsDeclareIntent ? ` \`${intent.duration}\` / \`${intent.affinity}\` |` : "";
			const budget = slotsDeclareBudget
				? ` ${slot.limits?.timeout_ms === undefined ? "inherited" : `\`${slot.limits.timeout_ms}ms\``} |`
				: "";
			lines.push(`| \`${slot.id}\` | ${accepts} | ${multiple} | ${style} | ${cap} |${execution}${budget}`);
		}
		lines.push("");
		const fragExt = linkExt(options);
		lines.push(`See [Fragment API](./fragment-api${fragExt}) for the sandbox fragment manipulation API.`);
		lines.push("");
	}

	lines.push(...generateFormatsSection(manifest));

	if (manifest.capabilities && !Array.isArray(manifest.capabilities)) {
		lines.push("## Capabilities");
		lines.push("");
		const capNames = Object.keys(manifest.capabilities);
		const anyDotted = capNames.some((name) => name.includes("."));
		lines.push(
			"Declared capability keys are scope-only: each names a node in a dotted scope tree, with no `read:`/`write:` mode prefix. A *reference* (a binding, hook, slot, or event `capability` field, or a host grant) may carry a mode prefix. A grant satisfies a requirement when its mode covers the required mode (`write` ⊒ `read`) **and** its scope equals or is a dotted ancestor of the required scope.",
		);
		lines.push("");
		lines.push("| Capability | Scope | Description | Risk |");
		lines.push("|------------|-------|-------------|------|");
		for (const [name, cap] of Object.entries(manifest.capabilities)) {
			const risk = cap.risk || "low";
			const depth = name.split(".").length;
			const scopeNote = depth > 1 ? `nested (depth ${depth})` : "top-level";
			lines.push(`| \`${name}\` | ${scopeNote} | ${escapeCell(cap.description)} | ${risk} |`);
		}
		lines.push("");
		const dynamicScopes = Object.entries(manifest.capabilities).filter(([, cap]) => cap.instances !== undefined);
		if (dynamicScopes.length > 0) {
			lines.push("### Runtime-configured scopes");
			lines.push("");
			lines.push(
				"These scopes have children the host creates at run time — one per configured root, account, or project. Request the specific child you need; a grant on the parent covers every instance under it, including ones that do not exist yet.",
			);
			lines.push("");
			lines.push("| Capability | One child is | Example |");
			lines.push("|------------|--------------|---------|");
			for (const [name, cap] of dynamicScopes) {
				const instances = cap.instances!;
				const example = instances.example ? `\`${instances.example}\`` : "—";
				lines.push(`| \`${name}\` | ${escapeCell(instances.description ?? "—")} | ${example} |`);
			}
			lines.push("");
		}
		if (anyDotted) {
			lines.push(
				"Because scopes subsume by prefix, a grant on a parent scope also satisfies any requirement nested beneath it — a grant on `run` covers `run.command`, but not the unrelated sibling `runner`.",
			);
			lines.push("");
		}
	}

	const capRequirements = collectCapabilityRequirements(manifest, options);
	if (manifest.capabilities && !Array.isArray(manifest.capabilities) && capRequirements.length > 0) {
		lines.push("## Capability Requirements");
		lines.push("");
		lines.push(
			"Gate sites grouped by the capability they require, so a modder can read off exactly which grant unlocks what. Each entry lists the bindings, hooks, slots, and events that reference the capability directly, followed by any whose requirement a grant on this scope *also* satisfies through prefix-subsumption.",
		);
		lines.push("");
		for (const [name] of Object.entries(manifest.capabilities)) {
			const grantScope = splitMode(name).scope;
			const direct = capRequirements.filter((r) => r.capability === name);
			const subsumed = capRequirements.filter((r) => {
				if (r.capability === name) return false;
				return scopeSubsumes(grantScope, splitMode(r.capability).scope);
			});
			if (direct.length === 0 && subsumed.length === 0) continue;
			lines.push(`### \`${name}\``);
			lines.push("");
			const renderReq = (r: CapabilityRequirement): string => {
				const label = r.link ? `[${r.label}](${r.link})` : r.label;
				return `- ${label} *(${r.kind})*`;
			};
			for (const r of direct) {
				lines.push(renderReq(r));
			}
			if (subsumed.length > 0) {
				lines.push("");
				lines.push(
					`A grant on \`${name}\` also satisfies, by scope subsumption, the requirements of:`,
				);
				for (const r of subsumed) {
					lines.push(`- ${r.link ? `[${r.label}](${r.link})` : r.label} *(${r.kind})* — requires \`${r.capability}\``);
				}
			}
			lines.push("");
		}
	}

	const provides = manifest.contributions?.provides;
	if (provides && provides.length > 0) {
		lines.push("## Provides");
		lines.push("");
		lines.push("Logical roles this mod provides. The host resolves a role to this mod and calls the concrete fns; xript never invokes them.");
		lines.push("");
		for (const role of provides) {
			lines.push(`### \`${role.role}\``);
			lines.push("");
			lines.push("| Logical fn | Concrete fn |");
			lines.push("|------------|-------------|");
			for (const [logical, concrete] of Object.entries(role.fns)) {
				lines.push(`| \`${logical}\` | \`${concrete}\` |`);
			}
			lines.push("");
		}
	}

	const contributed = modCommands(manifest.fills, options?.host !== undefined ? ((options.host as { slots?: unknown }).slots ?? []) : undefined);
	if (contributed.length > 0) {
		const hostSlots = commandSlots(options?.host !== undefined ? (options.host as { slots?: unknown }).slots : manifest.slots);
		const entry = manifest.entry;
		const exportDefs = entry && typeof entry === "object" && !Array.isArray(entry) ? entry.exports : undefined;
		lines.push(
			...generateModCommandsSection(
				contributed,
				(slotId) => hostSlots.find((slot) => slot.id === slotId)?.capability,
				(handler) => exportDefs?.[handler]?.capability,
			),
		);
	}

	if (manifest.fills && Object.keys(manifest.fills).length > 0) {
		const fillsWithHandlers = Object.entries(manifest.fills).filter(([, fills]) =>
			fills.some((fill) => (fill.handlers && fill.handlers.length > 0) || (fill.events && fill.events.length > 0)),
		);
		if (fillsWithHandlers.length > 0) {
			lines.push("## Fragment Handlers");
			lines.push("");
			lines.push(
				"DOM event handlers wired onto fragment fills. Each handler binds a sandbox export to an event on elements matching a CSS selector within the rendered fragment.",
			);
			lines.push("");
			for (const [slotId, fills] of fillsWithHandlers) {
				for (const fill of fills) {
					const handlers = fill.handlers && fill.handlers.length > 0 ? fill.handlers : fill.events;
					if (!handlers || handlers.length === 0) continue;
					const usingAlias = !(fill.handlers && fill.handlers.length > 0);
					const fillLabel = fill.id ? `\`${slotId}\` (\`${fill.id}\`)` : `\`${slotId}\``;
					lines.push(`### ${fillLabel}`);
					lines.push("");
					if (usingAlias) {
						lines.push(
							"> **Deprecated:** this fill declares handlers under the `events` key. `events` is a deprecated alias for `handlers` — rename the key. If both are present, `handlers` wins.",
						);
						lines.push("");
					}
					lines.push("| Selector | Event | Handler |");
					lines.push("|----------|-------|---------|");
					for (const h of handlers) {
						lines.push(`| \`${h.selector}\` | \`${h.on}\` | \`${h.handler}\` |`);
					}
					lines.push("");
				}
			}
		}
	}

	return { slug: "index", title: `${displayName} API Reference`, content: lines.join("\n") };
}

function generateFunctionPage(name: string, binding: FunctionBinding, manifest?: Manifest): DocPage {
	const lines: string[] = [];

	lines.push(`# ${name}()`);
	lines.push("");
	if (binding.deprecated) {
		lines.push(`> **Deprecated:** ${binding.deprecated}`);
		lines.push("");
	}
	if (binding.description) {
		lines.push(binding.description);
		lines.push("");
	}

	const params = binding.params || [];
	const paramStr = params
		.map((p) => {
			const opt = isOptionalParam(p) ? "?" : "";
			return `${p.name}${opt}: ${typeRefToCode(p.type)}`;
		})
		.join(", ");
	let returnType = binding.returns ? typeRefToCode(binding.returns) : "void";
	if (binding.async) returnType = `Promise<${returnType}>`;

	lines.push("## Signature");
	lines.push("");
	lines.push("```typescript");
	lines.push(`function ${name}(${paramStr}): ${returnType}`);
	lines.push("```");
	lines.push("");
	lines.push(...executionNote(manifest, `bindings/${name}`, binding.async === true));

	if (params.length > 0) {
		lines.push("## Parameters");
		lines.push("");
		lines.push("| Name | Type | Required | Description |");
		lines.push("|------|------|----------|-------------|");
		for (const p of params) {
			const req = isOptionalParam(p) ? "No" : "Yes";
			const desc = escapeCell(p.description || "");
			const defaultNote = p.default !== undefined ? ` (default: \`${JSON.stringify(p.default)}\`)` : "";
			lines.push(`| \`${p.name}\` | ${formatTypeRef(p.type)} | ${req} | ${desc}${defaultNote} |`);
		}
		lines.push("");
	}

	if (binding.returns) {
		lines.push("## Returns");
		lines.push("");
		lines.push(`${formatTypeRef(binding.returns)}${binding.async ? " (async)" : ""}`);
		lines.push("");
	}

	if (binding.capability) {
		lines.push("## Requires Capability");
		lines.push("");
		lines.push(describeCapability(binding.capability));
		lines.push("");
	}

	if (binding.examples && binding.examples.length > 0) {
		lines.push("## Examples");
		lines.push("");
		for (const example of binding.examples) {
			if (example.title) {
				lines.push(`### ${example.title}`);
				lines.push("");
			}
			if (example.description) {
				lines.push(example.description);
				lines.push("");
			}
			lines.push("```javascript");
			lines.push(example.code);
			lines.push("```");
			lines.push("");
		}
	}

	return { slug: `bindings/${name}`, title: `${name}()`, content: lines.join("\n") };
}

function appendNamespaceMember(
	lines: string[],
	qualifiedPrefix: string,
	memberName: string,
	fn: FunctionBinding,
	manifest?: Manifest,
): void {
	const params = fn.params || [];
	const paramStr = params
		.map((p) => {
			const opt = isOptionalParam(p) ? "?" : "";
			return `${p.name}${opt}: ${typeRefToCode(p.type)}`;
		})
		.join(", ");
	let returnType = fn.returns ? typeRefToCode(fn.returns) : "void";
	if (fn.async) returnType = `Promise<${returnType}>`;

	lines.push(`### ${qualifiedPrefix}.${memberName}()`);
	lines.push("");
	if (fn.deprecated) {
		lines.push(`> **Deprecated:** ${fn.deprecated}`);
		lines.push("");
	}
	lines.push(fn.description);
	lines.push("");
	lines.push("```typescript");
	lines.push(`function ${memberName}(${paramStr}): ${returnType}`);
	lines.push("```");
	lines.push("");
	lines.push(...executionNote(manifest, `bindings/${qualifiedPrefix}.${memberName}`, fn.async === true));

	if (params.length > 0) {
		lines.push("**Parameters:**");
		lines.push("");
		lines.push("| Name | Type | Required | Description |");
		lines.push("|------|------|----------|-------------|");
		for (const p of params) {
			const req = isOptionalParam(p) ? "No" : "Yes";
			const desc = escapeCell(p.description || "");
			const defaultNote = p.default !== undefined ? ` (default: \`${JSON.stringify(p.default)}\`)` : "";
			lines.push(`| \`${p.name}\` | ${formatTypeRef(p.type)} | ${req} | ${desc}${defaultNote} |`);
		}
		lines.push("");
	}

	if (fn.returns) {
		lines.push(`**Returns:** ${formatTypeRef(fn.returns)}${fn.async ? " (async)" : ""}`);
		lines.push("");
	}

	if (fn.capability) {
		lines.push(`**${describeCapability(fn.capability)}**`);
		lines.push("");
	}

	if (fn.examples && fn.examples.length > 0) {
		for (const example of fn.examples) {
			if (example.title) {
				lines.push(`**Example: ${example.title}**`);
				lines.push("");
			}
			if (example.description) {
				lines.push(example.description);
				lines.push("");
			}
			lines.push("```javascript");
			lines.push(example.code);
			lines.push("```");
			lines.push("");
		}
	}
}

function appendNamespaceMembers(
	lines: string[],
	qualifiedPrefix: string,
	members: Record<string, Binding>,
	manifest?: Manifest,
): void {
	for (const [memberName, memberBinding] of Object.entries(members)) {
		if (isNamespace(memberBinding)) {
			appendNamespaceMembers(lines, `${qualifiedPrefix}.${memberName}`, memberBinding.members, manifest);
		} else {
			appendNamespaceMember(lines, qualifiedPrefix, memberName, memberBinding as FunctionBinding, manifest);
		}
	}
}

function generateNamespacePage(name: string, binding: NamespaceBinding, manifest: Manifest): DocPage {
	const lines: string[] = [];

	lines.push(`# ${name}`);
	lines.push("");
	if (binding.description) {
		lines.push(binding.description);
		lines.push("");
	}

	lines.push("## Functions");
	lines.push("");

	appendNamespaceMembers(lines, name, binding.members, manifest);

	return { slug: `bindings/${name}`, title: name, content: lines.join("\n") };
}

function generateTypePage(name: string, def: TypeDefinition): DocPage {
	const lines: string[] = [];

	lines.push(`# ${name}`);
	lines.push("");
	lines.push(def.description);
	lines.push("");

	if (def.values) {
		lines.push("## Values");
		lines.push("");
		lines.push(`\`${name}\` is a string enum with the following values:`);
		lines.push("");
		for (const value of def.values) {
			lines.push(`- \`"${value}"\``);
		}
		lines.push("");
		if (def.open) {
			lines.push(
				"This is an open enum: the values above are the known set, but any other string is also accepted (for example, addon-contributed values).",
			);
			lines.push("");
		}
		lines.push("## TypeScript");
		lines.push("");
		lines.push("```typescript");
		lines.push(`type ${name} = ${def.values.map((v) => `"${v}"`).join(" | ")}${def.open ? " | (string & {})" : ""};`);
		lines.push("```");
		lines.push("");
	} else if (def.fields) {
		lines.push("## Fields");
		lines.push("");
		lines.push("| Field | Type | Required | Default | Allowed Values | Description |");
		lines.push("|-------|------|----------|---------|----------------|-------------|");
		for (const [fieldName, field] of Object.entries(def.fields)) {
			const req = field.default !== undefined ? "Yes" : field.optional ? "No" : "Yes";
			const desc = escapeCell(field.description || "");
			const def_ = field.default !== undefined ? `\`${JSON.stringify(field.default)}\`` : "—";
			const allowed = Array.isArray(field.enum) && field.enum.length > 0
				? field.enum.map((v) => `\`${JSON.stringify(v)}\``).join(", ")
				: "—";
			lines.push(`| \`${fieldName}\` | ${formatTypeRef(field.type)} | ${req} | ${def_} | ${allowed} | ${desc} |`);
		}
		lines.push("");
		lines.push("## TypeScript");
		lines.push("");
		lines.push("```typescript");
		lines.push(`interface ${name} {`);
		for (const [fieldName, field] of Object.entries(def.fields)) {
			const opt = field.optional ? "?" : "";
			lines.push(`  ${fieldName}${opt}: ${typeRefToCode(field.type)};`);
		}
		lines.push("}");
		lines.push("```");
		lines.push("");
	}

	return { slug: `types/${name}`, title: name, content: lines.join("\n") };
}

function generateHookPage(name: string, hookDef: HookDef, manifest?: Manifest): DocPage {
	const lines: string[] = [];

	lines.push(`# ${name}`);
	lines.push("");
	if (hookDef.deprecated) {
		lines.push(`> **Deprecated:** ${hookDef.deprecated}`);
		lines.push("");
	}
	lines.push(hookDef.description);
	lines.push("");
	lines.push(...executionNote(manifest, `hooks/${name}`, hookDef.async === true));

	const params = hookDef.params || [];
	const handlerParams = params
		.map((p) => {
			const opt = isOptionalParam(p) ? "?" : "";
			return `${p.name}${opt}: ${typeRefToCode(p.type)}`;
		})
		.join(", ");
	const handlerType = `(${handlerParams}) => void`;

	if (hookDef.phases && hookDef.phases.length > 0) {
		lines.push("## Phases");
		lines.push("");
		for (const phase of hookDef.phases) {
			lines.push(`- \`${phase}\``);
		}
		lines.push("");

		lines.push("## Registration");
		lines.push("");
		lines.push("```typescript");
		for (const phase of hookDef.phases) {
			lines.push(`hooks.${name}.${phase}(handler: ${handlerType}): void`);
		}
		lines.push("```");
		lines.push("");
	} else {
		lines.push("## Registration");
		lines.push("");
		lines.push("```typescript");
		lines.push(`hooks.${name}(handler: ${handlerType}): void`);
		lines.push("```");
		lines.push("");
	}

	if (params.length > 0) {
		lines.push("## Handler Parameters");
		lines.push("");
		lines.push("| Name | Type | Required | Description |");
		lines.push("|------|------|----------|-------------|");
		for (const p of params) {
			const req = isOptionalParam(p) ? "No" : "Yes";
			const desc = escapeCell(p.description || "");
			const defaultNote =
				p.default !== undefined ? ` (default: \`${JSON.stringify(p.default)}\`)` : "";
			lines.push(`| \`${p.name}\` | ${formatTypeRef(p.type)} | ${req} | ${desc}${defaultNote} |`);
		}
		lines.push("");
	}

	if (hookDef.capability) {
		lines.push("## Requires Capability");
		lines.push("");
		lines.push(describeCapability(hookDef.capability));
		lines.push("");
	}

	return { slug: `hooks/${name}`, title: name, content: lines.join("\n") };
}

function generateFragmentAPIPage(): DocPage {
	const lines: string[] = [];

	lines.push("# Fragment API");
	lines.push("");
	lines.push("The sandbox fragment API provides imperative fragment manipulation from within mod scripts.");
	lines.push("All operations use the command buffer pattern — method calls accumulate operations that the host applies after the callback returns.");
	lines.push("");

	lines.push("## Lifecycle Hooks");
	lines.push("");
	lines.push("```javascript");
	lines.push('hooks.fragment.mount(fragmentId, (fragment) => { /* called on mount */ });');
	lines.push('hooks.fragment.unmount(fragmentId, (fragment) => { /* called on unmount */ });');
	lines.push('hooks.fragment.update(fragmentId, (bindings, fragment) => { /* called on data change */ });');
	lines.push('hooks.fragment.suspend(fragmentId, (fragment) => { /* called on suspend */ });');
	lines.push('hooks.fragment.resume(fragmentId, (fragment) => { /* called on resume */ });');
	lines.push("```");
	lines.push("");

	lines.push("## Fragment Proxy Methods");
	lines.push("");
	lines.push("| Method | Arguments | Effect |");
	lines.push("|--------|-----------|--------|");
	lines.push("| `toggle(selector, condition)` | CSS selector, boolean | Show/hide matching elements |");
	lines.push("| `addClass(selector, className)` | CSS selector, string | Add class to matching elements |");
	lines.push("| `removeClass(selector, className)` | CSS selector, string | Remove class from matching elements |");
	lines.push("| `setText(selector, text)` | CSS selector, string | Set text content of matching elements |");
	lines.push("| `setProp(selector, prop, value)` | CSS selector, string, any | Set a prop on matching nodes; the value keeps its type |");
	lines.push("| `setAttr(selector, attr, value)` | CSS selector, string, string | **Deprecated** alias of `setProp`, kept under its own op name |");
	lines.push("| `replaceChildren(selector, html)` | CSS selector, string/string[] | Replace children of matching elements |");
	lines.push("");

	lines.push("## Example");
	lines.push("");
	lines.push("```javascript");
	lines.push('hooks.fragment.update("health-panel", function (bindings, fragment) {');
	lines.push('  fragment.toggle(".warning", bindings.health < 50);');
	lines.push('  fragment.addClass(".bar", bindings.health < 20 ? "critical" : "normal");');
	lines.push('  fragment.setText(".hp-text", bindings.health + "/" + bindings.maxHealth);');
	lines.push("});");
	lines.push("```");
	lines.push("");

	return { slug: "fragment-api", title: "Fragment API", content: lines.join("\n") };
}

function generateGrantShapesPage(): DocPage {
	const lines: string[] = [];

	lines.push("# Capability Grant Shapes");
	lines.push("");
	lines.push("Host-side wire shapes for capability grant flows. The runtimes never see these — grant policy and prompt UX stay host-side. Granting still flows through `RuntimeOptions.capabilities`.");
	lines.push("");

	lines.push("## CapabilityPrompt");
	lines.push("");
	lines.push("What a host needs to render a first-time or elevation grant prompt.");
	lines.push("");
	lines.push("| Field | Type | Required | Description |");
	lines.push("|-------|------|----------|-------------|");
	lines.push("| `capability` | `string` | Yes | The capability name being requested. |");
	lines.push("| `description` | `string` | Yes | From the manifest capability definition. |");
	lines.push("| `risk` | `\"low\" \\| \"medium\" \\| \"high\"` | Yes | From the manifest capability definition. |");
	lines.push("| `mod` | `{ name, version, title? }` | Yes | Identity of the requesting mod. |");
	lines.push("| `requestedScope` | `\"one-run\" \\| \"session\" \\| \"persistent\"` | Yes | How long the grant should apply. |");
	lines.push("| `state` | `\"first-time\" \\| \"previously-denied\" \\| \"requesting-elevation\"` | Yes | Why the prompt is shown. |");
	lines.push("| `reason` | `string` | No | Optional human reason the mod supplies. |");
	lines.push("");

	lines.push("## InstallDescriptor");
	lines.push("");
	lines.push("What identifies an installable mod. `integrity` and `signature` are host-verified; xript defines the fields and never checks them.");
	lines.push("");
	lines.push("| Field | Type | Required | Description |");
	lines.push("|-------|------|----------|-------------|");
	lines.push("| `name` | `string` | Yes | Machine-readable mod identifier. |");
	lines.push("| `version` | `string` | Yes | Semver. |");
	lines.push("| `title` | `string` | No | Display name. |");
	lines.push("| `source` | `{ type: \"file\" \\| \"url\" \\| \"registry\", location }` | Yes | Where the mod comes from. |");
	lines.push("| `integrity` | `string` | No | SRI-style hash, host-verified. |");
	lines.push("| `signature` | `string` | No | Detached signature, host-verified. |");
	lines.push("| `capabilities` | `string[]` | No | Declared required capabilities. |");
	lines.push("| `manifest` | `object` | No | Inline mod manifest, or omitted when fetched lazily. |");
	lines.push("");

	lines.push("## DiscoveryResult");
	lines.push("");
	lines.push("What an addon-discovery pass yields per candidate. `provides` holds logical roles, shared with mod-manifest `contributions.provides`.");
	lines.push("");
	lines.push("| Field | Type | Required | Description |");
	lines.push("|-------|------|----------|-------------|");
	lines.push("| `mods` | `Array<{ name, version, title?, location, enabled, capabilities, provides }>` | Yes | Candidate mods discovered. |");
	lines.push("| `scannedAt` | `number` | No | Epoch ms at which the scan completed. |");
	lines.push("");

	return { slug: "capability-grant-shapes", title: "Capability Grant Shapes", content: lines.join("\n") };
}

function effectiveHooks(hooks: Record<string, HookDef> | undefined, slots: SlotDef[] | undefined): Record<string, HookDef> {
	const merged: Record<string, HookDef> = { ...(hooks ?? {}) };
	for (const slot of slots ?? []) {
		if (!slot.accepts?.includes(HOOK_SLOT_ACCEPT) || slot.id in merged) continue;
		merged[slot.id] = { description: (slot as { description?: string }).description ?? "", capability: slot.capability };
	}
	return merged;
}

function renderPropType(prop: PropDefinition): string {
	const type = Array.isArray(prop.type) ? prop.type.join(" | ") : (prop.type ?? "any");
	const parts = [`\`${type}\``];
	if (prop.sink) parts.push(`sink \`${prop.sink}\``);
	if (prop.default !== undefined) parts.push(`default \`${JSON.stringify(prop.default)}\``);
	return parts.join(", ");
}

function renderChildren(children: NodeDefinition["children"]): string {
	if (children === undefined || children === "any") return "any";
	if (Array.isArray(children)) return children.map((child) => `\`${child}\``).join(", ");
	return String(children);
}

/**
 * A table per declared fragment format, listing the host's own vocabulary nodes and their props.
 * The built-in `html` vocabulary is not enumerated — a format that scopes it in accepts every HTML
 * element, which is documented elsewhere; only the nodes the host declared are worth a table here.
 */
function generateFormatsSection(manifest: Manifest): string[] {
	const formats = manifest.formats;
	if (!formats || typeof formats !== "object" || Object.keys(formats).length === 0) return [];

	const lines: string[] = ["## Fragment Formats", ""];
	lines.push(
		"Each format names a syntax and the node vocabulary a fill of that format may use. Only the host's declared nodes are listed; a format that also scopes in the built-in `html` vocabulary accepts every HTML element in addition.",
		"",
	);

	for (const [formatId, def] of Object.entries(formats)) {
		lines.push(`### \`${formatId}\``, "");
		const description = (def as { description?: string }).description;
		if (description) lines.push(description, "");
		const syntax = (def as { syntax?: string }).syntax;
		if (syntax) lines.push(`**Syntax:** \`${syntax}\``, "");

		let profile;
		try {
			profile = resolveFormatProfile(formatId, formats as Parameters<typeof resolveFormatProfile>[1], (manifest.vocabularies ?? null) as Parameters<typeof resolveFormatProfile>[2]);
		} catch (error) {
			if (error instanceof FormatProfileError) {
				lines.push(`_Could not resolve this format's scope: ${error.message}_`, "");
				continue;
			}
			throw error;
		}
		if (!profile) {
			lines.push("_No profile resolved for this format._", "");
			continue;
		}

		const nodes = profile.scope
			.filter((vocab): vocab is Extract<typeof vocab, { kind: "declared" }> => vocab.kind === "declared")
			.flatMap((vocab) => Object.entries(vocab.nodes));
		if (nodes.length === 0) {
			lines.push("_No host-declared nodes; the format's scope is the built-in HTML vocabulary._", "");
			continue;
		}

		lines.push("| Node | Props | Children |", "|------|-------|----------|");
		for (const [nodeName, node] of nodes) {
			const props = node.props
				? Object.entries(node.props)
						.map(([propName, propDef]) => `\`${propName}\`: ${renderPropType(propDef)}`)
						.join("<br>")
				: "—";
			lines.push(`| \`${nodeName}\` | ${props} | ${renderChildren(node.children)} |`);
		}
		lines.push("");
	}
	return lines;
}

export function generateDocs(manifest: unknown, options?: DocgenOptions): DocgenResult {
	const raw = manifest as Manifest;
	const folded = effectiveHooks(raw.hooks, raw.slots);
	const m: Manifest = Object.keys(folded).length > 0 ? { ...raw, hooks: folded } : raw;
	const pages: DocPage[] = [];

	pages.push(generateIndexPage(m, options));

	if (m.bindings) {
		for (const [name, binding] of Object.entries(m.bindings)) {
			if (isNamespace(binding)) {
				pages.push(generateNamespacePage(name, binding, m));
			} else {
				pages.push(generateFunctionPage(name, binding, m));
			}
		}
	}

	if (m.hooks) {
		for (const [name, hookDef] of Object.entries(m.hooks)) {
			pages.push(generateHookPage(name, hookDef, m));
		}
	}

	if (m.types) {
		for (const [name, def] of Object.entries(m.types)) {
			pages.push(generateTypePage(name, def));
		}
	}

	if (m.slots && m.slots.length > 0) {
		pages.push(generateFragmentAPIPage());
	}

	if (options?.grantShapes) {
		pages.push(generateGrantShapesPage());
	}

	return { pages };
}

export async function generateDocsFromFile(filePath: string, options?: DocgenOptions): Promise<DocgenResult> {
	const absolutePath = resolve(filePath);
	const raw = await readFile(absolutePath, "utf-8");
	const parsed = JSON.parse(raw) as unknown;
	const manifest = await resolveExtends(parsed, dirname(absolutePath));
	return generateDocs(manifest, options);
}

export async function writeDocsToDirectory(result: DocgenResult, outputDir: string, options?: DocgenOptions): Promise<string[]> {
	const absoluteDir = resolve(outputDir);
	await mkdir(absoluteDir, { recursive: true });
	const writtenPaths: string[] = [];

	for (const page of result.pages) {
		const filePath = join(absoluteDir, `${page.slug}.md`);
		const segments = page.slug.split("/");
		if (segments.length > 1) {
			const dir = join(absoluteDir, ...segments.slice(0, -1));
			await mkdir(dir, { recursive: true });
		}
		let content = page.content;
		if (options?.frontmatter) {
			content = `---\n${options.frontmatter}\n---\n\n${content}`;
		}
		await writeFile(filePath, content, "utf-8");
		writtenPaths.push(filePath);
	}

	return writtenPaths;
}
