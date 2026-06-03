import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { resolveExtends } from "@xriptjs/validate";

export { resolveExtends, ManifestResolutionError } from "@xriptjs/validate";

export interface TypegenOptions {
	header?: string;
	includeGrantShapes?: boolean;
	ambient?: boolean;
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

interface ExportDef {
	description: string;
	params?: Parameter[];
	returns?: TypeRef;
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
}

type Binding = FunctionBinding | NamespaceBinding;

interface FunctionBinding {
	description: string;
	params?: Parameter[];
	returns?: TypeRef;
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

function resolveTypeRef(ref: TypeRef): string {
	if (typeof ref === "string") {
		const primitives: Record<string, string> = {
			string: "string",
			number: "number",
			boolean: "boolean",
			void: "void",
			null: "null",
		};

		if (primitives[ref]) return primitives[ref];

		if (ref.endsWith("[]")) {
			const inner = ref.slice(0, -2);
			return `${resolveTypeRef(inner)}[]`;
		}

		return ref;
	}

	if (ref.array !== undefined) {
		return `${resolveTypeRef(ref.array)}[]`;
	}
	if (ref.union) {
		return ref.union.map(resolveTypeRef).join(" | ");
	}
	if (ref.map !== undefined) {
		return `Record<string, ${resolveTypeRef(ref.map)}>`;
	}
	if (ref.optional !== undefined) {
		return `${resolveTypeRef(ref.optional)} | undefined`;
	}

	return "unknown";
}

function isOptionalParam(param: Parameter): boolean {
	return param.default !== undefined || param.required === false;
}

function indent(text: string, level: number): string {
	const prefix = "\t".repeat(level);
	return text
		.split("\n")
		.map((line) => (line.trim() === "" ? "" : `${prefix}${line}`))
		.join("\n");
}

function generateJSDoc(
	description: string,
	extras?: { params?: Parameter[]; capability?: string; deprecated?: string; remarks?: string },
): string {
	const lines: string[] = [];
	lines.push("/**");
	lines.push(` * ${description}`);

	if (extras?.deprecated) {
		lines.push(` * @deprecated ${extras.deprecated}`);
	}
	if (extras?.capability) {
		lines.push(` * @remarks Requires capability: \`${extras.capability}\``);
	}
	if (extras?.remarks) {
		lines.push(` * @remarks ${extras.remarks}`);
	}
	if (extras?.params) {
		for (const param of extras.params) {
			if (param.description) {
				lines.push(` * @param ${param.name} - ${param.description}`);
			}
		}
	}

	lines.push(" */");
	return lines.join("\n");
}

function generateFunction(name: string, binding: FunctionBinding): string {
	const lines: string[] = [];

	lines.push(
		generateJSDoc(binding.description, {
			params: binding.params,
			capability: binding.capability,
			deprecated: binding.deprecated,
		}),
	);

	const params = (binding.params || [])
		.map((p) => {
			const optional = isOptionalParam(p) ? "?" : "";
			return `${p.name}${optional}: ${resolveTypeRef(p.type)}`;
		})
		.join(", ");

	let returnType = binding.returns ? resolveTypeRef(binding.returns) : "void";
	if (binding.async) {
		returnType = `Promise<${returnType}>`;
	}

	lines.push(`declare function ${name}(${params}): ${returnType};`);
	return lines.join("\n");
}

function generateNamespaceFunction(name: string, binding: FunctionBinding): string {
	const lines: string[] = [];

	lines.push(
		generateJSDoc(binding.description, {
			params: binding.params,
			capability: binding.capability,
			deprecated: binding.deprecated,
		}),
	);

	const params = (binding.params || [])
		.map((p) => {
			const optional = isOptionalParam(p) ? "?" : "";
			return `${p.name}${optional}: ${resolveTypeRef(p.type)}`;
		})
		.join(", ");

	let returnType = binding.returns ? resolveTypeRef(binding.returns) : "void";
	if (binding.async) {
		returnType = `Promise<${returnType}>`;
	}

	lines.push(`function ${name}(${params}): ${returnType};`);
	return lines.join("\n");
}

function generateNamespace(name: string, binding: NamespaceBinding): string {
	const lines: string[] = [];

	lines.push(generateJSDoc(binding.description));
	lines.push(`declare namespace ${name} {`);

	const memberEntries = Object.entries(binding.members);
	for (let i = 0; i < memberEntries.length; i++) {
		const [memberName, memberBinding] = memberEntries[i];
		if (isNamespace(memberBinding)) {
			const nested = generateNestedNamespace(memberName, memberBinding);
			lines.push(indent(nested, 1));
		} else {
			const fn = generateNamespaceFunction(memberName, memberBinding);
			lines.push(indent(fn, 1));
		}
		if (i < memberEntries.length - 1) {
			lines.push("");
		}
	}

	lines.push("}");
	return lines.join("\n");
}

function generateNestedNamespace(name: string, binding: NamespaceBinding): string {
	const lines: string[] = [];

	lines.push(generateJSDoc(binding.description));
	lines.push(`namespace ${name} {`);

	const memberEntries = Object.entries(binding.members);
	for (let i = 0; i < memberEntries.length; i++) {
		const [memberName, memberBinding] = memberEntries[i];
		if (isNamespace(memberBinding)) {
			const nested = generateNestedNamespace(memberName, memberBinding);
			lines.push(indent(nested, 1));
		} else {
			const fn = generateNamespaceFunction(memberName, memberBinding);
			lines.push(indent(fn, 1));
		}
		if (i < memberEntries.length - 1) {
			lines.push("");
		}
	}

	lines.push("}");
	return lines.join("\n");
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
			lines.push(indent(`${fieldName}${optional}: ${resolveFieldType(field, types)};`, 1));
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
			lines.push(indent(`get ${fieldName}(): ${valueType};`, 1));
			lines.push(indent(`set ${fieldName}(v: ${valueType});`, 1));
			if (i < fieldEntries.length - 1) lines.push("");
		}
	}

	lines.push("}");
	return lines.join("\n");
}

function generateHandlerType(hookDef: HookDef): string {
	const params = (hookDef.params || [])
		.map((p) => {
			const optional = isOptionalParam(p) ? "?" : "";
			return `${p.name}${optional}: ${resolveTypeRef(p.type)}`;
		})
		.join(", ");
	return `(${params}) => void`;
}

function generateHookFunction(name: string, hookDef: HookDef): string {
	const lines: string[] = [];
	const handlerType = generateHandlerType(hookDef);

	lines.push(
		generateJSDoc(hookDef.description, {
			capability: hookDef.capability,
			deprecated: hookDef.deprecated,
		}),
	);
	lines.push(`function ${name}(handler: ${handlerType}): void;`);
	return lines.join("\n");
}

function generatePhasedHookNamespace(name: string, hookDef: HookDef): string {
	const lines: string[] = [];
	const handlerType = generateHandlerType(hookDef);

	lines.push(
		generateJSDoc(hookDef.description, {
			capability: hookDef.capability,
			deprecated: hookDef.deprecated,
		}),
	);
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

function generateHooksNamespace(hooks: Record<string, HookDef>, slots?: SlotDef[]): string {
	const lines: string[] = [];

	lines.push(generateJSDoc("Hook registration functions."));
	lines.push("declare namespace hooks {");

	const hookEntries = Object.entries(hooks);
	for (let i = 0; i < hookEntries.length; i++) {
		const [hookName, hookDef] = hookEntries[i];
		if (hookDef.phases && hookDef.phases.length > 0) {
			lines.push(indent(generatePhasedHookNamespace(hookName, hookDef), 1));
		} else {
			lines.push(indent(generateHookFunction(hookName, hookDef), 1));
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

function generateFragmentHooksNamespace(): string {
	const lines: string[] = [];

	lines.push(generateJSDoc("Fragment lifecycle hook registration."));
	lines.push("namespace fragment {");

	const lifecycles = ["mount", "unmount", "update", "suspend", "resume"];
	for (let i = 0; i < lifecycles.length; i++) {
		const lc = lifecycles[i];
		const handlerType = lc === "update"
			? "(bindings: Record<string, unknown>, fragment: FragmentProxy) => void"
			: "(fragment: FragmentProxy) => void";
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

	if (m.types) {
		for (const [typeName, typeDef] of Object.entries(m.types)) {
			if (typeDef.values) {
				globalBlocks.push(generateEnumType(typeName, typeDef));
			} else {
				globalBlocks.push(generateObjectType(typeName, typeDef, m.types));
				if (typeDef.fields && Object.keys(typeDef.fields).length > 0) {
					globalBlocks.push(generateAccessorInterface(typeName, typeDef, m.types));
				}
			}
		}
	}

	if (m.bindings) {
		for (const [bindingName, binding] of Object.entries(m.bindings)) {
			if (isNamespace(binding)) {
				globalBlocks.push(stripLeadingDeclare(generateNamespace(bindingName, binding)));
			} else {
				globalBlocks.push(stripLeadingDeclare(generateFunction(bindingName, binding)));
			}
		}
	}

	if (m.hooks && Object.keys(m.hooks).length > 0) {
		globalBlocks.push(stripLeadingDeclare(generateHooksNamespace(m.hooks, m.slots)));
	} else if (m.slots && m.slots.length > 0) {
		globalBlocks.push(stripLeadingDeclare(generateHooksNamespace({}, m.slots)));
	}

	if (m.slots && m.slots.length > 0) {
		globalBlocks.push(generateFragmentAPITypes());
		globalBlocks.push(generateSlotTypes(m.slots));
	}

	if (m.events && m.events.length > 0) {
		globalBlocks.push(generateEventCatalog(m.events));
	}

	globalBlocks.push(generateXriptConst());

	const globalBody = globalBlocks.map((b) => indent(b, 1)).join("\n\n");
	sections.push(`declare global {\n${globalBody}\n}`);

	if (m.fills && Object.keys(m.fills).length > 0) {
		const handlerTypes = generateFragmentHandlerTypes(m.fills);
		if (handlerTypes) sections.push(handlerTypes);
	}

	if (m.entry && typeof m.entry === "object" && !Array.isArray(m.entry) && m.entry.exports) {
		const exportEntries = Object.entries(m.entry.exports);
		if (exportEntries.length > 0) {
			sections.push(generateExportsInterface(m.entry.exports));
		}
	}

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
		for (const [bindingName, binding] of Object.entries(m.bindings)) {
			if (isNamespace(binding)) {
				sections.push(generateNamespace(bindingName, binding));
			} else {
				sections.push(generateFunction(bindingName, binding));
			}
		}
	}

	if (m.hooks && Object.keys(m.hooks).length > 0) {
		sections.push(generateHooksNamespace(m.hooks, m.slots));
	} else if (m.slots && m.slots.length > 0) {
		sections.push(generateHooksNamespace({}, m.slots));
	}

	if (m.slots && m.slots.length > 0) {
		sections.push(generateFragmentAPITypes());
		sections.push(generateSlotTypes(m.slots));
	}

	if (m.events && m.events.length > 0) {
		sections.push(generateEventCatalog(m.events));
	}

	if (m.fills && Object.keys(m.fills).length > 0) {
		const handlerTypes = generateFragmentHandlerTypes(m.fills);
		if (handlerTypes) sections.push(handlerTypes);
	}

	if (m.entry && typeof m.entry === "object" && !Array.isArray(m.entry) && m.entry.exports) {
		const exportEntries = Object.entries(m.entry.exports);
		if (exportEntries.length > 0) {
			sections.push(generateExportsInterface(m.entry.exports));
		}
	}

	if (m.contributions?.provides && m.contributions.provides.length > 0) {
		sections.push(generateProvidedRolesInterface(m.contributions.provides));
	}

	if (options?.includeGrantShapes) {
		sections.push(generateGrantShapeInterfaces());
	}

	return sections.join("\n\n") + "\n";
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

function generateExportsInterface(exports: Record<string, ExportDef>): string {
	const lines: string[] = [];

	lines.push(generateJSDoc("Host-invokable exports declared by this mod. Invoke by name via the runtime."));
	lines.push("interface Exports {");

	const entries = Object.entries(exports);
	for (let i = 0; i < entries.length; i++) {
		const [name, def] = entries[i];
		lines.push(
			indent(
				generateJSDoc(def.description, { params: def.params, capability: def.capability }),
				1,
			),
		);
		const params = (def.params || [])
			.map((p) => {
				const optional = isOptionalParam(p) ? "?" : "";
				return `${p.name}${optional}: ${resolveTypeRef(p.type)}`;
			})
			.join(", ");
		const returnType = def.returns ? resolveTypeRef(def.returns) : "void";
		lines.push(indent(`${name}(${params}): ${returnType};`, 1));
		if (i < entries.length - 1) lines.push("");
	}

	lines.push("}");
	return lines.join("\n");
}

function generateSlotTypes(slots: SlotDef[]): string {
	const lines: string[] = [];

	lines.push(generateJSDoc("A slot id declared by the host application."));
	const union = slots.map((s) => `"${s.id}"`).join(" | ");
	lines.push(`type Slot = ${union};`);
	lines.push("");

	lines.push(generateJSDoc("Available UI slots for fragment contributions."));
	lines.push("interface XriptSlots {");

	for (const slot of slots) {
		const doc = [`Accepts: ${slot.accepts.join(", ")}`];
		if (slot.capability) doc.push(`Requires: \`${slot.capability}\``);
		if (slot.multiple) doc.push("Multiple fragments allowed");
		if (slot.style) doc.push(`Style: ${slot.style}`);
		lines.push(indent(generateJSDoc(doc.join(". ") + "."), 1));
		lines.push(indent(`"${slot.id}": { accepts: ${JSON.stringify(slot.accepts)}; multiple: ${slot.multiple ?? false}; style: "${slot.style ?? "inherit"}" };`, 1));
	}

	lines.push("}");
	return lines.join("\n");
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
		lines.push(indent(generateJSDoc(event.description), 1));
		lines.push(indent(`"${event.id}": ${payload};`, 1));
	}

	lines.push("}");
	lines.push("");

	lines.push(generateJSDoc("An event id the host emits."));
	const union = events.map((e) => `"${e.id}"`).join(" | ");
	lines.push(`type XriptEventId = ${union};`);

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

function generateFragmentAPITypes(): string {
	const lines: string[] = [];

	lines.push(generateJSDoc("Proxy for imperative fragment manipulation. Method calls accumulate a command buffer."));
	lines.push("interface FragmentProxy {");
	lines.push(indent("toggle(selector: string, condition: boolean): void;", 1));
	lines.push(indent("addClass(selector: string, className: string): void;", 1));
	lines.push(indent("removeClass(selector: string, className: string): void;", 1));
	lines.push(indent("setText(selector: string, text: string): void;", 1));
	lines.push(indent("setAttr(selector: string, attr: string, value: string): void;", 1));
	lines.push(indent("replaceChildren(selector: string, html: string | string[]): void;", 1));
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
