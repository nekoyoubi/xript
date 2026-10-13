import {
	htmlToTree,
	isAllowedAttribute,
	jsmlToTree,
	jsString,
	BUILTIN_PROFILES,
	propTypeLookup,
	sanitizeTree,
	speaksHtml,
	treeToHtml,
	treeToJsml,
	type DiagnosticCode,
	type DiagnosticSeverity,
	type FormatProfile,
	type JsmlNode,
	type PropValue,
	type Sink,
} from "@xriptjs/sanitize";
import { applySink, parseNodeRef, propSink } from "./fragment.js";
import type { FragmentOp, RawFragmentOp } from "./sandbox.js";

/**
 * Diagnostics the runtime raises. Extends the sanitizer's vocabulary findings with the
 * ones only the command buffer can produce.
 */
export type RuntimeDiagnosticCode =
	| DiagnosticCode
	| "unsupported-op"
	| "unsupported-target"
	| "op-unknown-prop"
	| "op-invalid-value"
	| "prop-sink-conflict";

export interface RuntimeDiagnostic {
	code: RuntimeDiagnosticCode;
	severity: DiagnosticSeverity;
	path: string;
	node: string;
	prop?: string;
	message: string;
}

export type FragmentDiagnosticListener = (diagnostic: RuntimeDiagnostic & { fragmentId: string }) => void;

const HTML_SUGAR_OPS = new Set(["addClass", "removeClass"]);

/**
 * The host-side pass over a command buffer. The in-sandbox proxy emits raw target strings
 * and raw values and does nothing else; parsing, vocabulary checks, and value sanitization
 * all happen here, in host code, where they can be tested.
 *
 * Op values were never sanitized by anything before this: a mod could hand a host raw
 * markup through `replaceChildren` or an `onclick` through `setAttr`, and the reference
 * host injected it. Every value now goes through the same sink model the fragment's own
 * source does.
 */
export function finalizeOps(
	ops: RawFragmentOp[],
	profile: FormatProfile,
	report?: (diagnostic: RuntimeDiagnostic) => void,
): FragmentOp[] {
	const finalized: FragmentOp[] = [];
	const isTree = !speaksHtml(profile);

	ops.forEach((raw, index) => {
		const path = `/${index}`;
		const target = parseNodeRef(raw.selector);

		const emit = (diagnostic: Omit<RuntimeDiagnostic, "path">) => {
			report?.({ ...diagnostic, path });
		};

		if (isTree && HTML_SUGAR_OPS.has(raw.op)) {
			emit({
				code: "unsupported-op",
				severity: "warning",
				node: raw.selector,
				message: `op "${raw.op}" is HTML-vocabulary sugar and has no meaning in format "${profile.id}"`,
			});
			return;
		}

		if (isTree && target.by === "selector") {
			emit({
				code: "unsupported-target",
				severity: "warning",
				node: raw.selector,
				message: `format "${profile.id}" has no CSS selectors — target a node by id ("#name")`,
			});
			return;
		}

		const op: FragmentOp = { op: raw.op, selector: raw.selector, target };

		switch (raw.op) {
			case "toggle":
				op.value = raw.value === true;
				break;

			case "setText":
				op.value = jsString((raw.value ?? "") as PropValue);
				break;

			case "addClass":
			case "removeClass":
				op.value = jsString((raw.value ?? "") as PropValue);
				break;

			case "setProp":
			case "setAttr":
			case "removeAttr": {
				const prop = raw.prop ?? raw.attr;
				if (typeof prop !== "string" || prop.length === 0) {
					emit({
						code: "op-unknown-prop",
						severity: "warning",
						node: raw.selector,
						message: `op "${raw.op}" needs a prop name`,
					});
					return;
				}
				const isAttribute = raw.op !== "setProp" || landsOnHtmlAttribute(profile, prop);
				const removes = raw.op === "removeAttr"
					|| (isAttribute && (raw.value === false || raw.value === null || raw.value === undefined));
				if (removes) {
					const refusal = checkPropName(profile, prop);
					if (refusal) {
						emit({ code: refusal.code, severity: "warning", node: raw.selector, prop, message: refusal.message });
						return;
					}
					op.op = "removeAttr";
					op.prop = prop;
					op.attr = prop;
					break;
				}
				if (isAttribute && typeof raw.value === "object" && raw.value !== null) {
					emit({
						code: "op-invalid-value",
						severity: "warning",
						node: raw.selector,
						prop,
						message: `op "${raw.op}" on "${raw.selector}" cannot write a non-primitive value to attribute "${prop}"`,
					});
					return;
				}
				const routed = routeOpValue(profile, prop, raw.value as PropValue);
				if (routed.rejected) {
					emit({
						code: routed.code,
						severity: "warning",
						node: raw.selector,
						prop,
						message: routed.message,
					});
					return;
				}
				op.prop = prop;
				if (raw.op === "setAttr") op.attr = prop;
				op.value = routed.value;
				break;
			}

			case "replaceChildren":
				if (typeof raw.value !== "string" && !Array.isArray(raw.value)) {
					emit({
						code: "op-invalid-value",
						severity: "warning",
						node: raw.selector,
						message: `op "replaceChildren" on "${raw.selector}" needs a string or a list of children`,
					});
					return;
				}
				op.value = sanitizeOpChildren(raw.value, profile, path, (diagnostic) => report?.(diagnostic));
				break;
		}

		finalized.push(op);
	});

	return finalized;
}

type RouteResult =
	| { rejected: false; value: PropValue }
	| { rejected: true; code: RuntimeDiagnosticCode; message: string };

/** Whether the format's scope is the built-in HTML vocabulary and nothing else. */
function speaksOnlyHtml(profile: FormatProfile): boolean {
	return profile.scope.length === 1 && profile.scope[0].kind === "builtin-html";
}

/**
 * An op names a prop but never the node it lands on, so the sink is resolved by union
 * across every vocabulary in scope rather than by the first-listed-wins rule that governs
 * node names — there is no name to order and nothing for order to disambiguate. A prop
 * name two nodes declare with different non-inert sinks is ambiguous, and an ambiguous
 * sink is not a sink: the op is refused rather than guessed. The built-in HTML fallback
 * fires only when no declared vocabulary in scope declares the prop, and is independent of
 * where `html` sits in the scope.
 */
function routeOpValue(profile: FormatProfile, prop: string, value: PropValue): RouteResult {
	if (speaksOnlyHtml(profile)) {
		const lower = prop.toLowerCase();
		if (!isAllowedAttribute("", lower)) {
			return { rejected: true, code: "unsafe-prop", message: `prop "${prop}" is not settable on an HTML node` };
		}
		const cleaned = applySink(htmlSinkFor(lower), value, profile.schemes);
		if (cleaned === null) {
			return { rejected: true, code: "unsafe-prop", message: `prop "${prop}" was rejected by its sink` };
		}
		return { rejected: false, value: cleaned };
	}

	const sinks = new Set<Sink>();
	let declared = false;
	for (const vocabulary of profile.scope) {
		if (vocabulary.kind !== "declared") continue;
		for (const definition of Object.values(vocabulary.nodes)) {
			const propDeclaration = definition.props
				&& Object.prototype.hasOwnProperty.call(definition.props, prop)
				? definition.props[prop]
				: undefined;
			if (!propDeclaration) continue;
			declared = true;
			sinks.add(propSink(propDeclaration));
		}
	}

	if (!declared) {
		if (speaksHtml(profile) && isAllowedAttribute("", prop.toLowerCase())) {
			const cleaned = applySink(htmlSinkFor(prop.toLowerCase()), value, profile.schemes);
			if (cleaned === null) {
				return { rejected: true, code: "unsafe-prop", message: `prop "${prop}" was rejected by its sink` };
			}
			return { rejected: false, value: cleaned };
		}
		return {
			rejected: true,
			code: "op-unknown-prop",
			message: `prop "${prop}" is not declared by any node of format "${profile.id}"`,
		};
	}

	const dangerous = [...sinks].filter((sink) => sink !== "text").sort();
	if (dangerous.length > 1) {
		return {
			rejected: true,
			code: "prop-sink-conflict",
			message: `prop "${prop}" is declared with conflicting sinks (${dangerous.join(", ")}) in format "${profile.id}"`,
		};
	}

	const cleaned = applySink(dangerous[0] ?? "text", value, profile.schemes);
	if (cleaned === null) {
		return { rejected: true, code: "unsafe-prop", message: `prop "${prop}" was rejected by sink "${dangerous[0]}"` };
	}
	return { rejected: false, value: cleaned };
}

function declaredByScope(profile: FormatProfile, prop: string): boolean {
	return profile.scope.some((vocabulary) => vocabulary.kind === "declared"
		&& Object.values(vocabulary.nodes).some((definition) => definition.props
			&& Object.prototype.hasOwnProperty.call(definition.props, prop)));
}

/**
 * Whether a prop write resolves to an HTML attribute rather than to a typed prop a
 * declared vocabulary owns. An attribute holds a string, so it has no `false` to hold:
 * `false` and `null` there mean "absent", the way a boolean attribute does in HTML.
 */
function landsOnHtmlAttribute(profile: FormatProfile, prop: string): boolean {
	if (speaksOnlyHtml(profile)) return true;
	return speaksHtml(profile) && !declaredByScope(profile, prop);
}

/** The name half of `routeOpValue`: whether an op may address this prop at all. */
function checkPropName(profile: FormatProfile, prop: string): { code: RuntimeDiagnosticCode; message: string } | null {
	if (speaksOnlyHtml(profile)) {
		return isAllowedAttribute("", prop.toLowerCase())
			? null
			: { code: "unsafe-prop", message: `prop "${prop}" is not settable on an HTML node` };
	}
	if (declaredByScope(profile, prop)) return null;
	if (speaksHtml(profile) && isAllowedAttribute("", prop.toLowerCase())) return null;
	return { code: "op-unknown-prop", message: `prop "${prop}" is not declared by any node of format "${profile.id}"` };
}

function htmlSinkFor(lowerProp: string): Sink {
	if (lowerProp === "href") return "uri";
	if (lowerProp === "src") return "image-uri";
	if (lowerProp === "style") return "css";
	return "text";
}

/**
 * `replaceChildren` is the one op whose value is markup, and it goes through the same
 * vocabulary the fragment's own source does. A declared format that speaks HTML carries
 * nodes the built-in HTML vocabulary knows nothing about, so sanitizing its markup against
 * built-in HTML alone would strip exactly the custom elements the format exists to declare.
 * A J5ML node list takes the same route through the tree sanitizer.
 *
 * The value keeps the shape the mod gave it. A list of strings under an HTML-speaking
 * format is a list of markup strings, each sanitized on its own and the list kept; the
 * empty list is an explicit clear. Any other list is a J5ML node list.
 *
 * Every finding the nested pass makes is forwarded with its path prefixed by the op's,
 * and for a markup list by the item's index too (`/0` op, `/2` item, `/1` node).
 */
function sanitizeOpChildren(
	value: unknown,
	profile: FormatProfile,
	opPath: string,
	emit: (diagnostic: RuntimeDiagnostic) => void,
): unknown {
	if (typeof value === "string") return sanitizeOpMarkup(value, profile, opPath, emit);
	if (Array.isArray(value) && speaksHtml(profile) && value.every((item) => typeof item === "string")) {
		// `Array.from` builds the list in the host realm; the value's own `map` would keep it in the sandbox's.
		return Array.from(value, (item, index) =>
			sanitizeOpMarkup(item as string, profile, `${opPath}/${index}`, emit));
	}
	if (Array.isArray(value)) {
		const sanitized = sanitizeTree(jsmlToTree(value as JsmlNode[]), profile);
		forwardDiagnostics(sanitized.diagnostics, opPath, emit);
		return treeToJsml(sanitized.tree);
	}
	return value;
}

/**
 * Sanitizes one markup string. A built-in format's markup is read as `text/html`, which is
 * what the string sanitizer has always done; a declared format's markup is read against its
 * own scope so its custom elements survive.
 */
function sanitizeOpMarkup(
	value: string,
	profile: FormatProfile,
	pathPrefix: string,
	emit: (diagnostic: RuntimeDiagnostic) => void,
): string {
	if (!speaksHtml(profile)) return value;
	const markupProfile = profile.builtin ? BUILTIN_PROFILES["text/html"] : profile;
	const sanitized = sanitizeTree(htmlToTree(value, markupProfile), markupProfile);
	forwardDiagnostics(sanitized.diagnostics, pathPrefix, emit);
	return treeToHtml(sanitized.tree, propTypeLookup(markupProfile));
}

function forwardDiagnostics(
	diagnostics: RuntimeDiagnostic[],
	pathPrefix: string,
	emit: (diagnostic: RuntimeDiagnostic) => void,
): void {
	for (const diagnostic of diagnostics) emit({ ...diagnostic, path: `${pathPrefix}${diagnostic.path}` });
}
