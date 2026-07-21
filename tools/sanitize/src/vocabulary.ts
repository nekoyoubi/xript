import {
	ALLOWED_ELEMENTS,
	STRIPPED_ELEMENTS,
	UNWRAPPED_ELEMENTS,
	isAllowedAttribute,
	isValidAttributeName,
	canonicalAttributeName,
	sanitizeUri,
	sanitizeStyleValue,
} from "./rules.js";
import { htmlToTree } from "./html.js";
import {
	FORBIDDEN_PROP_NAMES,
	jsString,
	setProp,
	treeToHtml,
	type FragmentElement,
	type FragmentNode,
	type FragmentText,
	type FragmentTree,
	type PropValue,
} from "./tree.js";
import { containsInterpolation, segmentText } from "./interpolate.js";
import {
	BUILTIN_PROFILES,
	PROTOCOL_PROPS,
	propDefinition,
	type ChildrenConstraint,
	type FormatProfile,
	type NodeDefinition,
	type PropDefinition,
	type Sink,
} from "./profiles.js";

export type DiagnosticCode =
	| "unknown-node"
	| "stripped-node"
	| "unknown-prop"
	| "invalid-prop"
	| "unsafe-prop"
	| "illegal-child"
	| "invalid-expression";

export type DiagnosticSeverity = "error" | "warning";

export interface FragmentDiagnostic {
	code: DiagnosticCode;
	severity: DiagnosticSeverity;
	/** Index path into the source tree, e.g. "/0/2/1". */
	path: string;
	node: string;
	prop?: string;
	message: string;
}

export interface VocabularyOptions {
	/**
	 * Promotes an unknown node under a built-in HTML vocabulary from a warning to an
	 * error. HTML's tag surface is open and externally defined, so the allowlist drops
	 * unknown tags rather than refusing the fragment; a host that wants the stricter
	 * contract opts in.
	 */
	strictVocabulary?: boolean;
	/**
	 * Turns on `{{ expr }}` segmentation for text nodes. Off by default, and that is a
	 * compatibility requirement rather than a preference: a fragment shipped before this
	 * mode existed may carry `{{` in prose or a code sample, and its meaning must not
	 * change. Mods opt in per fill via the manifest's `interpolate` flag.
	 */
	interpolate?: boolean;
}

export interface TreeSanitizeResult {
	tree: FragmentTree;
	diagnostics: FragmentDiagnostic[];
	strippedElements: string[];
	strippedAttributes: Array<{ element: string; attribute: string }>;
}

interface Context {
	profile: FormatProfile;
	strict: boolean;
	interpolate: boolean;
	diagnostics: FragmentDiagnostic[];
	strippedElements: string[];
	strippedAttributes: Array<{ element: string; attribute: string }>;
}

type Resolution =
	| { kind: "declared"; vocabulary: string | null; name: string; definition: NodeDefinition }
	| { kind: "html"; name: string }
	| { kind: "stripped"; name: string }
	| { kind: "unwrap" }
	| { kind: "unknown" };

/**
 * A prop name every vocabulary admits by prefix: dataset keys and ARIA
 * attributes. Both are inert metadata, so they are legal on a declared node
 * without the vocabulary naming them one at a time.
 */
export function isMetadataPropName(name: string): boolean {
	const lower = name.toLowerCase();
	return lower.startsWith("data-") || lower.startsWith("aria-");
}

/**
 * Applies a fragment format's vocabulary to a parsed tree: node names are matched
 * against the vocabulary, props against each node's declaration, and prop values are
 * routed through the sanitizer their declared sink names.
 *
 * Default-deny throughout. A node the vocabulary does not declare is refused: under a
 * host-declared vocabulary that is an error and the subtree is dropped. Under a built-in
 * profile, whose tag surface is open and externally defined, the drop is reported as a
 * warning rather than passing silently, and the disposition follows the source syntax:
 * an HTML-syntax source unwraps the unknown tag so its sanitized children survive (HTML's
 * lenient tag-soup parsing already renders unknown tags as their contents), while a
 * JSON-syntax (`jsml`) source drops the whole subtree, matching the stricter structural
 * contract of JSON markup.
 */
export function sanitizeTree(
	tree: FragmentTree,
	profile: FormatProfile,
	options: VocabularyOptions = {},
): TreeSanitizeResult {
	const ctx: Context = {
		profile,
		strict: options.strictVocabulary === true,
		interpolate: options.interpolate === true,
		diagnostics: [],
		strippedElements: [],
		strippedAttributes: [],
	};

	const sanitized = walkNodes(tree, ctx, "", "any");

	return {
		tree: sanitized,
		diagnostics: ctx.diagnostics,
		strippedElements: ctx.strippedElements,
		strippedAttributes: ctx.strippedAttributes,
	};
}

/**
 * Segments a text node's interpolation sites.
 *
 * This runs *inside the sanitizer*, on the way from source to validated tree, and that
 * placement is the structural half of the safety argument: substitution happens later,
 * in a runtime's bind pass, over an already-validated tree. There is no code path from a
 * binding value back into the tokenizer, because the tokenizer has already run and is
 * never called again.
 */
function segmentTextNode(node: FragmentText, ctx: Context, path: string): FragmentText {
	if (!containsInterpolation(node.value)) return node;

	const { segments, issues } = segmentText(node.value);

	for (const issue of issues) {
		report(ctx, {
			code: "invalid-expression",
			severity: "error",
			path,
			node: "#text",
			message: `invalid interpolation: ${issue.message}`,
		});
	}

	if (!segments) return node;
	return { kind: "text", value: node.value, segments };
}

function vocabularySeverity(ctx: Context): DiagnosticSeverity {
	if (!ctx.profile.builtin) return "error";
	return ctx.strict ? "error" : "warning";
}

function report(ctx: Context, diagnostic: FragmentDiagnostic): void {
	ctx.diagnostics.push(diagnostic);
}

function walkNodes(
	nodes: FragmentTree,
	ctx: Context,
	path: string,
	constraint: ChildrenConstraint,
): FragmentTree {
	const result: FragmentTree = [];

	nodes.forEach((node, index) => {
		const nodePath = `${path}/${index}`;

		if (node.kind === "text") {
			if (textAllowed(constraint)) {
				result.push(ctx.interpolate ? segmentTextNode(node, ctx, nodePath) : node);
				return;
			}
			if (node.value.trim() === "") return;
			report(ctx, {
				code: "illegal-child",
				severity: vocabularySeverity(ctx),
				path: nodePath,
				node: "#text",
				message: `text is not permitted here (children: ${describeConstraint(constraint)})`,
			});
			return;
		}

		const resolved = resolveNode(node.name, ctx.profile);

		if (resolved.kind === "unknown") {
			const severity = vocabularySeverity(ctx);
			report(ctx, {
				code: "unknown-node",
				severity,
				path: nodePath,
				node: node.name,
				message: `node "${node.name}" is not declared by format "${ctx.profile.id}"`,
			});
			if (severity === "warning" && ctx.profile.syntax === "html") {
				result.push(...walkNodes(node.children, ctx, nodePath, constraint));
			}
			return;
		}

		if (resolved.kind === "stripped") {
			ctx.strippedElements.push(resolved.name);
			report(ctx, {
				code: "stripped-node",
				severity: "warning",
				path: nodePath,
				node: resolved.name,
				message: `stripped dangerous element: <${resolved.name}>`,
			});
			return;
		}

		if (resolved.kind === "unwrap") {
			result.push(...walkNodes(node.children, ctx, nodePath, constraint));
			return;
		}

		if (!childAllowed(constraint, resolved.name)) {
			report(ctx, {
				code: "illegal-child",
				severity: vocabularySeverity(ctx),
				path: nodePath,
				node: resolved.name,
				message: `node "${resolved.name}" is not permitted here (children: ${describeConstraint(constraint)})`,
			});
			return;
		}

		result.push(
			resolved.kind === "declared"
				? sanitizeDeclaredNode(node, resolved.definition, ctx, nodePath)
				: sanitizeHtmlNode(node, resolved.name, ctx, nodePath),
		);
	});

	return result;
}

/**
 * Walks the format's scope in order, returning the first vocabulary's claim on the
 * name. Order is authoritative and literal: no reordering, no merging. The built-in
 * HTML arm declines rather than terminates, so a vocabulary listed after it still gets
 * its turn.
 */
function resolveNode(name: string, profile: FormatProfile): Resolution {
	for (const entry of profile.scope) {
		if (entry.kind === "declared") {
			if (Object.prototype.hasOwnProperty.call(entry.nodes, name)) {
				return { kind: "declared", vocabulary: entry.id, name, definition: entry.nodes[name] };
			}
			continue;
		}

		const lower = name.toLowerCase();
		if (STRIPPED_ELEMENTS.has(lower)) return { kind: "stripped", name: lower };
		if (UNWRAPPED_ELEMENTS.has(lower) && profile.syntax === "html") return { kind: "unwrap" };
		if (ALLOWED_ELEMENTS.has(lower)) return { kind: "html", name: lower };
	}

	return { kind: "unknown" };
}

/**
 * Whether a prop value reaches markup as an attribute *value*. `true` projects as a
 * bare attribute and `false`/`null` are omitted entirely, so neither carries text into
 * the document; every other type is stringified into the attribute and must therefore
 * be sanitized when the attribute is a dangerous sink.
 */
function projectsToMarkup(value: PropValue): boolean {
	return value !== null && typeof value !== "boolean";
}

/**
 * The built-in HTML vocabulary. Node and attribute names are folded to lower case,
 * attributes are filtered against a global allowlist, and `href`/`src`/`style` values
 * are routed through the value sanitizers by attribute name.
 */
function sanitizeHtmlNode(
	node: FragmentElement,
	tag: string,
	ctx: Context,
	path: string,
): FragmentElement {
	const props: Record<string, PropValue> = {};

	for (const [key, value] of Object.entries(node.props)) {
		const lowerKey = key.toLowerCase();

		if (FORBIDDEN_PROP_NAMES.has(lowerKey)) {
			ctx.strippedAttributes.push({ element: tag, attribute: lowerKey });
			report(ctx, {
				code: "unsafe-prop",
				severity: "warning",
				path,
				node: tag,
				prop: key,
				message: `prop "${key}" is reserved and was dropped`,
			});
			continue;
		}

		if (!isValidAttributeName(lowerKey)) {
			ctx.strippedAttributes.push({ element: tag, attribute: lowerKey });
			report(ctx, {
				code: "unsafe-prop",
				severity: "warning",
				path,
				node: tag,
				prop: key,
				message: `stripped attribute with a malformed name on <${tag}>`,
			});
			continue;
		}

		if (!isAllowedAttribute(tag, lowerKey)) {
			ctx.strippedAttributes.push({ element: tag, attribute: lowerKey });
			report(ctx, {
				code: lowerKey.startsWith("on") ? "unsafe-prop" : "unknown-prop",
				severity: "warning",
				path,
				node: tag,
				prop: lowerKey,
				message: `stripped attribute "${lowerKey}" on <${tag}>`,
			});
			continue;
		}

		if ((lowerKey === "href" || lowerKey === "src") && projectsToMarkup(value)) {
			const cleaned = sanitizeUri(jsString(value), lowerKey, ctx.profile.schemes);
			if (cleaned === null) {
				ctx.strippedAttributes.push({ element: tag, attribute: lowerKey });
				report(ctx, {
					code: "unsafe-prop",
					severity: "warning",
					path,
					node: tag,
					prop: lowerKey,
					message: `stripped attribute "${lowerKey}" on <${tag}>: unsafe URI`,
				});
				continue;
			}
			setProp(props, lowerKey, cleaned);
			continue;
		}

		if (lowerKey === "style" && projectsToMarkup(value)) {
			const cleaned = sanitizeStyleValue(jsString(value));
			if (cleaned) setProp(props, lowerKey, cleaned);
			continue;
		}

		setProp(props, canonicalAttributeName(lowerKey), value);
	}

	const element: FragmentElement = {
		kind: "element",
		name: tag,
		props,
		children: walkNodes(node.children, ctx, path, "any"),
	};
	if (node.selfClosing) element.selfClosing = true;
	return element;
}

/**
 * A node the host's own vocabulary declares. The name and every prop name are matched
 * verbatim, prop values keep their JSON type, and a value is only sanitized when the
 * prop declares a sink saying where it lands.
 */
function sanitizeDeclaredNode(
	node: FragmentElement,
	definition: NodeDefinition,
	ctx: Context,
	path: string,
): FragmentElement {
	const props: Record<string, PropValue> = {};

	for (const [key, value] of Object.entries(node.props)) {
		if (FORBIDDEN_PROP_NAMES.has(key.toLowerCase()) || /^on/i.test(key)) {
			report(ctx, {
				code: "unsafe-prop",
				severity: "warning",
				path,
				node: node.name,
				prop: key,
				message: `prop "${key}" is reserved and was dropped`,
			});
			continue;
		}

		if (PROTOCOL_PROPS.has(key)) {
			if (typeof value !== "string") {
				report(ctx, {
					code: "invalid-prop",
					severity: "warning",
					path,
					node: node.name,
					prop: key,
					message: `prop "${key}" must be a string`,
				});
				continue;
			}
			setProp(props, key, value);
			continue;
		}

		// `data-*` and `aria-*` are inert by construction and carry no value into a
		// sink, so a vocabulary does not have to enumerate them. The built-in HTML
		// vocabulary already admits both by prefix; a declared one that did not
		// would force a host to restate every dataset key and ARIA attribute it
		// ever writes, and silently drop the ones it forgot.
		if (isMetadataPropName(key)) {
			setProp(props, key, value);
			continue;
		}

		const declared = propDefinition(definition, key);
		if (!declared) {
			report(ctx, {
				code: "unknown-prop",
				severity: "warning",
				path,
				node: node.name,
				prop: key,
				message: `prop "${key}" is not declared on node "${node.name}"`,
			});
			continue;
		}

		if (declared.type !== undefined && !matchesJsonType(value, declared.type)) {
			report(ctx, {
				code: "invalid-prop",
				severity: "warning",
				path,
				node: node.name,
				prop: key,
				message: `prop "${key}" expects type ${JSON.stringify(declared.type)}`,
			});
			continue;
		}

		const sink = sinkOf(declared);
		if (sink === "text") {
			setProp(props, key, value);
			continue;
		}

		if (typeof value !== "string") {
			report(ctx, {
				code: "invalid-prop",
				severity: "warning",
				path,
				node: node.name,
				prop: key,
				message: `prop "${key}" declares sink "${sink}" and must be a string`,
			});
			continue;
		}

		const cleaned = applySink(sink, value, ctx.profile.schemes);
		if (cleaned === null) {
			report(ctx, {
				code: "unsafe-prop",
				severity: "warning",
				path,
				node: node.name,
				prop: key,
				message: `prop "${key}" was rejected by sink "${sink}"`,
			});
			continue;
		}

		setProp(props, key, cleaned);
	}

	const element: FragmentElement = {
		kind: "element",
		name: node.name,
		props,
		children: walkNodes(node.children, ctx, path, definition.children ?? "any"),
	};
	if (node.selfClosing) element.selfClosing = true;
	return element;
}

function sinkOf(declared: PropDefinition): Sink {
	const sink = declared.sink;
	if (sink === "uri" || sink === "image-uri" || sink === "css" || sink === "html") return sink;
	return "text";
}

function applySink(
	sink: Exclude<Sink, "text">,
	value: string,
	schemes: ReadonlySet<string>,
): string | null {
	switch (sink) {
		case "uri":
			return sanitizeUri(value, "href", schemes);
		case "image-uri":
			return sanitizeUri(value, "src", schemes);
		case "css": {
			const cleaned = sanitizeStyleValue(value);
			if (cleaned === "" && value.trim() !== "") return null;
			return cleaned;
		}
		case "html":
			return sanitizeHtmlString(value).html;
	}
}

/**
 * Sanitizes an HTML string by parsing it, sanitizing the tree, and serializing
 * the result — so the output is always well-formed, even when the input leaves
 * elements unclosed.
 *
 * Always sanitizes against the built-in HTML profile rather than the caller's,
 * which is what bounds the recursion: the built-in profile declares no sinks, so
 * a nested `html` sink cannot re-enter this function.
 */
export function sanitizeHtmlString(input: string): {
	html: string;
	strippedElements: string[];
	strippedAttributes: Array<{ element: string; attribute: string }>;
} {
	const profile = BUILTIN_PROFILES["text/html"];
	const parsed = sanitizeTree(htmlToTree(input, profile), profile, {});
	return {
		html: treeToHtml(parsed.tree),
		strippedElements: parsed.strippedElements,
		strippedAttributes: parsed.strippedAttributes,
	};
}

function matchesJsonType(value: PropValue, type: string | string[]): boolean {
	const types = Array.isArray(type) ? type : [type];
	return types.some(candidate => matchesSingleType(value, candidate));
}

function matchesSingleType(value: PropValue, type: string): boolean {
	switch (type) {
		case "string":
			return typeof value === "string";
		case "number":
			return typeof value === "number";
		case "integer":
			return typeof value === "number" && Number.isInteger(value);
		case "boolean":
			return typeof value === "boolean";
		case "null":
			return value === null;
		case "array":
			return Array.isArray(value);
		case "object":
			return typeof value === "object" && value !== null && !Array.isArray(value);
		default:
			return true;
	}
}

function textAllowed(constraint: ChildrenConstraint): boolean {
	return constraint === "any" || constraint === "text";
}

function childAllowed(constraint: ChildrenConstraint, name: string): boolean {
	if (constraint === "any") return true;
	if (constraint === "none" || constraint === "text") return false;
	return constraint.includes(name);
}

function describeConstraint(constraint: ChildrenConstraint): string {
	return Array.isArray(constraint) ? constraint.join(", ") : constraint;
}
