import { sanitizeFragment, FragmentParseError } from "./fragment.js";
import { resolveFormatProfile, FormatProfileError } from "./profiles.js";

export {
	ALLOWED_ELEMENTS,
	STRIPPED_ELEMENTS,
	UNWRAPPED_ELEMENTS,
	VOID_ELEMENTS,
	ALLOWED_ATTRIBUTES,
	DEFAULT_URI_SCHEMES,
	DEFAULT_URI_SCHEME_SET,
	PROHIBITED_URI_SCHEMES,
	URI_SCHEME_NAME_PATTERN,
	isAllowedAttribute,
	sanitizeUri,
	sanitizeStyleValue,
	sanitizeStyleBlock,
} from "./rules.js";

export { htmlToTree, type SanitizeResult } from "./html.js";
export { decodeEntities } from "./tokenizer.js";
export { sanitizeHTML, sanitizeHTMLDetailed } from "./fragment.js";

export {
	jsmlToHtml,
	sanitizeJsml,
	type JsmlNode,
	type JsmlElement,
	type JsmlChild,
	type JsmlSanitizeResult,
} from "./jsml.js";

export {
	treeToHtml,
	treeToJsml,
	jsmlToTree,
	isFragmentElement,
	escapeHtml,
	escapeAttrValue,
	jsString,
	FORBIDDEN_PROP_NAMES,
	type FragmentTree,
	type FragmentNode,
	type FragmentElement,
	type FragmentText,
	type PropValue,
} from "./tree.js";

export {
	parseExpression,
	tryParseExpression,
	parseExpressionCached,
	evaluateAst,
	evaluateExpression,
	evaluateCondition,
	isTruthy,
	renderValue,
	toExprValue,
	ExpressionError,
	BUILTINS,
	BUILTIN_NAMES,
	DEFAULT_MAX_EXPRESSION_NODES,
	type ExprAst,
	type ExprValue,
	type ExpressionKind,
	type ParsedExpression,
	type ParseExpressionResult,
	type ParseExpressionOptions,
} from "./expr.js";

export {
	segmentText,
	containsInterpolation,
	segmentsToSource,
	type TextSegment,
	type SegmentResult,
	type SegmentIssue,
} from "./interpolate.js";

export {
	BUILTIN_PROFILES,
	BUILTIN_FORMAT_IDS,
	BUILTIN_VOCABULARY_IDS,
	NON_FRAGMENT_FORMAT_IDS,
	RESERVED_FORMAT_IDS,
	PROTOCOL_PROPS,
	SINKS,
	resolveFormatProfile,
	nodeDefinition,
	speaksHtml,
	anyVocabularyDeclares,
	FormatProfileError,
	type FormatProfile,
	type ResolvedVocabulary,
	type FragmentSyntax,
	type Sink,
	type NodeDefinition,
	type PropDefinition,
	type ChildrenConstraint,
} from "./profiles.js";

export {
	sanitizeTree,
	type FragmentDiagnostic,
	type DiagnosticCode,
	type DiagnosticSeverity,
	type VocabularyOptions,
	type TreeSanitizeResult,
} from "./vocabulary.js";

export {
	sanitizeFragment,
	parseJsmlSource,
	FragmentParseError,
	type SanitizedFragment,
	type FragmentContentType,
} from "./fragment.js";

export interface FragmentValidationResult {
	valid: boolean;
	errors: Array<{ message: string; line?: number }>;
	warnings: string[];
	sanitized: string;
}

/**
 * Validates a fragment source against the vocabulary its format declares.
 *
 * @param input - the fragment source
 * @param format - the fragment's media type
 * @param formats - the host manifest's `formats` block, when the format is host-declared
 * @param vocabularies - the host manifest's `vocabularies` block, when it declares one
 */
export function validateFragment(
	input: string,
	format: string,
	formats: Record<string, unknown> | null,
	vocabularies: Record<string, unknown> | null,
): FragmentValidationResult {
	let profile;
	try {
		profile = resolveFormatProfile(format, formats, vocabularies);
	} catch (err) {
		if (err instanceof FormatProfileError) {
			return { valid: false, errors: [{ message: err.message }], warnings: [], sanitized: "" };
		}
		throw err;
	}

	if (!profile) {
		return {
			valid: false,
			errors: [{ message: `unsupported fragment format: ${format}` }],
			warnings: [],
			sanitized: "",
		};
	}

	let result;
	try {
		result = sanitizeFragment(input, profile);
	} catch (err) {
		if (err instanceof FragmentParseError) {
			return { valid: false, errors: [{ message: err.message }], warnings: [], sanitized: "" };
		}
		throw err;
	}

	const errors: Array<{ message: string }> = [];

	for (const tag of result.strippedElements) {
		errors.push({ message: `stripped dangerous element: <${tag}>` });
	}

	for (const attr of result.strippedAttributes) {
		errors.push({ message: `stripped dangerous attribute: ${attr.attribute} on <${attr.element}>` });
	}

	const alreadyReported = new Set<string>(["stripped-node", "unknown-prop", "unsafe-prop"]);
	const warnings: string[] = [];

	for (const diagnostic of result.diagnostics) {
		if (diagnostic.severity === "error") {
			errors.push({ message: diagnostic.message });
			continue;
		}
		if (profile.builtin && alreadyReported.has(diagnostic.code)) continue;
		warnings.push(diagnostic.message);
	}

	return {
		valid: errors.length === 0,
		errors,
		warnings,
		sanitized: result.html,
	};
}
