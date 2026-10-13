/** Shared emission primitives: indentation, JSDoc blocks, and capability prose. */

export interface JSDocParam {
	name: string;
	description?: string;
}

export function splitMode(cap: string): { mode: string; scope: string } {
	const i = cap.indexOf(":");
	if (i < 0) return { mode: "write", scope: cap };
	return { mode: cap.slice(0, i), scope: cap.slice(i + 1) };
}

export function describeCapability(cap: string): string {
	const { mode, scope } = splitMode(cap);
	const access = mode === "read" ? "read access" : mode === "write" ? "write access" : `\`${mode}:\` access`;
	return `Requires capability: \`${cap}\` (${access} to the \`${scope}\` scope, satisfied by a grant on that scope or any dotted ancestor).`;
}

/**
 * Neutralizes a `*` immediately followed by `/` in free text bound for a JSDoc block. That sequence
 * closes the comment early and spills the rest of the description as invalid code, breaking the whole
 * generated declaration. A space is inserted between the two characters, which breaks the terminator
 * while keeping the text legible.
 */
export function escapeJsdoc(text: string): string {
	return text.replace(/\*\//g, "* /");
}

export function indent(text: string, level: number): string {
	const prefix = "\t".repeat(level);
	return text
		.split("\n")
		.map((line) => (line.trim() === "" ? "" : `${prefix}${line}`))
		.join("\n");
}

export function generateJSDoc(
	description: string | undefined,
	extras?: {
		params?: JSDocParam[];
		capability?: string;
		deprecated?: string;
		remarks?: string | string[];
		/** Raw `@tag value` lines, emitted after the description and before any remark. */
		tags?: string[];
		/** What the returned value represents, emitted as `@returns`. */
		returns?: string;
	},
): string {
	const body: string[] = [];
	if (description) body.push(` * ${escapeJsdoc(description)}`);

	if (extras?.tags && extras.tags.length > 0) {
		if (description) body.push(" *");
		for (const tag of extras.tags) {
			body.push(` * ${escapeJsdoc(tag)}`);
		}
	}
	if (extras?.deprecated) {
		body.push(` * @deprecated ${escapeJsdoc(extras.deprecated)}`);
	}
	if (extras?.capability) {
		body.push(` * @remarks ${escapeJsdoc(describeCapability(extras.capability))}`);
	}
	for (const remark of extras?.remarks === undefined ? [] : Array.isArray(extras.remarks) ? extras.remarks : [extras.remarks]) {
		body.push(` * @remarks ${escapeJsdoc(remark)}`);
	}
	if (extras?.params) {
		for (const param of extras.params) {
			if (param.description) {
				body.push(` * @param ${param.name} - ${escapeJsdoc(param.description)}`);
			}
		}
	}
	if (extras?.returns) {
		body.push(` * @returns ${escapeJsdoc(extras.returns)}`);
	}

	if (body.length === 0) return "";
	return ["/**", ...body, " */"].join("\n");
}
