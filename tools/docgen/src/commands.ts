/**
 * Documentation for the `application/x-xript-command` slot kind.
 *
 * Two sections, folded out of the generic slot and fill tables the way event-typed slots fold into
 * Hooks: a host's command slots read as a contribution surface with a contract, and a mod's command
 * fills read as a catalog of named actions with their authority attached.
 */

import { COMMAND_ID_PATTERN, isCommandSlot, type CommandSlotDeclaration } from "@xriptjs/validate";

export interface CommandSlotDoc extends CommandSlotDeclaration {
	id: string;
	description?: string;
}

/** A command slot's declared deadline, if it overrides the manifest's. */
function budgetOf(slot: CommandSlotDoc): number | undefined {
	const limits = (slot as { limits?: { timeout_ms?: number } }).limits;
	return limits?.timeout_ms;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The host's command slots, in declaration order. */
export function commandSlots(slots: unknown): CommandSlotDoc[] {
	if (!Array.isArray(slots)) return [];
	return slots.filter((slot): slot is CommandSlotDoc => isCommandSlot(slot) && typeof (slot as CommandSlotDoc).id === "string");
}

function looksLikeCommandFill(fill: unknown): boolean {
	if (!isPlainObject(fill)) return false;
	if (typeof fill.format === "string" && typeof fill.source === "string") return false;
	if (isPlainObject(fill.fns)) return false;
	if (typeof fill.handler !== "string" || fill.handler.length === 0) return false;
	return typeof fill.id === "string" && COMMAND_ID_PATTERN.test(fill.id);
}

export interface CommandDoc {
	slot: string;
	id: string;
	handler: string;
	title: string;
	description?: string;
	group?: string;
	keywords: string[];
	args: Record<string, unknown>;
	input?: unknown;
	output?: unknown;
	priority: number;
	exposed: boolean;
}

/**
 * The commands a mod contributes. `hostSlots`, when supplied, is authoritative about which slots
 * take commands; without it the fill shape is sniffed, since a mod manifest alone does not carry
 * the declarations it fills.
 */
export function modCommands(fills: unknown, hostSlots?: unknown): CommandDoc[] {
	if (!isPlainObject(fills)) return [];
	const declared = hostSlots === undefined ? null : new Set(commandSlots(hostSlots).map((slot) => slot.id));
	const commands: CommandDoc[] = [];
	for (const [slotId, entries] of Object.entries(fills)) {
		if (declared && !declared.has(slotId)) continue;
		const list = Array.isArray(entries) ? entries : [entries];
		const seen = new Set<string>();
		for (const entry of list) {
			if (!looksLikeCommandFill(entry) || !isPlainObject(entry) || "capability" in entry) continue;
			const id = entry.id as string;
			if (seen.has(id)) continue;
			seen.add(id);
			commands.push({
				slot: slotId,
				id,
				handler: entry.handler as string,
				title: typeof entry.title === "string" ? entry.title : id,
				...(typeof entry.description === "string" ? { description: entry.description } : {}),
				...(typeof entry.group === "string" ? { group: entry.group } : {}),
				keywords: Array.isArray(entry.keywords) ? entry.keywords.filter((k): k is string => typeof k === "string") : [],
				args: isPlainObject(entry.args) ? entry.args : {},
				...(entry.input !== undefined ? { input: entry.input } : {}),
				...(entry.output !== undefined ? { output: entry.output } : {}),
				priority: typeof entry.priority === "number" ? entry.priority : 0,
				exposed: entry.exposed !== false,
			});
		}
	}
	return commands;
}

/** A one-cell summary of a JSON Schema: its property names when it has them, its type otherwise. */
export function summarizeSchema(schema: unknown): string {
	if (schema === undefined) return "—";
	if (schema === true) return "any";
	if (schema === false) return "never";
	if (!isPlainObject(schema)) return "—";
	if (isPlainObject(schema.properties)) {
		const names = Object.keys(schema.properties);
		if (names.length > 0) {
			const required = new Set((Array.isArray(schema.required) ? schema.required : []).filter((n): n is string => typeof n === "string"));
			return `\`{${names.map((name) => (required.has(name) ? name : `${name}?`)).join(", ")}}\``;
		}
	}
	if (Array.isArray(schema.enum)) return `\`${schema.enum.map((v) => JSON.stringify(v)).join(" | ")}\``;
	if (typeof schema.type === "string") return `\`${schema.type}\``;
	if (Array.isArray(schema.type)) return `\`${schema.type.join(" | ")}\``;
	if (typeof schema.$ref === "string") return `\`${schema.$ref}\``;
	return "any";
}

function fillContract(slot: CommandSlotDoc): string {
	const payload = slot.payload;
	if (!isPlainObject(payload)) return "open (no `payload` constraint)";
	const required = (Array.isArray(payload.required) ? payload.required : []).filter((n): n is string => typeof n === "string");
	const constrained = isPlainObject(payload.properties) ? Object.keys(payload.properties) : [];
	const parts: string[] = [];
	if (required.length > 0) parts.push(`requires ${required.map((name) => `\`${name}\``).join(", ")}`);
	const narrowed = constrained.filter((name) => !required.includes(name));
	if (narrowed.length > 0) parts.push(`narrows ${narrowed.map((name) => `\`${name}\``).join(", ")}`);
	return parts.length > 0 ? parts.join("; ") : "constrained by `payload`";
}

/**
 * The host's `## Commands` section. Command slots are lifted out of the UI Slots table, which
 * describes mounting points for fragments and says nothing true about an invocable action.
 */
export function generateHostCommandsSection(slots: CommandSlotDoc[]): string[] {
	const lines: string[] = [];
	lines.push("## Commands");
	lines.push("");
	lines.push(
		"Command slots: contribution surfaces for named, invocable actions. A mod fills one with a command that names an `id`, a `handler` naming one of the mod's exports, and optionally an `args` object of arguments bound at declaration time. The host resolves the slot to a list of commands and invokes one by name; the handler receives a single object, the bound `args` with the caller's arguments merged over them.",
	);
	lines.push("");
	lines.push(
		"Authority is two-layered and neither layer lives on the fill. The slot's capability gates *contribution* — a mod without the grant contributes no commands here. The capability declared on the export a command names gates *invocation*, re-checked at call time. A fill carrying its own `capability` is rejected at load.",
	);
	lines.push("");
	const declaresBudget = slots.some((slot) => budgetOf(slot) !== undefined);
	if (declaresBudget) {
		lines.push(
			"**Budget** is the deadline an invocation of that slot's commands runs under, overriding this manifest's `limits`. A slot may raise it as well as lower it; the embedder's hard limits still clamp the result.",
		);
		lines.push("");
	}
	lines.push(`| Slot | Capability | Multiple |${declaresBudget ? " Budget |" : ""} Fill contract |`);
	lines.push(`|------|------------|----------|${declaresBudget ? "--------|" : ""}---------------|`);
	for (const slot of slots) {
		const cap = slot.capability ? `\`${slot.capability}\`` : "—";
		const declared = budgetOf(slot);
		const budget = declaresBudget ? ` ${declared === undefined ? "inherited" : `\`${declared}ms\``} |` : "";
		lines.push(
			`| \`${slot.id}\` | ${cap} | ${slot.multiple === true ? "Yes" : "No"} |${budget} ${fillContract(slot)} |`,
		);
	}
	lines.push("");
	if (slots.some((slot) => slot.multiple !== true)) {
		lines.push(
			"> A command slot without `\"multiple\": true` resolves to exactly **one** command across every loaded mod, the same cardinality every other slot kind has. A palette or menu wants `\"multiple\": true`.",
		);
		lines.push("");
	}
	return lines;
}

/**
 * The mod's `## Commands` section. The Requires column reports the narrowest gate that applies —
 * the handler's export capability when it declares one, the slot's otherwise — so authority reads
 * as a property of the code a command names rather than of the command's label.
 */
export function generateModCommandsSection(
	commands: CommandDoc[],
	slotCapability: (slotId: string) => string | undefined,
	exportCapability: (handler: string) => string | undefined,
): string[] {
	const lines: string[] = [];
	lines.push("## Commands");
	lines.push("");
	lines.push(
		"Named, invocable actions this mod contributes. Each names a `handler` export; several commands may name the same export and differ only in the arguments they bind, which is how a parameterized action ships as a set of variants without minting a closure per variant.",
	);
	lines.push("");
	lines.push(
		"**Requires** is the narrowest capability that applies: the one declared on the handler's export where it declares one, the slot's contribution gate otherwise. Two commands differ in authority only by naming different exports.",
	);
	lines.push("");

	const bySlot = new Map<string, CommandDoc[]>();
	for (const command of commands) {
		const list = bySlot.get(command.slot) ?? [];
		list.push(command);
		bySlot.set(command.slot, list);
	}

	for (const [slotId, list] of bySlot) {
		lines.push(`### \`${slotId}\``);
		lines.push("");
		lines.push("| Id | Title | Handler | Requires | Bound args | Input | Output |");
		lines.push("|----|-------|---------|----------|------------|-------|--------|");
		for (const command of list) {
			const requires = exportCapability(command.handler) ?? slotCapability(command.slot);
			const bound = Object.keys(command.args);
			lines.push(
				`| \`${command.id}\` | ${command.title} | \`${command.handler}\` | ${requires ? `\`${requires}\`` : "—"} | ${
					bound.length > 0 ? bound.map((key) => `\`${key}\``).join(", ") : "—"
				} | ${summarizeSchema(command.input)} | ${summarizeSchema(command.output)} |`,
			);
		}
		lines.push("");
		const unexposed = list.filter((command) => !command.exposed);
		if (unexposed.length > 0) {
			lines.push(
				`> ${unexposed.map((command) => `\`${command.id}\``).join(", ")} declare \`"exposed": false\`: a discoverability hint asking not to be listed in a palette. They still resolve and still run — authority is capability, never exposure.`,
			);
			lines.push("");
		}
	}

	return lines;
}
