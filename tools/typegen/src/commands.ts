/**
 * TypeScript generation for the `application/x-xript-command` slot kind.
 *
 * Two surfaces, from two different manifests. A host manifest yields the slot contracts it
 * declares plus the handler type a command must satisfy; a mod manifest yields a catalog of the
 * commands it contributes, each typed from its own `input`/`output` with bound keys relaxed.
 */

import { COMMAND_ID_PATTERN, isCommandSlot, type CommandSlotDeclaration } from "@xriptjs/validate";
import { generateJSDoc, indent } from "./emit.js";

export interface CommandSlotDef extends CommandSlotDeclaration {
	id: string;
	description?: string;
}

export interface CommandFillDef {
	id?: unknown;
	handler?: unknown;
	title?: unknown;
	description?: unknown;
	args?: unknown;
	input?: unknown;
	output?: unknown;
	capability?: unknown;
	format?: unknown;
	source?: unknown;
	fns?: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/* ------------------------------------------------------------------ *
 * JSON Schema → TypeScript
 * ------------------------------------------------------------------ */

/**
 * Maps a JSON Schema (draft 2020-12) to a TypeScript type expression. Deliberately partial: a
 * construct it cannot express becomes `unknown`, never `any`, so a generated type never claims
 * more than the schema states.
 */
export function schemaToType(schema: unknown): string {
	if (schema === true || schema === undefined) return "unknown";
	if (schema === false) return "never";
	if (!isPlainObject(schema)) return "unknown";

	if ("const" in schema) return literal(schema.const);
	if (Array.isArray(schema.enum) && schema.enum.length > 0) {
		return schema.enum.map(literal).join(" | ");
	}
	if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) return union(schema.oneOf);
	if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) return union(schema.anyOf);
	if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
		return schema.allOf.map(schemaToType).join(" & ");
	}

	const type = schema.type;
	if (Array.isArray(type)) {
		return type.map((t) => schemaToType({ ...schema, type: t })).join(" | ");
	}

	if (type === "array" || (type === undefined && "items" in schema)) {
		const items = schemaToType(schema.items);
		return items.includes(" ") ? `Array<${items}>` : `${items}[]`;
	}
	if (type === "object" || (type === undefined && ("properties" in schema || "required" in schema))) {
		return objectType(schema);
	}
	if (type === "string") return "string";
	if (type === "number" || type === "integer") return "number";
	if (type === "boolean") return "boolean";
	if (type === "null") return "null";
	return "unknown";
}

function union(schemas: unknown[]): string {
	const parts = [...new Set(schemas.map(schemaToType))];
	return parts.join(" | ");
}

function literal(value: unknown): string {
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (value === null) return "null";
	return "unknown";
}

function propertyKey(name: string): string {
	return /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name);
}

function objectType(schema: Record<string, unknown>, relaxed: ReadonlySet<string> = new Set()): string {
	const properties = isPlainObject(schema.properties) ? schema.properties : {};
	const names = Object.keys(properties);
	if (names.length === 0) return "Record<string, unknown>";
	const required = new Set(
		(Array.isArray(schema.required) ? schema.required : []).filter((name): name is string => typeof name === "string"),
	);
	const members = names.map((name) => {
		const optional = !required.has(name) || relaxed.has(name) ? "?" : "";
		return `${propertyKey(name)}${optional}: ${schemaToType(properties[name])}`;
	});
	return `{ ${members.join("; ")} }`;
}

/* ------------------------------------------------------------------ *
 * Fill classification
 * ------------------------------------------------------------------ */

/**
 * Whether a fill on a slot the generator cannot see reads as a command. Used only when no host
 * manifest is supplied: a command fill names both an `id` and a `handler`, which distinguishes it
 * from a hook fill (handler, no id), a role fill (`fns`), and a fragment fill (`format`+`source`).
 */
export function looksLikeCommandFill(fill: unknown): boolean {
	if (!isPlainObject(fill)) return false;
	if (typeof fill.format === "string" && typeof fill.source === "string") return false;
	if (isPlainObject(fill.fns)) return false;
	if (typeof fill.handler !== "string" || fill.handler.length === 0) return false;
	return typeof fill.id === "string" && COMMAND_ID_PATTERN.test(fill.id);
}

/** The host's command slots, in declaration order. */
export function commandSlots(slots: unknown): CommandSlotDef[] {
	if (!Array.isArray(slots)) return [];
	return slots.filter((slot): slot is CommandSlotDef => isCommandSlot(slot) && typeof (slot as CommandSlotDef).id === "string");
}

export interface ModCommand {
	slot: string;
	id: string;
	handler: string;
	title?: string;
	description?: string;
	args: Record<string, unknown>;
	input?: unknown;
	output?: unknown;
}

/**
 * The commands a mod contributes. When `hostSlots` is supplied the slot kind is read from the
 * host declaration, which is authoritative; without it the fill shape is sniffed, since a mod
 * manifest alone does not say what kind of slot it is filling.
 */
export function modCommands(fills: unknown, hostSlots?: unknown): ModCommand[] {
	if (!isPlainObject(fills)) return [];
	const declared = hostSlots === undefined ? null : new Set(commandSlots(hostSlots).map((slot) => slot.id));
	const commands: ModCommand[] = [];
	for (const [slotId, entries] of Object.entries(fills)) {
		if (declared && !declared.has(slotId)) continue;
		const list = Array.isArray(entries) ? entries : [entries];
		const seen = new Set<string>();
		for (const entry of list) {
			if (!looksLikeCommandFill(entry)) continue;
			const fill = entry as Record<string, unknown>;
			if ("capability" in fill) continue;
			const id = fill.id as string;
			if (seen.has(id)) continue;
			seen.add(id);
			commands.push({
				slot: slotId,
				id,
				handler: fill.handler as string,
				...(typeof fill.title === "string" ? { title: fill.title } : {}),
				...(typeof fill.description === "string" ? { description: fill.description } : {}),
				args: isPlainObject(fill.args) ? fill.args : {},
				...(fill.input !== undefined ? { input: fill.input } : {}),
				...(fill.output !== undefined ? { output: fill.output } : {}),
			});
		}
	}
	return commands;
}

/* ------------------------------------------------------------------ *
 * Signatures
 * ------------------------------------------------------------------ */

function inferredType(value: unknown): string {
	if (typeof value === "string") return "string";
	if (typeof value === "number") return "number";
	if (typeof value === "boolean") return "boolean";
	if (value === null) return "null";
	if (Array.isArray(value)) return "unknown[]";
	return "Record<string, unknown>";
}

/**
 * The call-time parameter of a command. `input` describes the EFFECTIVE argument object — bound
 * keys included — so a key the fill already binds is relaxed to optional here, and a command whose
 * every required key is bound takes no argument at all.
 */
export function callArgsType(command: ModCommand): { type: string; optional: boolean } {
	const bound = new Set(Object.keys(command.args));

	if (isPlainObject(command.input)) {
		const properties = isPlainObject(command.input.properties) ? command.input.properties : {};
		if (Object.keys(properties).length === 0) return { type: "Record<string, unknown>", optional: true };
		const required = (Array.isArray(command.input.required) ? command.input.required : []).filter(
			(name): name is string => typeof name === "string",
		);
		const outstanding = required.filter((name) => !bound.has(name));
		return { type: objectType(command.input, bound), optional: outstanding.length === 0 };
	}

	if (bound.size > 0) {
		const members = Object.entries(command.args).map(([key, value]) => `${propertyKey(key)}?: ${inferredType(value)}`);
		return { type: `{ ${members.join("; ")} }`, optional: true };
	}

	return { type: "Record<string, unknown>", optional: true };
}

export function returnType(command: ModCommand): string {
	return command.output === undefined ? "unknown" : schemaToType(command.output);
}

/* ------------------------------------------------------------------ *
 * Emission
 * ------------------------------------------------------------------ */

function pascalCase(id: string): string {
	const parts = id.split(/[^A-Za-z0-9]+/).filter(Boolean);
	const name = parts.map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("");
	return /^[A-Za-z]/.test(name) ? name : `Slot${name}`;
}

/**
 * The host's command surface: one interface per command slot carrying the contract a host reads
 * off the declaration, the union of command slot ids, and the handler type every command's export
 * must satisfy. Generated from the slot declaration alone — a host does not know its mods.
 */
export function generateCommandSlotTypes(slots: CommandSlotDef[]): string {
	const lines: string[] = [];
	const taken = new Set<string>();

	lines.push(
		generateJSDoc(
			"Command slots declared by the host. A command is a fill of a slot whose `accepts` names `application/x-xript-command`: a named, invocable action backed by a mod export.",
		),
	);
	lines.push("declare namespace xript {");
	lines.push(indent(generateJSDoc("The contract of each command slot, read off the host declaration."), 1));
	lines.push(indent("namespace commandSlots {", 1));

	for (let i = 0; i < slots.length; i++) {
		const slot = slots[i];
		let name = pascalCase(slot.id);
		let suffix = 2;
		while (taken.has(name)) name = `${pascalCase(slot.id)}${suffix++}`;
		taken.add(name);

		const doc = slot.description ? slot.description : `The \`${slot.id}\` command slot.`;
		lines.push(indent(generateJSDoc(doc, slot.capability ? { capability: slot.capability } : undefined), 2));
		lines.push(indent(`interface ${name} {`, 2));
		lines.push(indent(`readonly slot: ${JSON.stringify(slot.id)};`, 3));
		lines.push(indent(`readonly capability: ${slot.capability ? JSON.stringify(slot.capability) : "undefined"};`, 3));
		lines.push(indent(`readonly multiple: ${slot.multiple === true};`, 3));
		if (slot.payload && typeof slot.payload === "object") {
			lines.push(indent(`readonly fill: ${objectType(slot.payload as Record<string, unknown>)};`, 3));
		}
		lines.push(indent("}", 2));
		if (i < slots.length - 1) lines.push("");
	}

	lines.push(indent("}", 1));
	lines.push("");
	lines.push(indent(generateJSDoc("A command slot id declared by the host."), 1));
	lines.push(indent(`type CommandSlotId = ${slots.map((slot) => JSON.stringify(slot.id)).join(" | ")};`, 1));
	lines.push("}");
	lines.push("");
	lines.push(
		generateJSDoc(
			"The shape of a mod export a command names in its `handler`. The handler receives exactly one argument: the effective object, the fill's bound `args` under the caller's.",
		),
	);
	lines.push("declare type XriptCommandHandler<A = Record<string, unknown>, R = unknown> = (args: A) => R | Promise<R>;");

	return lines.join("\n");
}

/**
 * The mod's command catalog: one call signature per contributed command, keyed by command id.
 * Non-identifier ids are quoted, so they read through bracket access.
 */
export function generateCommandCatalog(
	commands: ModCommand[],
	exportCapabilityOf: (handler: string) => string | undefined,
): string {
	const lines: string[] = [];

	lines.push(
		generateJSDoc(
			"Commands this mod contributes, keyed by command id. Each signature is the call-time one: keys the fill binds through `args` are optional, because the caller's arguments merge over them.",
		),
	);
	lines.push("declare namespace commands {");
	lines.push(indent("interface Catalog {", 1));

	for (let i = 0; i < commands.length; i++) {
		const command = commands[i];
		const { type, optional } = callArgsType(command);
		const capability = exportCapabilityOf(command.handler);
		const description = command.description ?? command.title ?? `The \`${command.id}\` command.`;
		const boundKeys = Object.keys(command.args);
		const remarks = [
			`Fills slot \`${command.slot}\` through the \`${command.handler}\` export.`,
			boundKeys.length > 0 ? `Bound arguments: ${boundKeys.map((key) => `\`${key}\``).join(", ")}.` : "",
		]
			.filter(Boolean)
			.join(" ");
		lines.push(indent(generateJSDoc(description, { ...(capability ? { capability } : {}), remarks }), 2));
		lines.push(indent(`${JSON.stringify(command.id)}: (args${optional ? "?" : ""}: ${type}) => ${returnType(command)};`, 2));
		if (i < commands.length - 1) lines.push("");
	}

	lines.push(indent("}", 1));
	lines.push("");
	lines.push(indent(generateJSDoc("A command id this mod contributes."), 1));
	lines.push(indent("type Id = keyof Catalog;", 1));
	lines.push("}");

	return lines.join("\n");
}
