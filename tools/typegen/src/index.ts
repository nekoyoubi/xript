import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import {
	HOOK_SLOT_ACCEPT,
	resolveExtends,
	resolveExecutionIntent,
	executionSurfaces,
	isDefaultIntent,
	DURATION_PROSE,
	AFFINITY_PROSE,
	ASYNC_SHAPE_REMARK,
	LIMITS_REACH_REMARK,
	HOST_BINDING_THREAD_CONTRACT,
	resolveFormatProfile,
	FormatProfileError,
	PROTOCOL_PROPS,
	RESERVED_IDENTIFIER_PREFIX,
	typeRefToTypeScript,
	returnTypeRef,
	returnDescription,
	isSafeIdentifier,
	isOptionalParameter,
	parameterIdentifiers,
	parametersToTypeScript,
	type ResolvedExecutionIntent,
	type NodeDefinition,
} from "@xriptjs/validate";
import { describeCapability, generateJSDoc, indent } from "./emit.js";
import { commandSlots, generateCommandCatalog, generateCommandSlotTypes, modCommands, schemaToType } from "./commands.js";

export { resolveExtends, ManifestResolutionError } from "@xriptjs/validate";
export { schemaToType, callArgsType, returnType, modCommands, commandSlots } from "./commands.js";

export interface TypegenOptions {
	header?: string;
	includeGrantShapes?: boolean;
	ambient?: boolean;
	/**
	 * The host manifest a mod manifest fills. Supplying it makes the slot kind of every fill exact
	 * rather than sniffed, which is what lets a mod's command catalog be generated reliably.
	 */
	host?: unknown;
	/**
	 * Emit the execution routing table (`xriptExecution` / `xriptModExecution`) alongside the
	 * types. Implied by `ambient`. Declared intent never changes an emitted TYPE — it is a
	 * routing signal a host consumes, not a compile-time constraint on mods — so this adds a
	 * const map and doc comments and nothing else.
	 */
	intent?: boolean;
}

/**
 * The JSDoc declared intent contributes to a binding, hook, or export: `@duration`/`@affinity`
 * tags when the resolved intent is not the default, plus two unconditional remarks.
 *
 * The async remark rides on EVERY async binding, whether or not it declares intent, because
 * `async` is the thing readers most reliably misread: it declares the shape of the value the
 * host hands the runtime, not the cost of the call, and it does not promise the interpreter
 * yields.
 *
 * The limits remark rides on every `long`/`unbounded` surface, because that is exactly where a
 * reader would otherwise assume a timeout will save them. It will not: once control is inside a
 * host binding, the interpreter is not running and no xript limit is observed.
 */
function intentDoc(manifest: unknown, path: string, isAsync = false): { tags: string[]; remarks: string[] } {
	const resolved: ResolvedExecutionIntent = resolveExecutionIntent(manifest, path);
	const tags: string[] = [];
	const remarks: string[] = [];
	if (!isDefaultIntent(resolved)) {
		tags.push(`@duration ${resolved.duration} - ${DURATION_PROSE[resolved.duration]}`);
		tags.push(`@affinity ${resolved.affinity} - ${AFFINITY_PROSE[resolved.affinity]}`);
	}
	if (isAsync) remarks.push(ASYNC_SHAPE_REMARK);
	if (resolved.duration === "long" || resolved.duration === "unbounded") remarks.push(LIMITS_REACH_REMARK);
	return { tags, remarks };
}

/**
 * The routing table a host consumes instead of re-parsing the manifest, under the
 * host-binding thread contract as a file banner. Keyed by the same surface path
 * `resolveExecutionIntent` takes, so a host reading the table and a tool resolving the manifest
 * name a surface the same way and a binding, hook, and slot of the same name cannot collide.
 */
/**
 * A slot's own enforced deadline, where it declares one. Unlike intent this is not advisory,
 * so it is emitted as a distinct field rather than folded into the routing pair.
 */
function slotBudgetMs(manifest: unknown, surface: { kind: string; name: string }): number | undefined {
	if (surface.kind !== "slot") return undefined;
	const slots = (manifest as { slots?: unknown }).slots;
	if (!Array.isArray(slots)) return undefined;
	const declared = slots.find(
		(slot): slot is { id: string; limits?: { timeout_ms?: number } } =>
			typeof slot === "object" && slot !== null && (slot as { id?: unknown }).id === surface.name,
	);
	return declared?.limits?.timeout_ms;
}

function generateExecutionTable(manifest: unknown, constName: string, kinds: ReadonlyArray<string>): string | undefined {
	const surfaces = executionSurfaces(manifest).filter((surface) => kinds.includes(surface.kind));
	if (surfaces.length === 0) return undefined;

	const lines: string[] = [];
	for (const line of wrapBanner(HOST_BINDING_THREAD_CONTRACT)) lines.push(`// ${line}`);
	lines.push("");
	lines.push(generateJSDoc(
		"Declared execution intent for every surface in this manifest, resolved through the manifest-wide default. Advisory: a host routes on it, nothing enforces it. Absent from a mod's view of the world: this is a host-facing artifact. Where a slot declares its own `limits.timeout_ms`, `timeoutMs` carries it: that one *is* enforced, and it is the budget calls into that slot's fills actually run under.",
	));
	lines.push(`export declare const ${constName}: {`);
	for (const surface of surfaces) {
		const budget = slotBudgetMs(manifest, surface);
		const budgetField = budget === undefined ? "" : `; readonly timeoutMs: ${budget}`;
		lines.push(
			indent(
				`readonly "${surface.path}": { readonly duration: "${surface.resolved.duration}"; readonly affinity: "${surface.resolved.affinity}"${budgetField} };`,
				1,
			),
		);
	}
	lines.push("};");
	return lines.join("\n");
}

function wrapBanner(text: string, width = 96): string[] {
	const out: string[] = [];
	let line = "";
	for (const word of text.split(" ")) {
		if (line.length + word.length + 1 > width) {
			out.push(line);
			line = word;
		} else {
			line = line ? `${line} ${word}` : word;
		}
	}
	if (line) out.push(line);
	return out;
}

interface HookDef {
	description: string;
	phases?: string[];
	params?: Parameter[];
	capability?: string;
	async?: boolean;
	deprecated?: string;
}

interface SlotDef {
	id: string;
	accepts: string[];
	capability?: string;
	multiple?: boolean;
	style?: string;
}

const JS_IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

function effectiveHooks(hooks: Record<string, HookDef> | undefined, slots: SlotDef[] | undefined): Record<string, HookDef> {
	const merged: Record<string, HookDef> = { ...(hooks ?? {}) };
	for (const slot of slots ?? []) {
		if (!slot.accepts?.includes(HOOK_SLOT_ACCEPT) || slot.id in merged) continue;
		merged[slot.id] = { description: (slot as { description?: string }).description ?? "", capability: slot.capability };
	}
	return merged;
}

interface ExportDef {
	description: string;
	params?: Parameter[];
	returns?: TypeRef | { type: TypeRef; description?: string };
	capability?: string;
}

interface EntryBlock {
	script: string;
	format?: string;
	exports?: Record<string, ExportDef>;
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
	id?: string;
	format?: string;
	source?: string;
	handlers?: FragmentHandler[];
	events?: FragmentHandler[];
	bindings?: FragmentBindingDecl[];
	interpolate?: boolean;
}

interface FragmentBindingDecl {
	name?: string;
	path?: string;
	type?: string;
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
	entry?: string | string[] | EntryBlock;
	contributions?: Contributions;
	events?: EventDef[];
	fills?: Record<string, Fill[]>;
	libraries?: Record<string, LibraryDef>;
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
	returns?: TypeRef | { type: TypeRef; description?: string };
	async?: boolean;
	capability?: string;
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
	optional?: boolean;
	variadic?: boolean;
}

type TypeRef = string | ComplexTypeRef;

interface ComplexTypeRef {
	array?: TypeRef;
	union?: TypeRef[];
	map?: TypeRef;
	optional?: TypeRef;
	function?: FunctionSignature;
}

interface FunctionSignature {
	params?: Parameter[];
	returns?: TypeRef;
}

interface Capability {
	description: string;
	risk?: string;
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

interface TypegenManifestContext {
	types?: Record<string, TypeDefinition>;
}

function isNamespace(binding: Binding): binding is NamespaceBinding {
	return "members" in binding;
}

export { isSafeIdentifier };

function resolveTypeRef(ref: TypeRef): string {
	return typeRefToTypeScript(ref);
}

function isOptionalParam(param: Parameter): boolean {
	return isOptionalParameter(param);
}

function renderParams(params: Parameter[] | undefined): string {
	return parametersToTypeScript(params ?? []);
}

function paramDocs(params: Parameter[] | undefined): Array<{ name: string; description?: string }> | undefined {
	if (!params) return undefined;
	const ids = parameterIdentifiers(params);
	return params.map((param, index) => ({ name: ids[index], description: param.description }));
}

function renderReturn(binding: { returns?: unknown; async?: boolean }): string {
	const declared = returnTypeRef(binding.returns);
	const type = declared !== undefined ? resolveTypeRef(declared as TypeRef) : "void";
	return binding.async ? `Promise<${type}>` : type;
}

function functionDoc(binding: FunctionBinding, tags: string[], remarks: string[]): string {
	return generateJSDoc(binding.description, {
		params: paramDocs(binding.params),
		capability: binding.capability,
		deprecated: binding.deprecated,
		returns: returnDescription(binding.returns),
		tags,
		remarks,
	});
}

function generateFunction(name: string, binding: FunctionBinding, manifest?: unknown): string {
	const { tags, remarks } = intentDoc(manifest, `bindings/${name}`, binding.async === true);
	return [functionDoc(binding, tags, remarks), `declare function ${name}(${renderParams(binding.params)}): ${renderReturn(binding)};`]
		.filter(Boolean)
		.join("\n");
}

function generateNamespaceFunction(name: string, binding: FunctionBinding, qualified: string, manifest?: unknown): string {
	const { tags, remarks } = intentDoc(manifest, `bindings/${qualified}`, binding.async === true);
	return [functionDoc(binding, tags, remarks), `function ${name}(${renderParams(binding.params)}): ${renderReturn(binding)};`]
		.filter(Boolean)
		.join("\n");
}

/** True when a namespace and every name beneath it can be emitted as a `namespace` declaration. */
function namespaceIsDeclarable(binding: NamespaceBinding): boolean {
	return Object.entries(binding.members).every(
		([name, member]) => isSafeIdentifier(name) && (!isNamespace(member) || namespaceIsDeclarable(member)),
	);
}

/**
 * A namespace written as an object type literal. Used where a member name cannot be declared as
 * a `function` inside a `namespace` (a reserved word, or a name that is not an identifier): a
 * property key accepts any name, quoted where it has to be.
 */
function namespaceTypeLiteral(binding: NamespaceBinding, qualified: string, manifest?: unknown): string {
	const lines: string[] = ["{"];
	const memberEntries = Object.entries(binding.members);
	for (let i = 0; i < memberEntries.length; i++) {
		const [memberName, member] = memberEntries[i];
		const memberPath = `${qualified}.${memberName}`;
		const key = formatKeyName(memberName);
		if (isNamespace(member)) {
			const doc = generateJSDoc(member.description);
			if (doc) lines.push(indent(doc, 1));
			lines.push(indent(`${key}: ${namespaceTypeLiteral(member, memberPath, manifest)};`, 1));
		} else {
			const { tags, remarks } = intentDoc(manifest, `bindings/${memberPath}`, member.async === true);
			const doc = functionDoc(member, tags, remarks);
			if (doc) lines.push(indent(doc, 1));
			lines.push(indent(`${key}(${renderParams(member.params)}): ${renderReturn(member)};`, 1));
		}
		if (i < memberEntries.length - 1) lines.push("");
	}
	lines.push("}");
	return lines.join("\n");
}

function generateNamespace(name: string, binding: NamespaceBinding, manifest?: unknown): string {
	if (!namespaceIsDeclarable(binding)) {
		return [generateJSDoc(binding.description), `declare const ${name}: ${namespaceTypeLiteral(binding, name, manifest)};`]
			.filter(Boolean)
			.join("\n");
	}

	const lines: string[] = [];

	lines.push(generateJSDoc(binding.description));
	lines.push(`declare namespace ${name} {`);

	const qualifiedPrefix = name;
	const memberEntries = Object.entries(binding.members);
	for (let i = 0; i < memberEntries.length; i++) {
		const [memberName, memberBinding] = memberEntries[i];
		const memberPath = `${qualifiedPrefix}.${memberName}`;
		if (isNamespace(memberBinding)) {
			const nested = generateNestedNamespace(memberName, memberBinding, memberPath, manifest);
			lines.push(indent(nested, 1));
		} else {
			const fn = generateNamespaceFunction(memberName, memberBinding, memberPath, manifest);
			lines.push(indent(fn, 1));
		}
		if (i < memberEntries.length - 1) {
			lines.push("");
		}
	}

	lines.push("}");
	return lines.join("\n");
}

function generateNestedNamespace(name: string, binding: NamespaceBinding, qualified: string, manifest?: unknown): string {
	const lines: string[] = [];

	lines.push(generateJSDoc(binding.description));
	lines.push(`namespace ${name} {`);

	const qualifiedPrefix = qualified;
	const memberEntries = Object.entries(binding.members);
	for (let i = 0; i < memberEntries.length; i++) {
		const [memberName, memberBinding] = memberEntries[i];
		const memberPath = `${qualifiedPrefix}.${memberName}`;
		if (isNamespace(memberBinding)) {
			const nested = generateNestedNamespace(memberName, memberBinding, memberPath, manifest);
			lines.push(indent(nested, 1));
		} else {
			const fn = generateNamespaceFunction(memberName, memberBinding, memberPath, manifest);
			lines.push(indent(fn, 1));
		}
		if (i < memberEntries.length - 1) {
			lines.push("");
		}
	}

	lines.push("}");
	return lines.join("\n");
}

/**
 * Top-level bindings whose names cannot be declared as globals (`delete`, `if`, `my-tool`) are
 * gathered into one interface keyed by name. The sandbox still installs each one as a global, so a
 * script reaches it as `globalThis["delete"]`; this interface is the type of that lookup.
 */
function generateUndeclarableBindings(bindings: Array<[string, Binding]>, manifest?: unknown): string {
	const lines: string[] = [];
	lines.push(
		generateJSDoc(
			"Bindings whose names are not legal TypeScript identifiers, keyed by name. The sandbox installs each one as a global under exactly this name; reach it with bracket access on `globalThis`.",
		),
	);
	lines.push(`interface ${RESERVED_IDENTIFIER_PREFIX}Globals {`);
	for (let i = 0; i < bindings.length; i++) {
		const [name, binding] = bindings[i];
		const key = formatKeyName(name);
		if (isNamespace(binding)) {
			const doc = generateJSDoc(binding.description);
			if (doc) lines.push(indent(doc, 1));
			lines.push(indent(`${key}: ${namespaceTypeLiteral(binding, name, manifest)};`, 1));
		} else {
			const { tags, remarks } = intentDoc(manifest, `bindings/${name}`, binding.async === true);
			const doc = functionDoc(binding, tags, remarks);
			if (doc) lines.push(indent(doc, 1));
			lines.push(indent(`${key}(${renderParams(binding.params)}): ${renderReturn(binding)};`, 1));
		}
		if (i < bindings.length - 1) lines.push("");
	}
	lines.push("}");
	return lines.join("\n");
}

/** Every declaration block the manifest's bindings emit, in manifest order. */
function generateBindingBlocks(bindings: Record<string, Binding>, manifest?: unknown): string[] {
	const blocks: string[] = [];
	const undeclarable: Array<[string, Binding]> = [];
	for (const [bindingName, binding] of Object.entries(bindings)) {
		if (!isSafeIdentifier(bindingName)) {
			undeclarable.push([bindingName, binding]);
			continue;
		}
		blocks.push(isNamespace(binding) ? generateNamespace(bindingName, binding, manifest) : generateFunction(bindingName, binding, manifest));
	}
	if (undeclarable.length > 0) blocks.push(generateUndeclarableBindings(undeclarable, manifest));
	return blocks;
}

function literalForValue(value: unknown): string {
	if (typeof value === "string") return `"${value}"`;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (value === null) return "null";
	return JSON.stringify(value);
}

function resolveFieldType(field: FieldDefinition, types?: Record<string, TypeDefinition>): string {
	if (Array.isArray(field.enum) && field.enum.length > 0) {
		const openSuffix = field.open ? " | (string & {})" : "";
		return field.enum.map(literalForValue).join(" | ") + openSuffix;
	}
	if (typeof field.type === "string" && types) {
		const named = types[field.type];
		if (named && Array.isArray(named.values) && named.values.length > 0) {
			const openSuffix = named.open ? " | (string & {})" : "";
			return named.values.map((v) => `"${v}"`).join(" | ") + openSuffix;
		}
	}
	return resolveTypeRef(field.type);
}

function isFieldOptional(field: FieldDefinition): boolean {
	if (field.default !== undefined) return false;
	return field.optional === true;
}

function generateObjectType(name: string, def: TypeDefinition, types?: Record<string, TypeDefinition>): string {
	const lines: string[] = [];

	lines.push(generateJSDoc(def.description));
	lines.push(`interface ${name} {`);

	if (def.fields) {
		const fieldEntries = Object.entries(def.fields);
		for (const [fieldName, field] of fieldEntries) {
			if (field.description) {
				lines.push(indent(generateJSDoc(field.description), 1));
			}
			const optional = isFieldOptional(field) ? "?" : "";
			lines.push(indent(`${formatKeyName(fieldName)}${optional}: ${resolveFieldType(field, types)};`, 1));
		}
	}

	lines.push("}");
	return lines.join("\n");
}

function generateAccessorInterface(name: string, def: TypeDefinition, types?: Record<string, TypeDefinition>): string {
	const lines: string[] = [];

	lines.push(generateJSDoc(`Typed get/set accessors for the \`${name}\` record shape.`));
	lines.push(`interface ${name}Accessor {`);

	if (def.fields) {
		const fieldEntries = Object.entries(def.fields);
		for (let i = 0; i < fieldEntries.length; i++) {
			const [fieldName, field] = fieldEntries[i];
			const valueType = isFieldOptional(field)
				? `${resolveFieldType(field, types)} | undefined`
				: resolveFieldType(field, types);
			if (field.description) {
				lines.push(indent(generateJSDoc(field.description), 1));
			}
			lines.push(indent(`get ${formatKeyName(fieldName)}(): ${valueType};`, 1));
			lines.push(indent(`set ${formatKeyName(fieldName)}(v: ${valueType});`, 1));
			if (i < fieldEntries.length - 1) lines.push("");
		}
	}

	lines.push("}");
	return lines.join("\n");
}

function generateHandlerType(hookDef: HookDef): string {
	return `(${renderParams(hookDef.params)}) => void`;
}

function hookDoc(name: string, hookDef: HookDef, manifest?: unknown): string {
	const { tags, remarks } = intentDoc(manifest, `hooks/${name}`, hookDef.async === true);
	return generateJSDoc(hookDef.description, {
		capability: hookDef.capability,
		deprecated: hookDef.deprecated,
		tags,
		remarks,
	});
}

function generateHookFunction(name: string, hookDef: HookDef, manifest?: unknown): string {
	return [hookDoc(name, hookDef, manifest), `function ${name}(handler: ${generateHandlerType(hookDef)}): void;`]
		.filter(Boolean)
		.join("\n");
}

function generatePhasedHookNamespace(name: string, hookDef: HookDef, manifest?: unknown): string {
	const lines: string[] = [];
	const handlerType = generateHandlerType(hookDef);

	lines.push(hookDoc(name, hookDef, manifest));
	lines.push(`namespace ${name} {`);

	const phases = hookDef.phases || [];
	for (let i = 0; i < phases.length; i++) {
		lines.push(indent(`function ${phases[i]}(handler: ${handlerType}): void;`, 1));
		if (i < phases.length - 1) {
			lines.push("");
		}
	}

	lines.push("}");
	return lines.join("\n");
}

/** True when every hook and phase name can be declared as a `function` inside `namespace hooks`. */
function hooksAreDeclarable(hooks: Record<string, HookDef>): boolean {
	return Object.entries(hooks).every(
		([name, def]) => isSafeIdentifier(name) && (def.phases ?? []).every((phase) => isSafeIdentifier(phase)),
	);
}

/**
 * The `hooks` global written as an object type literal, for a host whose hook ids include a name
 * a `namespace` cannot declare (`on-save`, `delete`). Every hook keeps its typed handler; one that
 * is not an identifier is reached with bracket access, `hooks["on-save"](handler)`.
 */
function generateHooksTypeLiteral(hooks: Record<string, HookDef>, slots?: SlotDef[], manifest?: unknown): string {
	const lines: string[] = [];
	lines.push(generateJSDoc("Hook registration functions."));
	lines.push("declare const hooks: {");
	const hookEntries = Object.entries(hooks);
	for (let i = 0; i < hookEntries.length; i++) {
		const [hookName, hookDef] = hookEntries[i];
		const doc = hookDoc(hookName, hookDef, manifest);
		if (doc) lines.push(indent(doc, 1));
		const handlerType = generateHandlerType(hookDef);
		if (hookDef.phases && hookDef.phases.length > 0) {
			lines.push(indent(`${formatKeyName(hookName)}: {`, 1));
			for (const phase of hookDef.phases) {
				lines.push(indent(`${formatKeyName(phase)}(handler: ${handlerType}): void;`, 2));
			}
			lines.push(indent("};", 1));
		} else {
			lines.push(indent(`${formatKeyName(hookName)}(handler: ${handlerType}): void;`, 1));
		}
		if (i < hookEntries.length - 1) lines.push("");
	}
	if (slots && slots.length > 0) {
		if (hookEntries.length > 0) lines.push("");
		lines.push(indent(generateJSDoc("Fragment lifecycle hook registration."), 1));
		lines.push(indent("fragment: {", 1));
		for (const [lifecycle, handlerType] of fragmentLifecycles()) {
			lines.push(indent(`${lifecycle}(fragmentId: string, handler: ${handlerType}): void;`, 2));
		}
		lines.push(indent("};", 1));
	}
	lines.push("};");
	return lines.join("\n");
}

function generateHooksNamespace(hooks: Record<string, HookDef>, slots?: SlotDef[], manifest?: unknown): string {
	if (!hooksAreDeclarable(hooks)) return generateHooksTypeLiteral(hooks, slots, manifest);

	const lines: string[] = [];

	lines.push(generateJSDoc("Hook registration functions."));
	lines.push("declare namespace hooks {");

	const hookEntries = Object.entries(hooks);
	for (let i = 0; i < hookEntries.length; i++) {
		const [hookName, hookDef] = hookEntries[i];
		if (hookDef.phases && hookDef.phases.length > 0) {
			lines.push(indent(generatePhasedHookNamespace(hookName, hookDef, manifest), 1));
		} else {
			lines.push(indent(generateHookFunction(hookName, hookDef, manifest), 1));
		}
		if (i < hookEntries.length - 1) {
			lines.push("");
		}
	}

	if (slots && slots.length > 0) {
		if (hookEntries.length > 0) lines.push("");
		lines.push(indent(generateFragmentHooksNamespace(), 1));
	}

	lines.push("}");
	return lines.join("\n");
}

function fragmentLifecycles(): Array<[string, string]> {
	return ["mount", "unmount", "update", "suspend", "resume"].map((lifecycle) => [
		lifecycle,
		lifecycle === "update"
			? `(bindings: Record<string, unknown>, fragment: ${RESERVED_IDENTIFIER_PREFIX}FragmentProxy) => void`
			: `(fragment: ${RESERVED_IDENTIFIER_PREFIX}FragmentProxy) => void`,
	]);
}

function generateFragmentHooksNamespace(): string {
	const lines: string[] = [];

	lines.push(generateJSDoc("Fragment lifecycle hook registration."));
	lines.push("namespace fragment {");

	const lifecycles = ["mount", "unmount", "update", "suspend", "resume"];
	for (let i = 0; i < lifecycles.length; i++) {
		const lc = lifecycles[i];
		const handlerType = lc === "update"
			? `(bindings: Record<string, unknown>, fragment: ${RESERVED_IDENTIFIER_PREFIX}FragmentProxy) => void`
			: `(fragment: ${RESERVED_IDENTIFIER_PREFIX}FragmentProxy) => void`;
		lines.push(indent(`function ${lc}(fragmentId: string, handler: ${handlerType}): void;`, 1));
		if (i < lifecycles.length - 1) lines.push("");
	}

	lines.push("}");
	return lines.join("\n");
}

function generateEnumType(name: string, def: TypeDefinition): string {
	const lines: string[] = [];

	lines.push(generateJSDoc(def.description));

	const values = (def.values || []).map((v) => `"${v}"`).join(" | ");
	const openSuffix = def.open ? " | (string & {})" : "";
	lines.push(`type ${name} = ${values}${openSuffix};`);

	return lines.join("\n");
}

function stripLeadingDeclare(block: string): string {
	return block
		.split("\n")
		.map((line) => line.replace(/^(\s*)declare /, "$1"))
		.join("\n");
}

function generateCapabilityTypes(capabilities: Record<string, Capability>): string {
	const lines: string[] = [];

	const keys = Object.keys(capabilities);
	const scopeUnion = keys.map((k) => `"${k}"`).join(" | ");

	lines.push(
		generateJSDoc(
			`A capability scope declared by the host. Scope-only, with no \`read:\`/\`write:\` mode prefix. Use \`${RESERVED_IDENTIFIER_PREFIX}CapabilityRef\` where a mode-prefixed grant or require string is expected.`,
		),
	);
	lines.push(`type ${RESERVED_IDENTIFIER_PREFIX}Capability = ${scopeUnion};`);
	lines.push("");

	const refMembers = keys
		.flatMap((k) => [`"${k}"`, `"read:${k}"`, `"write:${k}"`])
		.join(" | ");

	lines.push(
		generateJSDoc(
			"A capability reference: a declared scope, optionally carrying a `read:`/`write:` mode prefix. A bare scope means `write:` (the top of the mode lattice). Open to any string so an ancestor scope or host-specific grant still type-checks.",
		),
	);
	lines.push(`type ${RESERVED_IDENTIFIER_PREFIX}CapabilityRef = (${refMembers}) | (string & {});`);

	return lines.join("\n");
}

function generateLibraryModules(libraries: Record<string, LibraryDef>): string {
	const blocks: string[] = [];
	for (const [specifier, def] of Object.entries(libraries)) {
		const docLines: string[] = [];
		if (def.description) docLines.push(def.description);
		if (def.version) docLines.push(`Version: ${def.version}`);
		if (def.capability) docLines.push(`Requires capability: ${def.capability}`);
		if (def.deprecated) docLines.push(`@deprecated ${def.deprecated}`);
		const doc = docLines.length > 0 ? `/**\n${docLines.map((line) => ` * ${line}`).join("\n")}\n */\n` : "";
		blocks.push(`${doc}declare module ${JSON.stringify(specifier)};`);
	}
	return blocks.join("\n\n");
}

function generateXriptConst(): string {
	return [
		generateJSDoc("The in-sandbox xript global. Exposes the imperative export-registration surface."),
		"const xript: {",
		indent("exports: {", 1),
		indent("/** Registers a named callable the host can invoke by name. */", 2),
		indent("register(name: string, fn: (...args: any[]) => unknown): void;", 2),
		indent("};", 1),
		"};",
	].join("\n");
}

export function generateAmbientTypes(manifest: unknown, options?: TypegenOptions): string {
	const m = manifest as Manifest;
	/**
	 * The manifest that describes the *environment* a mod runs inside: the bindings, hooks,
	 * slots, events, types and capabilities the host installs on the sandbox global.
	 *
	 * A mod manifest declares none of those, so generating ambient types from one alone
	 * emitted an environment with no `log`, no `hooks` and no `events` — the whole surface a
	 * mod author writes against — and the file broke the very scaffold that recommended it.
	 * When a host is supplied, the environment comes from the host and only the mod-specific
	 * parts (`fills`, `entry.exports`) come from the mod. With no host this is the manifest
	 * itself, which is the host-manifest case and is unchanged.
	 */
	const env = (options?.host as Manifest | undefined) ?? m;
	const sections: string[] = [];

	if (options?.header) {
		sections.push(options.header);
	} else {
		const headerLines: string[] = [];
		headerLines.push("// Auto-generated by @xriptjs/typegen (ambient mode)");
		headerLines.push(`// Source manifest: ${m.name}${m.version ? ` v${m.version}` : ""}`);
		headerLines.push("// Declares the in-sandbox surface a mod author sees. Do not edit manually.");
		sections.push(headerLines.join("\n"));
	}

	const globalBlocks: string[] = [];

	if (env.types) {
		for (const [typeName, typeDef] of Object.entries(env.types)) {
			if (typeDef.values) {
				globalBlocks.push(generateEnumType(typeName, typeDef));
			} else {
				globalBlocks.push(generateObjectType(typeName, typeDef, env.types));
				if (typeDef.fields && Object.keys(typeDef.fields).length > 0) {
					globalBlocks.push(generateAccessorInterface(typeName, typeDef, env.types));
				}
			}
		}
	}

	if (env.bindings) {
		for (const block of generateBindingBlocks(env.bindings, env)) globalBlocks.push(stripLeadingDeclare(block));
	}

	if (env.hooks && Object.keys(env.hooks).length > 0) {
		globalBlocks.push(stripLeadingDeclare(generateHooksNamespace(effectiveHooks(env.hooks, env.slots), env.slots, env)));
	} else if (env.slots && env.slots.length > 0) {
		globalBlocks.push(stripLeadingDeclare(generateHooksNamespace(effectiveHooks(undefined, env.slots), env.slots, env)));
	}

	if (env.slots && env.slots.length > 0) {
		globalBlocks.push(generateFragmentAPITypes());
		globalBlocks.push(generateSlotTypes(env.slots, env));
		const commandSurface = commandSlots(env.slots);
		if (commandSurface.length > 0) {
			globalBlocks.push(stripLeadingDeclare(generateCommandSlotTypes(commandSurface)));
		}
	}

	const ambientFormatTypes = generateFormatTypes(env);
	if (ambientFormatTypes) globalBlocks.push(ambientFormatTypes);

	if (env.events && env.events.length > 0) {
		globalBlocks.push(generateEventCatalog(env.events));
		globalBlocks.push(generateEventsGlobal());
	}

	if (env.capabilities && !Array.isArray(env.capabilities) && Object.keys(env.capabilities).length > 0) {
		globalBlocks.push(generateCapabilityTypes(env.capabilities));
	}

	globalBlocks.push(generateXriptConst());

	const globalBody = globalBlocks.map((b) => indent(b, 1)).join("\n\n");
	sections.push(`declare global {\n${globalBody}\n}`);

	if (env.libraries && Object.keys(env.libraries).length > 0) {
		sections.push(generateLibraryModules(env.libraries));
	}

	if (m.fills && Object.keys(m.fills).length > 0) {
		const handlerTypes = generateFragmentHandlerTypes(m.fills);
		if (handlerTypes) sections.push(handlerTypes);
		const bindingTypes = generateFragmentBindingTypes(m.fills, m);
		if (bindingTypes) sections.push(bindingTypes);
	}

	if (m.entry && typeof m.entry === "object" && !Array.isArray(m.entry) && m.entry.exports) {
		const exportEntries = Object.entries(m.entry.exports);
		if (exportEntries.length > 0) {
			sections.push(generateExportsInterface(m.entry.exports, m));
		}
	}

	const catalog = generateCommandCatalogFor(m, options);
	if (catalog) sections.push(catalog);

	for (const table of executionTables(m, { ...options, ambient: true })) sections.push(table);

	if (options?.includeGrantShapes) {
		sections.push(generateGrantShapeInterfaces());
	}

	sections.push("export {};");

	return sections.join("\n\n") + "\n";
}

export function generateTypes(manifest: unknown, options?: TypegenOptions): string {
	if (options?.ambient) {
		return generateAmbientTypes(manifest, options);
	}

	const m = manifest as Manifest;
	const sections: string[] = [];

	if (options?.header) {
		sections.push(options.header);
	} else {
		const headerLines: string[] = [];
		headerLines.push("// Auto-generated by @xriptjs/typegen");
		headerLines.push(`// Source manifest: ${m.name}${m.version ? ` v${m.version}` : ""}`);
		headerLines.push("// Do not edit manually.");
		sections.push(headerLines.join("\n"));
	}

	if (m.types) {
		for (const [typeName, typeDef] of Object.entries(m.types)) {
			if (typeDef.values) {
				sections.push(generateEnumType(typeName, typeDef));
			} else {
				sections.push(generateObjectType(typeName, typeDef, m.types));
				if (typeDef.fields && Object.keys(typeDef.fields).length > 0) {
					sections.push(generateAccessorInterface(typeName, typeDef, m.types));
				}
			}
		}
	}

	if (m.bindings) {
		for (const block of generateBindingBlocks(m.bindings, m)) sections.push(block);
	}

	if (m.hooks && Object.keys(m.hooks).length > 0) {
		sections.push(generateHooksNamespace(effectiveHooks(m.hooks, m.slots), m.slots, m));
	} else if (m.slots && m.slots.length > 0) {
		sections.push(generateHooksNamespace(effectiveHooks(undefined, m.slots), m.slots, m));
	}

	if (m.slots && m.slots.length > 0) {
		sections.push(generateFragmentAPITypes());
		sections.push(generateSlotTypes(m.slots, m));
		const commandSurface = commandSlots(m.slots);
		if (commandSurface.length > 0) {
			sections.push(generateCommandSlotTypes(commandSurface));
		}
	}

	const formatTypes = generateFormatTypes(m);
	if (formatTypes) sections.push(formatTypes);

	if (m.events && m.events.length > 0) {
		sections.push(generateEventCatalog(m.events));
		sections.push(generateEventsGlobal(true));
	}

	if (m.capabilities && !Array.isArray(m.capabilities) && Object.keys(m.capabilities).length > 0) {
		sections.push(generateCapabilityTypes(m.capabilities));
	}

	if (m.fills && Object.keys(m.fills).length > 0) {
		const handlerTypes = generateFragmentHandlerTypes(m.fills);
		if (handlerTypes) sections.push(handlerTypes);
		const bindingTypes = generateFragmentBindingTypes(m.fills, m);
		if (bindingTypes) sections.push(bindingTypes);
	}

	if (m.entry && typeof m.entry === "object" && !Array.isArray(m.entry) && m.entry.exports) {
		const exportEntries = Object.entries(m.entry.exports);
		if (exportEntries.length > 0) {
			sections.push(generateExportsInterface(m.entry.exports, m));
		}
	}

	if (m.contributions?.provides && m.contributions.provides.length > 0) {
		sections.push(generateProvidedRolesInterface(m.contributions.provides));
	}

	const catalog = generateCommandCatalogFor(m, options);
	if (catalog) sections.push(catalog);

	for (const table of executionTables(m, options)) sections.push(table);

	if (options?.includeGrantShapes) {
		sections.push(generateGrantShapeInterfaces());
	}

	return sections.join("\n\n") + "\n";
}

/**
 * The routing tables `--intent` emits: the host surfaces a host routes on, and the mod exports
 * a host invokes. A manifest that is both (a host manifest carrying an entry) gets both.
 */
function executionTables(m: Manifest, options?: TypegenOptions): string[] {
	if (!options?.intent && !options?.ambient) return [];
	const tables: string[] = [];
	const host = generateExecutionTable(m, "xriptExecution", ["binding", "hook", "slot"]);
	if (host) tables.push(host);
	const mod = generateExecutionTable(m, "xriptModExecution", ["export"]);
	if (mod) tables.push(mod);
	return tables;
}

/**
 * The mod's command catalog, or undefined when the manifest contributes no commands. The host
 * manifest, when supplied, decides which slots are command slots; without it the fill shape is
 * sniffed, since a mod manifest alone does not carry the slot declarations it fills.
 */
function generateCommandCatalogFor(m: Manifest, options?: TypegenOptions): string | undefined {
	if (!m.fills || Object.keys(m.fills).length === 0) return undefined;
	const hostSlots = options?.host !== undefined ? (options.host as { slots?: unknown }).slots : undefined;
	const commands = modCommands(m.fills, options?.host !== undefined ? (hostSlots ?? []) : undefined);
	if (commands.length === 0) return undefined;
	const exports = m.entry && typeof m.entry === "object" && !Array.isArray(m.entry) ? m.entry.exports : undefined;
	return generateCommandCatalog(commands, (handler) => exports?.[handler]?.capability);
}

function generateProvidedRolesInterface(provides: ProviderRole[]): string {
	const lines: string[] = [];

	lines.push(generateJSDoc("Logical roles this mod provides, keyed by role. Each maps logical method names to concrete fn names; the host invokes them, not xript."));
	lines.push("interface ProvidedRoles {");

	for (let i = 0; i < provides.length; i++) {
		const role = provides[i];
		lines.push(indent(`"${role.role}": Record<string, string>;`, 1));
	}

	lines.push("}");
	return lines.join("\n");
}

function generateGrantShapeInterfaces(): string {
	return [
		generateJSDoc("Host-side payload describing a capability grant request. The runtimes never see this; grant policy and UX are host-side."),
		"interface CapabilityPrompt {",
		indent("capability: string;", 1),
		indent("description: string;", 1),
		indent('risk: "low" | "medium" | "high";', 1),
		indent("mod: { name: string; version: string; title?: string };", 1),
		indent('requestedScope: "one-run" | "session" | "persistent";', 1),
		indent('state: "first-time" | "previously-denied" | "requesting-elevation";', 1),
		indent("reason?: string;", 1),
		"}",
		"",
		generateJSDoc("Host-side descriptor identifying an installable mod. integrity/signature are host-verified; xript never checks them."),
		"interface InstallDescriptor {",
		indent("name: string;", 1),
		indent("version: string;", 1),
		indent("title?: string;", 1),
		indent('source: { type: "file" | "url" | "registry"; location: string };', 1),
		indent("integrity?: string;", 1),
		indent("signature?: string;", 1),
		indent("capabilities?: string[];", 1),
		indent("manifest?: Record<string, unknown>;", 1),
		"}",
		"",
		generateJSDoc("Host-side result of an addon-discovery pass. provides[] holds logical roles shared with mod-manifest contributions.provides."),
		"interface DiscoveryResult {",
		indent("mods: Array<{", 1),
		indent("name: string;", 2),
		indent("version: string;", 2),
		indent("title?: string;", 2),
		indent("location: string;", 2),
		indent("enabled: boolean;", 2),
		indent("capabilities?: string[];", 2),
		indent("provides?: string[];", 2),
		indent("}>;", 1),
		indent("scannedAt?: number;", 1),
		"}",
	].join("\n");
}

function generateExportsInterface(exports: Record<string, ExportDef>, manifest?: unknown): string {
	const lines: string[] = [];

	lines.push(generateJSDoc("Host-invokable exports declared by this mod. Invoke by name via the runtime."));
	lines.push("interface Exports {");

	const entries = Object.entries(exports);
	for (let i = 0; i < entries.length; i++) {
		const [name, def] = entries[i];
		const { tags, remarks } = intentDoc(manifest, `exports/${name}`);
		lines.push(
			indent(
				generateJSDoc(def.description, {
					params: paramDocs(def.params),
					capability: def.capability,
					returns: returnDescription(def.returns),
					tags,
					remarks,
				}),
				1,
			),
		);
		lines.push(indent(`${formatKeyName(name)}(${renderParams(def.params)}): ${renderReturn(def)};`, 1));
		if (i < entries.length - 1) lines.push("");
	}

	lines.push("}");
	return lines.join("\n");
}

function generateSlotTypes(slots: SlotDef[], manifest?: unknown): string {
	const lines: string[] = [];

	lines.push(generateJSDoc("A slot id declared by the host application."));
	const union = slots.map((s) => `"${s.id}"`).join(" | ");
	lines.push(`type ${RESERVED_IDENTIFIER_PREFIX}Slot = ${union};`);
	lines.push("");

	lines.push(generateJSDoc("Available UI slots for fragment contributions."));
	lines.push("interface XriptSlots {");

	for (const slot of slots) {
		const doc = [`Accepts: ${slot.accepts.join(", ")}`];
		if (slot.capability) doc.push(describeCapability(slot.capability));
		if (slot.multiple) doc.push("Multiple fragments allowed");
		if (slot.style) doc.push(`Style: ${slot.style}`);
		const { tags, remarks } = intentDoc(manifest, `slots/${slot.id}`);
		lines.push(indent(generateJSDoc(doc.join(". ") + ".", { tags, remarks }), 1));
		lines.push(indent(`"${slot.id}": { accepts: ${JSON.stringify(slot.accepts)}; multiple: ${slot.multiple ?? false}; style: "${slot.style ?? "inherit"}" };`, 1));
	}

	lines.push("}");
	return lines.join("\n");
}

function formatKeyName(key: string): string {
	return /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key);
}

/**
 * The tuple rest that types a node's children, from its declared constraint. An undeclared
 * constraint defaults to `any`, matching the sanitizer. `nodeTypeOf` maps an allow-listed child
 * name to its node type, or null when the name is not one of this vocabulary's own nodes (an HTML
 * or cross-vocabulary child), in which case the rest widens to the vocabulary union plus text.
 */
function childrenRest(
	children: NodeDefinition["children"],
	unionName: string,
	nodeTypeOf: (name: string) => string | null,
): string {
	const constraint = children ?? "any";
	if (constraint === "none") return "";
	if (constraint === "any") return `, ...(${unionName} | string)[]`;
	if (constraint === "text") return `, ...string[]`;
	if (Array.isArray(constraint)) {
		const allowed = constraint.map(nodeTypeOf).filter((type): type is string => type !== null);
		if (allowed.length === 0) return `, ...(${unionName} | string)[]`;
		return `, ...(${[...new Set(allowed)].join(" | ")})[]`;
	}
	return "";
}

/**
 * Types for each host-declared fragment vocabulary: a props interface and a `[name, props,
 * ...children]` tuple type per node, plus a union over the vocabulary's nodes. A mod authoring a
 * fragment of a declared format types its node tree against the union. Children nest as openly as
 * the node's declared constraint allows — a container declaring `children: "any"` accepts any
 * number of nodes of any type to any depth. The built-in `html` vocabulary is not typed: a format
 * that scopes it in accepts every HTML element, whose shape is not enumerable.
 */
function generateFormatTypes(manifest: unknown): string {
	const formats = (manifest as { formats?: unknown }).formats;
	if (!formats || typeof formats !== "object" || Array.isArray(formats) || Object.keys(formats).length === 0) {
		return "";
	}
	const vocabularies = ((manifest as { vocabularies?: unknown }).vocabularies ?? null) as Parameters<
		typeof resolveFormatProfile
	>[2];

	const collected = new Map<string, { prefix: string; nodes: Record<string, NodeDefinition> }>();
	for (const formatId of Object.keys(formats)) {
		let profile;
		try {
			profile = resolveFormatProfile(
				formatId,
				formats as Parameters<typeof resolveFormatProfile>[1],
				vocabularies,
			);
		} catch (error) {
			if (error instanceof FormatProfileError) continue;
			throw error;
		}
		if (!profile) continue;
		for (const vocab of profile.scope) {
			if (vocab.kind !== "declared") continue;
			if (Object.keys(vocab.nodes).length === 0) continue;
			const key = vocab.id ?? `format:${formatId}`;
			if (!collected.has(key)) collected.set(key, { prefix: "", nodes: vocab.nodes });
		}
	}
	if (collected.size === 0) return "";

	const usedPrefixes = new Set<string>();
	for (const [key, entry] of collected) {
		const base = pascalCaseIdentifier(key.startsWith("format:") ? key.slice("format:".length) : key);
		let prefix = base;
		let disambiguator = 2;
		while (usedPrefixes.has(prefix)) prefix = `${base}${disambiguator++}`;
		usedPrefixes.add(prefix);
		entry.prefix = prefix;
	}

	const blocks: string[] = [];
	for (const { prefix, nodes } of collected.values()) {
		const nodeNames = Object.keys(nodes);
		const unionName = `${prefix}Node`;
		const protocolName = `${prefix}NodeProps`;
		// Two node names can pascal-case to one stem (`my-widget` and `my_widget` both give
		// `MyWidget`), which would emit duplicate type identifiers. Assign a unique stem per node.
		// `Node` is reserved so a node literally named "Node" can't collide its props with the
		// vocabulary's protocol interface.
		const stems = new Map<string, string>();
		const usedStems = new Set<string>(["Node"]);
		for (const name of nodeNames) {
			const base = pascalCaseIdentifier(name);
			let stem = base;
			let disambiguator = 2;
			while (usedStems.has(stem)) stem = `${base}${disambiguator++}`;
			usedStems.add(stem);
			stems.set(name, stem);
		}
		const propsName = (name: string) => `${prefix}${stems.get(name)}Props`;
		const nodeTypeName = (name: string) => `${prefix}${stems.get(name)}Node`;

		const lines: string[] = [];
		lines.push(
			generateJSDoc(
				"Props legal on every node of this vocabulary. `data-bind`, `data-if`, and `data-key` carry XEG; `data-each` carries `item in expr` or `(item, index) in expr`; `id` addresses a node.",
			),
		);
		lines.push(`interface ${protocolName} {`);
		lines.push(indent("id?: string;", 1));
		lines.push(indent('"data-bind"?: string;', 1));
		lines.push(indent('"data-if"?: string;', 1));
		lines.push(indent('"data-each"?: string;', 1));
		lines.push(indent('"data-key"?: string;', 1));
		lines.push("}");

		for (const name of nodeNames) {
			const node = nodes[name];
			lines.push("");
			if (node.description) lines.push(generateJSDoc(node.description));
			lines.push(`interface ${propsName(name)} extends ${protocolName} {`);
			for (const [propKey, propDef] of Object.entries(node.props ?? {})) {
				// Protocol props are always strings the sanitizer enforces regardless of
				// a node's declaration; the protocol interface already types them, so a node redeclaring
				// one must not override the inherited member with an incompatible type.
				if (PROTOCOL_PROPS.has(propKey)) continue;
				lines.push(indent(`${formatKeyName(propKey)}?: ${schemaToType(propDef)};`, 1));
			}
			lines.push("}");
		}

		lines.push("");
		lines.push(
			generateJSDoc(
				`A node in the \`${prefix}\` vocabulary: a \`[name, props, ...children]\` tuple. The props object holds the second position even when it carries only optional props.`,
			),
		);
		lines.push(`type ${unionName} = ${nodeNames.map(nodeTypeName).join(" | ")};`);

		for (const name of nodeNames) {
			const rest = childrenRest(nodes[name].children, unionName, (childName) =>
				nodeNames.includes(childName) ? nodeTypeName(childName) : null,
			);
			lines.push("");
			lines.push(`type ${nodeTypeName(name)} = [${JSON.stringify(name)}, ${propsName(name)}${rest}];`);
		}

		blocks.push(lines.join("\n"));
	}

	return blocks.join("\n\n");
}

function generateEventCatalog(events: EventDef[]): string {
	const lines: string[] = [];

	lines.push(
		generateJSDoc(
			"Catalog of the named events this host emits, mapping event id to payload type. A discovery declaration of what the host broadcasts; consumers (sandbox scripts, host UI, external subscribers) are not presupposed. Distinct from slots and fragment handlers: bindings are what you can call, slots and handlers are what handles, events are what the host emits.",
		),
	);
	lines.push("interface XriptEvents {");

	for (const event of events) {
		const payload = event.payload !== undefined ? resolveTypeRef(event.payload) : "void";
		lines.push(indent(generateJSDoc(event.description, { capability: event.capability }), 1));
		lines.push(indent(`"${event.id}": ${payload};`, 1));
	}

	lines.push("}");
	lines.push("");

	lines.push(generateJSDoc("An event id the host emits."));
	const union = events.map((e) => `"${e.id}"`).join(" | ");
	lines.push(`type XriptEventId = ${union};`);

	return lines.join("\n");
}

function generateEventsGlobal(declare = false): string {
	const lines: string[] = [];

	lines.push(
		generateJSDoc(
			"The in-sandbox `events` global. A mod subscribes to the host's broadcast catalog by event id; the handler receives that event's declared payload. Subscribing to a capability-gated event without the grant throws a `CapabilityDeniedError` at registration time.",
		),
	);
	lines.push(`${declare ? "declare " : ""}namespace events {`);
	lines.push(
		indent(
			generateJSDoc("Subscribes a handler to a declared host event. The payload type is inferred from the event id."),
			1,
		),
	);
	lines.push(indent("function on<K extends XriptEventId>(id: K, handler: (payload: XriptEvents[K]) => void): void;", 1));
	lines.push("");
	lines.push(indent(generateJSDoc("Alias of `events.on`."), 1));
	lines.push(indent("function subscribe<K extends XriptEventId>(id: K, handler: (payload: XriptEvents[K]) => void): void;", 1));
	lines.push("}");

	return lines.join("\n");
}

function resolveFillHandlers(fill: Fill): { handlers: FragmentHandler[]; usingAlias: boolean } | undefined {
	if (fill.handlers && fill.handlers.length > 0) {
		return { handlers: fill.handlers, usingAlias: false };
	}
	if (fill.events && fill.events.length > 0) {
		return { handlers: fill.events, usingAlias: true };
	}
	return undefined;
}

function generateFragmentHandlerTypes(fills: Record<string, Fill[]>): string | undefined {
	const lines: string[] = [];

	lines.push(
		generateJSDoc(
			"DOM event handlers wired onto fragment fills, keyed by host slot id. Each entry names a sandbox handler bound to an event on elements matching a CSS selector within the rendered fragment.",
		),
	);
	lines.push("interface FragmentHandlers {");

	let emitted = false;
	for (const [slotId, slotFills] of Object.entries(fills)) {
		for (const fill of slotFills) {
			const resolved = resolveFillHandlers(fill);
			if (!resolved) continue;
			emitted = true;
			const key = fill.id ? `${slotId}::${fill.id}` : slotId;
			const remarks = resolved.usingAlias
				? "Declared under the deprecated `events` key. Rename it to `handlers`; if both are present, `handlers` wins."
				: undefined;
			lines.push(indent(generateJSDoc(`Handlers wired onto the \`${slotId}\` fill.`, { remarks }), 1));
			const entries = resolved.handlers
				.map((h) => `{ selector: "${h.selector}"; on: "${h.on}"; handler: "${h.handler}" }`)
				.join(", ");
			lines.push(indent(`"${key}": [${entries}];`, 1));
		}
	}

	if (!emitted) return undefined;

	lines.push("}");
	return lines.join("\n");
}

/**
 * Emits, per fragment fill, the binding surface its expressions read.
 *
 * TypeScript cannot type-check a string embedded in markup, and faking it with
 * template-literal type gymnastics would produce error messages no author could read. So
 * the work splits: these types give an editor something to complete against inside
 * `{{ … }}`, `data-if`, `data-bind`, `data-each`, and `data-key`, and the `expressions` analyzer in
 * `@xriptjs/validate` does the actual checking over the same AST the runtimes walk.
 */
function generateFragmentBindingTypes(
	fills: Record<string, Fill[]>,
	manifest: Manifest,
): string | undefined {
	const blocks: string[] = [];

	for (const [slotId, slotFills] of Object.entries(fills)) {
		for (const fill of slotFills) {
			const bindings = fill.bindings?.filter((binding) => typeof binding.name === "string") ?? [];
			if (bindings.length === 0) continue;

			const base = pascalCaseIdentifier(fill.id ?? slotId);
			const lines: string[] = [];
			lines.push(
				generateJSDoc(
					`Bindings the \`${slotId}\` fill declares. Every identifier an expression in this fill names must appear here.`,
					fill.interpolate
						? { remarks: "This fill parses `{{ expression }}` sites in its text nodes." }
						: undefined,
				),
			);
			lines.push(`interface ${base}Bindings {`);
			for (const binding of bindings) {
				const doc = binding.path ? generateJSDoc(`Resolved from \`${binding.path}\`.`) : undefined;
				if (doc) lines.push(indent(doc, 1));
				lines.push(indent(`${binding.name}: ${bindingValueType(binding, manifest)};`, 1));
			}
			lines.push("}");
			lines.push("");
			lines.push(
				generateJSDoc(
					`Every binding name valid inside a \`data-bind\`, \`data-if\`, \`data-each\`, \`data-key\`, or interpolation site on the \`${slotId}\` fill. A \`data-each\` template adds its item and index names, and \`$index\`, inside its own subtree.`,
				),
			);
			lines.push(`type ${base}Binding = keyof ${base}Bindings;`);
			blocks.push(lines.join("\n"));
		}
	}

	if (blocks.length === 0) return undefined;

	const body = blocks.map((block) => indent(block, 1)).join("\n\n");
	return [
		generateJSDoc(
			"Per-fill binding surfaces for fragment expressions. Names here are what an editor completes inside `{{ … }}`, `data-if`, `data-bind`, `data-each`, and `data-key`.",
		),
		`declare namespace XriptFragments {\n${body}\n}`,
	].join("\n");
}

/**
 * A binding's value type, taken from the host manifest's `types` when the declaration names
 * one and `unknown` otherwise. Guessing from the data path would be worse than admitting
 * the type is not knowable: a wrong type produces a confident, wrong error.
 */
function bindingValueType(binding: FragmentBindingDecl, manifest: Manifest): string {
	if (!binding.type) return "unknown";
	if (manifest.types && Object.prototype.hasOwnProperty.call(manifest.types, binding.type)) {
		return binding.type;
	}
	return mapPrimitiveType(binding.type);
}

function mapPrimitiveType(name: string): string {
	switch (name) {
		case "int":
		case "float":
		case "number": return "number";
		case "string": return "string";
		case "bool":
		case "boolean": return "boolean";
		case "array": return "unknown[]";
		case "object": return "Record<string, unknown>";
		default: return "unknown";
	}
}

function pascalCaseIdentifier(value: string): string {
	const parts = value.split(/[^A-Za-z0-9]+/).filter(Boolean);
	const joined = parts.map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("");
	return /^[A-Za-z]/.test(joined) ? joined : `Fill${joined}`;
}

function generateFragmentAPITypes(): string {
	const lines: string[] = [];

	lines.push(generateJSDoc("Proxy for imperative fragment manipulation. Method calls accumulate a command buffer."));
	lines.push(`interface ${RESERVED_IDENTIFIER_PREFIX}FragmentProxy {`);
	lines.push(indent("/** Show matching nodes when `condition` is true, hide them when false. A set, not a flip: repeating it with the same condition changes nothing. */", 1));
	lines.push(indent("toggle(selector: string, condition: boolean): void;", 1));
	lines.push(indent("addClass(selector: string, className: string): void;", 1));
	lines.push(indent("removeClass(selector: string, className: string): void;", 1));
	lines.push(indent("setText(selector: string, text: string): void;", 1));
	lines.push(indent("/** Set a prop on matching nodes; the value keeps its type. On an HTML attribute, `false` or `null` removes it. */", 1));
	lines.push(indent("setProp(selector: string, prop: string, value: unknown): void;", 1));
	lines.push(indent("/** @deprecated Alias of `setProp` kept under its own op name. `false` or `null` removes the attribute; an object or array is refused. */", 1));
	lines.push(indent("setAttr(selector: string, attr: string, value: string | number | boolean | null): void;", 1));
	lines.push(indent("/** Remove an attribute from matching nodes. The inverse of `setAttr`. */", 1));
	lines.push(indent("removeAttr(selector: string, attr: string): void;", 1));
	lines.push(indent("/** Replace the children of matching nodes with markup, a list of markup strings, or a J5ML node list. An empty list clears. */", 1));
	lines.push(indent("replaceChildren(selector: string, content: string | readonly (string | readonly unknown[])[]): void;", 1));
	lines.push("}");

	return lines.join("\n");
}

export async function generateTypesFromFile(
	filePath: string,
	options?: TypegenOptions,
): Promise<{ content: string; filePath: string }> {
	const absolutePath = resolve(filePath);
	const raw = await readFile(absolutePath, "utf-8");
	const parsed = JSON.parse(raw) as unknown;
	const manifest = await resolveExtends(parsed, dirname(absolutePath));
	const content = generateTypes(manifest, options);
	return { content, filePath: absolutePath };
}
