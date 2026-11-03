/**
 * Renders the XEG reference pages from `spec/expression-reference.json`: one page of builtins
 * grouped by category, and one of operators, evaluation rules, and the attributes that carry
 * expressions. The reference is the source; these pages restate nothing by hand.
 */

const CATEGORY_TITLES = {
	numeric: "Numeric",
	string: "String",
	collection: "Collection",
	coercion: "Coercion",
};

/** A Markdown table cell: pipes escaped, newlines flattened. */
function cell(text) {
	return String(text).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function literal(value) {
	return JSON.stringify(value);
}

/** `pad(s: string, width: number, fill?: string = " "): string | null` */
export function builtinSignature(builtin) {
	const params = builtin.params.map((param) => {
		const name = param.variadic ? `...${param.name}` : param.name;
		const optional = param.optional ? "?" : "";
		const fallback = param.default !== undefined ? ` = ${literal(param.default)}` : "";
		return `${name}${optional}: ${param.type}${fallback}`;
	});
	return `${builtin.name}(${params.join(", ")}): ${builtin.returns}`;
}

function frontmatter(title, description) {
	return `---\ntitle: ${JSON.stringify(title)}\ndescription: ${JSON.stringify(description)}\n---\n\n`;
}

function examplesTable(examples) {
	if (!examples?.length) return "";
	const rows = examples.map((example) => {
		const bindings = example.bindings ? ` with \`${cell(JSON.stringify(example.bindings))}\`` : "";
		return `| \`${cell(example.expression)}\`${bindings} | \`${cell(literal(example.expect))}\` |`;
	});
	return ["| Expression | Result |", "|---|---|", ...rows].join("\n");
}

/** The builtins page, grouped by category in reference order. */
export function renderBuiltinsPage(reference, defaultBindings) {
	const categories = [];
	for (const builtin of reference.builtins) {
		if (!categories.includes(builtin.category)) categories.push(builtin.category);
	}

	const parts = [
		frontmatter(
			"XEG Builtins",
			"Every function an xript expression can call, with its signature, edge cases, and examples, generated from the expression reference.",
		),
		"The builtin table is closed: these are the only names an expression can call, and a host cannot add one. Every builtin is pure and total, so a wrong argument type yields `null` rather than an error. This page is generated from [`spec/expression-reference.json`](https://github.com/nekoyoubi/xript/blob/main/spec/expression-reference.json); the grammar and its semantics are on the [Expressions](/spec/expressions/) page, and the operators on [XEG Operators](/spec/expression-operators/).",
		"",
		"Examples evaluate against these bindings unless they name their own, and every one is a conformance case each runtime runs:",
		"",
		"```json",
		JSON.stringify(defaultBindings, null, 2),
		"```",
		"",
		categories.map((category) => `- [${CATEGORY_TITLES[category] ?? category}](#${category}): ${reference.builtins.filter((b) => b.category === category).map((b) => `[\`${b.name}\`](#${b.name})`).join(", ")}`).join("\n"),
	];

	for (const category of categories) {
		parts.push("", `## ${CATEGORY_TITLES[category] ?? category}`);
		for (const builtin of reference.builtins.filter((b) => b.category === category)) {
			parts.push(
				"",
				`### ${builtin.name}`,
				"",
				"```ts",
				builtinSignature(builtin),
				"```",
				"",
				builtin.summary,
				"",
				builtin.description,
			);
			const table = examplesTable(builtin.examples);
			if (table) parts.push("", table);
		}
	}

	return `${parts.join("\n")}\n`;
}

/** The operators page: a precedence table, then the rules and the attributes. */
export function renderOperatorsPage(reference) {
	const operators = [...reference.operators].sort((a, b) => b.precedence - a.precedence);
	const rows = operators.map((op) =>
		`| ${op.precedence} | \`${cell(op.symbol)}\` | ${cell(op.name)} | ${op.form} | ${op.associativity} | ${cell(op.summary)} |`);

	const parts = [
		frontmatter(
			"XEG Operators",
			"Operator precedence and associativity, the evaluation rules, and the attributes that carry xript expressions, generated from the expression reference.",
		),
		"Higher precedence binds tighter. Parentheses group without adding anything to the expression. This page is generated from [`spec/expression-reference.json`](https://github.com/nekoyoubi/xript/blob/main/spec/expression-reference.json); the builtins are on [XEG Builtins](/spec/expression-builtins/) and the full grammar on [Expressions](/spec/expressions/).",
		"",
		"| Precedence | Operator | Name | Form | Associativity | Summary |",
		"|---|---|---|---|---|---|",
		...rows,
		"",
		"## Operators in detail",
	];

	for (const op of operators) {
		parts.push("", `### \`${op.symbol}\` ${op.name}`, "", op.summary, "", op.description);
		const table = examplesTable(op.examples);
		if (table) parts.push("", table);
	}

	parts.push("", "## Evaluation rules");
	for (const rule of reference.rules) parts.push("", `### ${rule.title}`, "", rule.summary);

	parts.push(
		"",
		"## Where expressions appear",
		"",
		"| Attribute | Value | Summary |",
		"|---|---|---|",
		...reference.attributes.map((attr) => `| \`${cell(attr.name)}\` | ${cell(attr.value)} | ${cell(attr.summary)} |`),
	);
	for (const attr of reference.attributes) {
		parts.push("", `### \`${attr.name}\``, "", attr.description);
		if (attr.examples?.length) {
			parts.push("", "```html", ...attr.examples.map((example) => example.markup), "```");
		}
	}

	if (reference.scopeNames?.length) {
		parts.push("", "## Scope names");
		for (const scopeName of reference.scopeNames) {
			parts.push("", `### \`${scopeName.name}\``, "", `${scopeName.summary} ${scopeName.description}`);
		}
	}

	return `${parts.join("\n")}\n`;
}
