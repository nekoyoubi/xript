import {
	FormatProfileError,
	REPEAT_INDEX_NAME,
	parseRepeatHeader,
	resolveFormatProfile,
	sanitizeFragment,
	tryParseExpression,
	type FragmentNode,
	type FragmentTree,
	type ParsedExpression,
} from "@xriptjs/sanitize";
import type { Finding } from "./lint.js";

/**
 * Where an expression was authored. TypeScript cannot see a string embedded in markup, so
 * the location has to be carried by hand for the message to be a fix rather than a riddle.
 */
export interface ExpressionSite {
	/** `data-if`, `data-bind`, `data-each`, `data-key`, or `{{ }}`. */
	surface: "data-if" | "data-bind" | "data-each" | "data-key" | "interpolation";
	/** Index path into the fragment tree, e.g. `/0/2/1`. */
	path: string;
	source: string;
	parsed: ParsedExpression | null;
	error: string | null;
	/**
	 * Names an enclosing `data-each` binds at this site: item names, index names, and
	 * `$index`. They shadow the fill's bindings, so a read of one is not a binding read.
	 */
	scope: ReadonlySet<string>;
}

export interface ExpressionAnalysisOptions {
	/**
	 * Fragment sources keyed by the fill's `source` value, for fills that name a file rather
	 * than carrying inline markup. A fill whose source cannot be resolved is skipped: the
	 * analyzer reports what it can read, never what it guesses.
	 */
	fragmentSources?: Record<string, string>;
	/**
	 * Resolved value types per binding name, when the host can supply them. Absent types
	 * disable the type-aware checks rather than inventing a shape for them.
	 */
	bindingTypes?: Record<string, Record<string, ExpressionType>>;
	formats?: Record<string, unknown> | null;
	vocabularies?: Record<string, unknown> | null;
}

export type ExpressionType = "number" | "string" | "boolean" | "array" | "object" | "unknown";

interface FragmentFill {
	label: string;
	fillId: string;
	format: string;
	source: string;
	inline: boolean;
	interpolate: boolean;
	bindings: Array<{ name: string; path: string }>;
	handlers: Array<{ selector: string; on: string; handler: string }>;
}

/** Events that push a value back through a binding rather than merely observing one. */
const WRITE_BACK_EVENTS = new Set(["input", "change"]);

/**
 * Walks every XEG expression a mod's fragment fills carry and reports what static reading
 * can prove: an unparseable body, an identifier no binding declares, a write-back handler
 * aimed at a computed value, a declared binding nothing reads.
 *
 * The analyzer lives here rather than in a CLI so hosts can import it, `xript lint --strict`
 * can gate on it, and the MCP surface can expose it — the same placement `score` already has.
 */
export function analyzeExpressions(
	mods: unknown[],
	options: ExpressionAnalysisOptions = {},
): Finding[] {
	const findings: Finding[] = [];

	for (const fill of fragmentFills(mods)) {
		const source = fill.inline ? fill.source : options.fragmentSources?.[fill.source];
		if (source === undefined) continue;

		let tree: FragmentTree;
		try {
			const profile = resolveFormatProfile(
				fill.format,
				options.formats ?? null,
				options.vocabularies ?? null,
			);
			if (!profile) continue;
			tree = sanitizeFragment(source, profile, { interpolate: fill.interpolate }).tree;
		} catch (err) {
			if (err instanceof FormatProfileError) continue;
			continue;
		}

		const sites = collectSites(tree, fill.interpolate);
		const declared = new Set(fill.bindings.map((binding) => binding.name));
		const read = new Set<string>();

		for (const site of sites) {
			if (!site.parsed) {
				findings.push({
					severity: "error",
					code: "expression-invalid",
					message: `${fill.label} fill "${fill.fillId}" has an invalid ${site.surface} expression at ${site.path}: ${site.error}`,
					suggestion: `Rewrite \`${site.source}\` as an xript expression. The grammar is documented at spec/expressions.md; assignment, calls on values, and host globals are not members of it.`,
				});
				continue;
			}

			for (const name of site.parsed.names) {
				if (site.scope.has(name)) continue;
				read.add(name);
				if (declared.has(name)) continue;
				findings.push({
					severity: "error",
					code: "expression-unknown-binding",
					message: `${fill.label} fill "${fill.fillId}" reads "${name}" at ${site.path}, which its \`bindings\` does not declare`,
					suggestion: declared.size > 0
						? `Declare a binding named "${name}", or use one of: ${[...declared].join(", ")}.`
						: `Declare a binding named "${name}" on the fill.`,
				});
			}

			const types = options.bindingTypes?.[fill.fillId];
			if (types) findings.push(...typeFindings(fill, site, types));
		}

		for (const binding of fill.bindings) {
			if (read.has(binding.name)) continue;
			findings.push({
				severity: "info",
				code: "expression-unused-binding",
				message: `${fill.label} fill "${fill.fillId}" declares binding "${binding.name}" that no expression reads`,
				suggestion: `Reference "${binding.name}" from a \`data-bind\`, \`data-if\`, \`data-each\`, or interpolation site, or drop the declaration.`,
			});
		}

		findings.push(...orphanKeyFindings(fill, tree));
		findings.push(...writeBackFindings(fill, tree));
		if (!fill.interpolate) findings.push(...dormantSiteFindings(fill, tree));
	}

	return findings;
}

export interface FragmentReadOptions {
	/** Whether `{{ }}` in text is an expression site, as the fill's `interpolate` flag says. */
	interpolate?: boolean;
	formats?: Record<string, unknown> | null;
	vocabularies?: Record<string, unknown> | null;
}

/**
 * The binding names a fragment's expressions read, in first-read order: every free identifier
 * across `data-bind`, `data-if`, `data-each`, `data-key`, and (when interpolating) `{{ }}`, minus
 * the names a `data-each` binds in its own scope. These are exactly the names a fill's `bindings`
 * must declare, so an editor can derive a fill's binding list from its markup. Unparseable
 * expressions contribute nothing; an unknown format or unparseable source yields an empty list.
 */
export function fragmentReadNames(source: string, format: string, options: FragmentReadOptions = {}): string[] {
	const interpolate = options.interpolate === true;
	let tree: FragmentTree;
	try {
		const profile = resolveFormatProfile(format, options.formats ?? null, options.vocabularies ?? null);
		if (!profile) return [];
		tree = sanitizeFragment(source, profile, { interpolate }).tree;
	} catch {
		return [];
	}
	const read = new Set<string>();
	for (const site of collectSites(tree, interpolate)) {
		for (const name of site.parsed?.names ?? []) {
			if (!site.scope.has(name)) read.add(name);
		}
	}
	return [...read];
}

/**
 * A write-back handler needs an lvalue. A bare name has one — the binding's `path`. A
 * computed value does not: there is no inverse of `round(hp / maxHp * 100)`, so the write
 * has nowhere to go. Reporting it beats dropping it silently at render time.
 */
function writeBackFindings(fill: FragmentFill, tree: FragmentTree): Finding[] {
	const findings: Finding[] = [];
	const computedIds = new Set<string>();

	walkScoped(tree, (node, scope) => {
		if (node.kind !== "element") return;
		const bind = node.props["data-bind"];
		const id = node.props.id;
		if (typeof bind !== "string" || typeof id !== "string") return;
		const parsed = tryParseExpression(bind);
		if (!parsed.ok) return;
		const readsRepeatName = parsed.expression.kind === "name" && scope.has(parsed.expression.names[0]);
		if (parsed.expression.kind === "expression" || readsRepeatName) computedIds.add(id);
	});

	for (const handler of fill.handlers) {
		if (!WRITE_BACK_EVENTS.has(handler.on)) continue;
		if (!handler.selector.startsWith("#")) continue;
		const id = handler.selector.slice(1);
		if (!computedIds.has(id)) continue;
		findings.push({
			severity: "error",
			code: "expression-readonly-writeback",
			message: `${fill.label} fill "${fill.fillId}" binds a "${handler.on}" handler to "${handler.selector}", whose \`data-bind\` is a computed expression or a repeat item`,
			suggestion: `A computed value has no inverse and a repeat item has no binding path, so the write has nowhere to land. Bind the handler to a node whose \`data-bind\` is a bare binding name, or handle the write in "${handler.handler}" explicitly.`,
		});
	}

	return findings;
}

/** `data-key` only means something on a `data-each` template; anywhere else it does nothing. */
function orphanKeyFindings(fill: FragmentFill, tree: FragmentTree): Finding[] {
	const findings: Finding[] = [];
	walkScoped(tree, (node, _scope, path) => {
		if (node.kind !== "element") return;
		if (typeof node.props["data-key"] !== "string" || typeof node.props["data-each"] === "string") return;
		findings.push({
			severity: "warn",
			code: "expression-orphan-key",
			message: `${fill.label} fill "${fill.fillId}" sets \`data-key\` at ${path} on a node with no \`data-each\``,
			suggestion: "Move `data-key` onto the `data-each` template it identifies, or drop it.",
		});
	});
	return findings;
}

/**
 * A fill that carries a well-formed `{{ … }}` site but never turned interpolation on is
 * almost always an authoring slip. It is `info`, not a warning: a documentation fragment
 * that quotes the syntax is a legitimate reason to leave the mode off.
 */
function dormantSiteFindings(fill: FragmentFill, tree: FragmentTree): Finding[] {
	const findings: Finding[] = [];
	walk(tree, (node) => {
		if (node.kind !== "text") return;
		const match = /\{\{([^{}]*)\}\}/.exec(node.value);
		if (!match) return;
		if (!tryParseExpression(match[1].trim()).ok) return;
		findings.push({
			severity: "info",
			code: "expression-dormant-site",
			message: `${fill.label} fill "${fill.fillId}" contains "{{${match[1]}}}" but does not set \`interpolate\``,
			suggestion: `Set \`"interpolate": true\` on the fill to evaluate the site, or leave it off if the delimiter is meant as prose.`,
		});
	});
	return findings;
}

function typeFindings(
	fill: FragmentFill,
	site: ExpressionSite,
	types: Record<string, ExpressionType>,
): Finding[] {
	const findings: Finding[] = [];
	const parsed = site.parsed;
	if (!parsed) return findings;

	const typeOf = (node: unknown): ExpressionType => {
		const ast = node as { t: string; name?: string };
		if (ast.t === "name" && ast.name) {
			return site.scope.has(ast.name) ? "unknown" : types[ast.name] ?? "unknown";
		}
		if (ast.t === "num") return "number";
		if (ast.t === "str") return "string";
		if (ast.t === "bool") return "boolean";
		return "unknown";
	};

	visitAst(parsed.ast, (node) => {
		const ast = node as {
			t: string;
			op?: string;
			left?: unknown;
			right?: unknown;
			obj?: unknown;
			name?: string;
		};

		if (ast.t === "member" || ast.t === "index") {
			const target = typeOf(ast.obj);
			if (target === "number" || target === "boolean" || target === "string") {
				findings.push({
					severity: "error",
					code: "expression-type",
					message: `${fill.label} fill "${fill.fillId}" reads a member of a ${target} at ${site.path} in \`${site.source}\``,
					suggestion: `A ${target} has no members in the expression grammar, so this always resolves to null.`,
				});
			}
			return;
		}

		if (ast.t !== "binary" || !ast.op) return;
		const left = typeOf(ast.left);
		const right = typeOf(ast.right);
		if (left === "unknown" || right === "unknown") return;

		if ("-*/%".includes(ast.op) && ast.op.length === 1) {
			for (const [side, type] of [["left", left], ["right", right]] as const) {
				if (type === "number") continue;
				findings.push({
					severity: "error",
					code: "expression-type",
					message: `${fill.label} fill "${fill.fillId}" applies "${ast.op}" to a ${type} on the ${side} at ${site.path} in \`${site.source}\``,
					suggestion: `Arithmetic is defined on numbers only; anything else evaluates to null. Wrap the operand in \`num(…)\` if the value is numeric text.`,
				});
			}
			return;
		}

		if (["<", "<=", ">", ">="].includes(ast.op) && left !== right) {
			findings.push({
				severity: "warn",
				code: "expression-type",
				message: `${fill.label} fill "${fill.fillId}" compares a ${left} with a ${right} at ${site.path} in \`${site.source}\``,
				suggestion: `A comparison between disjoint types is always false. Coerce one side with \`num(…)\` or \`str(…)\`.`,
			});
		}
	});

	return findings;
}

const NO_SCOPE: ReadonlySet<string> = new Set();

/**
 * The names a node's `data-each` brings into scope for the node itself and its subtree.
 * A header that does not parse brings none: the runtime renders zero copies of it, and the
 * header is reported as invalid on its own.
 */
function repeatScopeOf(node: FragmentNode, outer: ReadonlySet<string>): ReadonlySet<string> {
	if (node.kind !== "element") return outer;
	const each = node.props["data-each"];
	if (typeof each !== "string") return outer;
	const parsed = parseRepeatHeader(each);
	if (!parsed.ok) return outer;
	const scope = new Set(outer);
	scope.add(REPEAT_INDEX_NAME);
	scope.add(parsed.header.item);
	if (parsed.header.index !== null) scope.add(parsed.header.index);
	return scope;
}

function collectSites(tree: FragmentTree, interpolate: boolean): ExpressionSite[] {
	const sites: ExpressionSite[] = [];

	const visit = (nodes: FragmentTree, path: string, outer: ReadonlySet<string>): void => {
		nodes.forEach((node, index) => {
			const nodePath = `${path}/${index}`;

			if (node.kind === "text") {
				if (!interpolate || !node.segments) return;
				for (const segment of node.segments) {
					if (segment.kind !== "expr") continue;
					sites.push(site("interpolation", nodePath, segment.source, outer));
				}
				return;
			}

			const each = node.props["data-each"];
			if (typeof each === "string") sites.push(repeatSite(nodePath, each, outer));
			const scope = repeatScopeOf(node, outer);

			if (typeof each === "string") {
				const key = node.props["data-key"];
				if (typeof key === "string") sites.push(site("data-key", nodePath, key, scope));
			}

			const condition = node.props["data-if"];
			if (typeof condition === "string") sites.push(site("data-if", nodePath, condition, scope));

			const bind = node.props["data-bind"];
			if (typeof bind === "string") sites.push(site("data-bind", nodePath, bind, scope));

			visit(node.children, nodePath, scope);
		});
	};

	visit(tree, "", NO_SCOPE);
	return sites;
}

/** A `data-each` header's expression is evaluated in the enclosing scope, not its own. */
function repeatSite(path: string, source: string, outer: ReadonlySet<string>): ExpressionSite {
	const parsed = parseRepeatHeader(source);
	return parsed.ok
		? { surface: "data-each", path, source, parsed: parsed.header.expression, error: null, scope: outer }
		: { surface: "data-each", path, source, parsed: null, error: parsed.message, scope: outer };
}

function site(
	surface: ExpressionSite["surface"],
	path: string,
	source: string,
	scope: ReadonlySet<string>,
): ExpressionSite {
	const parsed = tryParseExpression(source);
	return parsed.ok
		? { surface, path, source, parsed: parsed.expression, error: null, scope }
		: { surface, path, source, parsed: null, error: parsed.error.message, scope };
}

function walk(tree: FragmentTree, visitor: (node: FragmentNode) => void): void {
	for (const node of tree) {
		visitor(node);
		if (node.kind === "element") walk(node.children, visitor);
	}
}

/** Walks the tree with the repeat names in scope at each node, and its source path. */
function walkScoped(
	tree: FragmentTree,
	visitor: (node: FragmentNode, scope: ReadonlySet<string>, path: string) => void,
	outer: ReadonlySet<string> = NO_SCOPE,
	path = "",
): void {
	tree.forEach((node, index) => {
		const nodePath = `${path}/${index}`;
		const scope = repeatScopeOf(node, outer);
		visitor(node, scope, nodePath);
		if (node.kind === "element") walkScoped(node.children, visitor, scope, nodePath);
	});
}

function visitAst(node: unknown, visitor: (node: unknown) => void): void {
	if (node === null || typeof node !== "object") return;
	visitor(node);
	for (const value of Object.values(node as Record<string, unknown>)) {
		if (Array.isArray(value)) {
			for (const item of value) visitAst(item, visitor);
			continue;
		}
		if (value !== null && typeof value === "object") visitAst(value, visitor);
	}
}

/** Every fragment-shaped fill across a mod set, from `fills` and the deprecated surfaces. */
function fragmentFills(mods: unknown[]): FragmentFill[] {
	const result: FragmentFill[] = [];

	for (const raw of mods) {
		const mod = (raw ?? {}) as {
			name?: string;
			fills?: Record<string, unknown>;
			fragments?: unknown[];
		};
		const label = mod.name ? `mod "${mod.name}"` : "a mod";

		const consider = (value: unknown, fallbackId: string): void => {
			if (value === null || typeof value !== "object" || Array.isArray(value)) return;
			const fill = value as Record<string, unknown>;
			if (typeof fill.format !== "string" || typeof fill.source !== "string") return;
			result.push({
				label,
				fillId: typeof fill.id === "string" ? fill.id : fallbackId,
				format: fill.format,
				source: fill.source,
				inline: fill.inline === true,
				interpolate: fill.interpolate === true,
				bindings: Array.isArray(fill.bindings)
					? fill.bindings.flatMap((binding) => {
						const entry = (binding ?? {}) as { name?: unknown; path?: unknown };
						return typeof entry.name === "string" && typeof entry.path === "string"
							? [{ name: entry.name, path: entry.path }]
							: [];
					})
					: [],
				handlers: normalizeHandlers(fill.handlers ?? fill.events),
			});
		};

		for (const [slotId, value] of Object.entries(mod.fills ?? {})) {
			if (Array.isArray(value)) {
				value.forEach((entry, index) => consider(entry, `${slotId}-fill-${index}`));
				continue;
			}
			consider(value, slotId);
		}

		if (Array.isArray(mod.fragments)) {
			mod.fragments.forEach((entry, index) => consider(entry, `fragment-${index}`));
		}
	}

	return result;
}

function normalizeHandlers(value: unknown): FragmentFill["handlers"] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((raw) => {
		const entry = (raw ?? {}) as { selector?: unknown; on?: unknown; handler?: unknown };
		return typeof entry.selector === "string"
			&& typeof entry.on === "string"
			&& typeof entry.handler === "string"
			? [{ selector: entry.selector, on: entry.on, handler: entry.handler }]
			: [];
	});
}
