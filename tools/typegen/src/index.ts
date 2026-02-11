import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export interface TypegenOptions {
	header?: string;
}

interface HookDef {
	description: string;
	phases?: string[];
	params?: Parameter[];
	capability?: string;
	async?: boolean;
	deprecated?: string;
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
}

interface FieldDefinition {
	type: TypeRef;
	description?: string;
	optional?: boolean;
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
	if (param.default !== undefined) return true;
	if (param.required === false) return true;
	return false;
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

function generateObjectType(name: string, def: TypeDefinition): string {
	const lines: string[] = [];

	lines.push(generateJSDoc(def.description));
	lines.push(`interface ${name} {`);

	if (def.fields) {
		const fieldEntries = Object.entries(def.fields);
		for (const [fieldName, field] of fieldEntries) {
			if (field.description) {
				lines.push(indent(generateJSDoc(field.description), 1));
			}
			const optional = field.optional ? "?" : "";
			lines.push(indent(`${fieldName}${optional}: ${resolveTypeRef(field.type)};`, 1));
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

function generateHooksNamespace(hooks: Record<string, HookDef>): string {
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

	lines.push("}");
	return lines.join("\n");
}

function generateEnumType(name: string, def: TypeDefinition): string {
	const lines: string[] = [];

	lines.push(generateJSDoc(def.description));

	const values = (def.values || []).map((v) => `"${v}"`).join(" | ");
	lines.push(`type ${name} = ${values};`);

	return lines.join("\n");
}

export function generateTypes(manifest: unknown, options?: TypegenOptions): string {
	const m = manifest as Manifest;
	const sections: string[] = [];

	if (options?.header) {
		sections.push(options.header);
	} else {
		const headerLines: string[] = [];
		headerLines.push("// Auto-generated by @xript/typegen");
		headerLines.push(`// Source manifest: ${m.name}${m.version ? ` v${m.version}` : ""}`);
		headerLines.push("// Do not edit manually.");
		sections.push(headerLines.join("\n"));
	}

	if (m.types) {
		for (const [typeName, typeDef] of Object.entries(m.types)) {
			if (typeDef.values) {
				sections.push(generateEnumType(typeName, typeDef));
			} else {
				sections.push(generateObjectType(typeName, typeDef));
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
		sections.push(generateHooksNamespace(m.hooks));
	}

	return sections.join("\n\n") + "\n";
}

export async function generateTypesFromFile(
	filePath: string,
	options?: TypegenOptions,
): Promise<{ content: string; filePath: string }> {
	const absolutePath = resolve(filePath);
	const raw = await readFile(absolutePath, "utf-8");
	const manifest = JSON.parse(raw) as unknown;
	const content = generateTypes(manifest, options);
	return { content, filePath: absolutePath };
}
