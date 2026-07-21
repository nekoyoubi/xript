import {
	htmlToTree,
	isAllowedAttribute,
	jsmlToTree,
	jsString,
	sanitizeHTML,
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
			case "setAttr": {
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
				op.value = sanitizeOpChildren(raw.value, profile);
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
 */
function sanitizeOpChildren(value: unknown, profile: FormatProfile): unknown {
	if (typeof value === "string") {
		if (!speaksHtml(profile)) return value;
		if (profile.builtin) return sanitizeHTML(value);
		const sanitized = sanitizeTree(htmlToTree(value, profile), profile);
		return treeToHtml(sanitized.tree);
	}
	if (Array.isArray(value)) {
		const sanitized = sanitizeTree(jsmlToTree(value as JsmlNode[]), profile);
		return treeToJsml(sanitized.tree);
	}
	return value;
}
