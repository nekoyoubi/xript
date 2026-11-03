import { EXPRESSION_REFERENCE_SOURCE } from "./generated/expression-reference.js";

/** One XEG value type, or several joined with ` | `. */
export type ExpressionTypeName = "any" | "null" | "boolean" | "number" | "string" | "array" | "object";

/** A conformance case: evaluated against the corpus default bindings unless `bindings` is given. */
export interface ExpressionReferenceExample {
	readonly expression: string;
	readonly bindings?: Readonly<Record<string, unknown>>;
	readonly expect: unknown;
}

export interface BuiltinParam {
	readonly name: string;
	readonly type: string;
	/** May be omitted. Only trailing parameters are optional. */
	readonly optional?: boolean;
	/** The value an omitted optional parameter takes. */
	readonly default?: unknown;
	/** The last parameter repeats: one or more arguments of this type. */
	readonly variadic?: boolean;
}

export interface BuiltinReference {
	readonly name: string;
	readonly category: "numeric" | "string" | "collection" | "coercion";
	readonly params: readonly BuiltinParam[];
	readonly returns: string;
	readonly summary: string;
	readonly description: string;
	readonly examples: readonly ExpressionReferenceExample[];
}

export interface OperatorReference {
	readonly symbol: string;
	readonly name: string;
	readonly form: "prefix" | "binary" | "ternary" | "postfix";
	/** Binding strength. Higher binds tighter. */
	readonly precedence: number;
	readonly associativity: "left" | "right";
	readonly summary: string;
	readonly description: string;
	readonly examples: readonly ExpressionReferenceExample[];
}

export interface RuleReference {
	readonly id: string;
	readonly title: string;
	readonly summary: string;
}

export interface AttributeReference {
	readonly name: string;
	readonly value: "expression" | "repeat header";
	/** The attribute this one only has meaning beside. */
	readonly modifies?: string;
	/** Present when the expression lives in content rather than an attribute value. */
	readonly site?: "text";
	readonly summary: string;
	readonly description: string;
	readonly examples: readonly { readonly markup: string }[];
}

export interface ScopeNameReference {
	readonly name: string;
	readonly scope: string;
	readonly summary: string;
	readonly description?: string;
}

/**
 * The machine-readable XEG reference (`spec/expression-reference.json`): builtin signatures
 * and descriptions, operators by precedence, evaluation rules, and the fragment attributes that
 * carry expressions. Every runtime ships the same file and holds its builtin table to it.
 */
export interface ExpressionReference {
	readonly grammar: "XEG";
	readonly types: readonly { readonly name: ExpressionTypeName; readonly summary: string }[];
	readonly builtins: readonly BuiltinReference[];
	readonly operators: readonly OperatorReference[];
	readonly rules: readonly RuleReference[];
	readonly attributes: readonly AttributeReference[];
	readonly scopeNames: readonly ScopeNameReference[];
}

function deepFreeze<T>(value: T): T {
	if (value !== null && typeof value === "object") {
		for (const child of Object.values(value)) deepFreeze(child);
		Object.freeze(value);
	}
	return value;
}

export const EXPRESSION_REFERENCE: ExpressionReference = deepFreeze(
	JSON.parse(EXPRESSION_REFERENCE_SOURCE) as ExpressionReference,
);

/** The `[min, max]` argument count a builtin's signature allows, with `Infinity` for a variadic tail. */
export function builtinArity(builtin: BuiltinReference): readonly [number, number] {
	const min = builtin.params.filter((param) => !param.optional).length;
	const variadic = builtin.params.some((param) => param.variadic);
	return Object.freeze([min, variadic ? Infinity : builtin.params.length] as const);
}
