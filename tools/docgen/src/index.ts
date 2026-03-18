import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";

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

interface Example {
	title?: string;
	code: string;
	description?: string;
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

function formatTypeRef(ref: TypeRef): string {
	if (typeof ref === "string") {
		const primitives = ["string", "number", "boolean", "void", "null"];
		if (primitives.includes(ref)) return `\`${ref}\``;
		if (ref.endsWith("[]")) return `\`${ref.slice(0, -2)}\`[]`;
		return `\`${ref}\``;
	}
	if (ref.array !== undefined) return `${formatTypeRef(ref.array)}[]`;
	if (ref.union) return ref.union.map(formatTypeRef).join(" \\| ");
	if (ref.map !== undefined) return `Record<string, ${formatTypeRef(ref.map)}>`;
	if (ref.optional !== undefined) return `${formatTypeRef(ref.optional)} \\| undefined`;
	return "`unknown`";
}

function typeRefToCode(ref: TypeRef): string {
	if (typeof ref === "string") {
		if (ref.endsWith("[]")) return `${ref.slice(0, -2)}[]`;
		return ref;
	}
	if (ref.array !== undefined) return `${typeRefToCode(ref.array)}[]`;
	if (ref.union) return ref.union.map(typeRefToCode).join(" | ");
	if (ref.map !== undefined) return `Record<string, ${typeRefToCode(ref.map)}>`;
	if (ref.optional !== undefined) return `${typeRefToCode(ref.optional)} | undefined`;
	return "unknown";
}

function isOptionalParam(param: Parameter): boolean {
	return param.default !== undefined || param.required === false;
}

function generateIndexPage(manifest: Manifest): DocPage {
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
				lines.push(`- [\`${name}()\`](./bindings/${name}.md) — ${binding.description}`);
			}
			lines.push("");
		}

		if (namespaces.length > 0) {
			lines.push("### Namespaces");
			lines.push("");
			for (const name of namespaces) {
				const binding = manifest.bindings[name] as NamespaceBinding;
				const memberCount = Object.keys(binding.members).length;
				lines.push(
					`- [\`${name}\`](./bindings/${name}.md) — ${binding.description} (${memberCount} ${memberCount === 1 ? "function" : "functions"})`,
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
			lines.push(`- [\`${name}\`](./hooks/${name}.md) — ${hook.description}${phaseInfo}`);
		}
		lines.push("");
	}

	if (manifest.types) {
		lines.push("## Types");
		lines.push("");
		for (const [name, def] of Object.entries(manifest.types)) {
			const kind = def.values ? "enum" : "interface";
			lines.push(`- [\`${name}\`](./types/${name}.md) — ${def.description} *(${kind})*`);
		}
		lines.push("");
	}

	if (manifest.slots && manifest.slots.length > 0) {
		lines.push("## UI Slots");
		lines.push("");
		lines.push("Available mounting points for mod UI fragments.");
		lines.push("");
		lines.push("| Slot | Accepts | Multiple | Style | Capability |");
		lines.push("|------|---------|----------|-------|------------|");
		for (const slot of manifest.slots) {
			const accepts = slot.accepts.join(", ");
			const multiple = slot.multiple ? "Yes" : "No";
			const style = slot.style || "inherit";
			const cap = slot.capability ? `\`${slot.capability}\`` : "—";
			lines.push(`| \`${slot.id}\` | ${accepts} | ${multiple} | ${style} | ${cap} |`);
		}
		lines.push("");
		lines.push("See [Fragment API](./fragment-api.md) for the sandbox fragment manipulation API.");
		lines.push("");
	}

	if (manifest.capabilities) {
		lines.push("## Capabilities");
		lines.push("");
		lines.push("| Capability | Description | Risk |");
		lines.push("|------------|-------------|------|");
		for (const [name, cap] of Object.entries(manifest.capabilities)) {
			const risk = cap.risk || "low";
			lines.push(`| \`${name}\` | ${cap.description} | ${risk} |`);
		}
		lines.push("");
	}

	return { slug: "index", title: `${displayName} API Reference`, content: lines.join("\n") };
}

function generateFunctionPage(name: string, binding: FunctionBinding): DocPage {
	const lines: string[] = [];

	lines.push(`# ${name}()`);
	lines.push("");
	if (binding.deprecated) {
		lines.push(`> **Deprecated:** ${binding.deprecated}`);
		lines.push("");
	}
	lines.push(binding.description);
	lines.push("");

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

	if (params.length > 0) {
		lines.push("## Parameters");
		lines.push("");
		lines.push("| Name | Type | Required | Description |");
		lines.push("|------|------|----------|-------------|");
		for (const p of params) {
			const req = isOptionalParam(p) ? "No" : "Yes";
			const desc = p.description || "";
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
		lines.push(`This function requires the \`${binding.capability}\` capability.`);
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

function generateNamespacePage(name: string, binding: NamespaceBinding, manifest: Manifest): DocPage {
	const lines: string[] = [];

	lines.push(`# ${name}`);
	lines.push("");
	lines.push(binding.description);
	lines.push("");

	lines.push("## Functions");
	lines.push("");

	for (const [memberName, memberBinding] of Object.entries(binding.members)) {
		if (isNamespace(memberBinding)) continue;
		const fn = memberBinding as FunctionBinding;
		const params = fn.params || [];
		const paramStr = params
			.map((p) => {
				const opt = isOptionalParam(p) ? "?" : "";
				return `${p.name}${opt}: ${typeRefToCode(p.type)}`;
			})
			.join(", ");
		let returnType = fn.returns ? typeRefToCode(fn.returns) : "void";
		if (fn.async) returnType = `Promise<${returnType}>`;

		lines.push(`### ${name}.${memberName}()`);
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

		if (params.length > 0) {
			lines.push("**Parameters:**");
			lines.push("");
			lines.push("| Name | Type | Required | Description |");
			lines.push("|------|------|----------|-------------|");
			for (const p of params) {
				const req = isOptionalParam(p) ? "No" : "Yes";
				const desc = p.description || "";
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
			lines.push(`**Requires capability:** \`${fn.capability}\``);
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
		lines.push("## TypeScript");
		lines.push("");
		lines.push("```typescript");
		lines.push(`type ${name} = ${def.values.map((v) => `"${v}"`).join(" | ")};`);
		lines.push("```");
		lines.push("");
	} else if (def.fields) {
		lines.push("## Fields");
		lines.push("");
		lines.push("| Field | Type | Required | Description |");
		lines.push("|-------|------|----------|-------------|");
		for (const [fieldName, field] of Object.entries(def.fields)) {
			const req = field.optional ? "No" : "Yes";
			const desc = field.description || "";
			lines.push(`| \`${fieldName}\` | ${formatTypeRef(field.type)} | ${req} | ${desc} |`);
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

function generateHookPage(name: string, hookDef: HookDef): DocPage {
	const lines: string[] = [];

	lines.push(`# ${name}`);
	lines.push("");
	if (hookDef.deprecated) {
		lines.push(`> **Deprecated:** ${hookDef.deprecated}`);
		lines.push("");
	}
	lines.push(hookDef.description);
	lines.push("");

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
			const desc = p.description || "";
			const defaultNote =
				p.default !== undefined ? ` (default: \`${JSON.stringify(p.default)}\`)` : "";
			lines.push(`| \`${p.name}\` | ${formatTypeRef(p.type)} | ${req} | ${desc}${defaultNote} |`);
		}
		lines.push("");
	}

	if (hookDef.capability) {
		lines.push("## Requires Capability");
		lines.push("");
		lines.push(`This hook requires the \`${hookDef.capability}\` capability.`);
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
	lines.push("| `setAttr(selector, attr, value)` | CSS selector, string, string | Set attribute on matching elements |");
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

export function generateDocs(manifest: unknown): DocgenResult {
	const m = manifest as Manifest;
	const pages: DocPage[] = [];

	pages.push(generateIndexPage(m));

	if (m.bindings) {
		for (const [name, binding] of Object.entries(m.bindings)) {
			if (isNamespace(binding)) {
				pages.push(generateNamespacePage(name, binding, m));
			} else {
				pages.push(generateFunctionPage(name, binding));
			}
		}
	}

	if (m.hooks) {
		for (const [name, hookDef] of Object.entries(m.hooks)) {
			pages.push(generateHookPage(name, hookDef));
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

	return { pages };
}

export async function generateDocsFromFile(filePath: string): Promise<DocgenResult> {
	const absolutePath = resolve(filePath);
	const raw = await readFile(absolutePath, "utf-8");
	const manifest = JSON.parse(raw) as unknown;
	return generateDocs(manifest);
}

export async function writeDocsToDirectory(result: DocgenResult, outputDir: string): Promise<string[]> {
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
		await writeFile(filePath, page.content, "utf-8");
		writtenPaths.push(filePath);
	}

	return writtenPaths;
}
