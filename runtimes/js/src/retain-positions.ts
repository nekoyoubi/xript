/**
 * Where in a binding's arguments a callback may be retained. A binding parameter typed as a
 * function and marked `retain`, or a function-typed field marked `retain` on a declared type
 * reached through the parameter's type, is a retain position. A callback found anywhere else
 * stays call-scoped.
 */

/** One step of a callback's location: an argument index, an array index, or an object key. */
export type PathStep = number | string;

/** Whether a callback found at a path through a binding's arguments sits at a retain position. */
export type RetainPositions = (path: readonly PathStep[]) => boolean;

type TypeNode =
	| { kind: "name"; name: string }
	| { kind: "function" }
	| { kind: "array"; of: TypeNode }
	| { kind: "map"; of: TypeNode }
	| { kind: "optional"; of: TypeNode }
	| { kind: "union"; of: TypeNode[] };

interface DeclaredParam {
	name: string;
	type: unknown;
	variadic?: boolean;
	retain?: boolean;
}

interface DeclaredField {
	type: unknown;
	retain?: boolean;
}

interface DeclaredType {
	fields?: Record<string, DeclaredField>;
}

/**
 * Parses a type reference. The string form follows the type grammar
 * (`union := postfix ('|' postfix)*`, `postfix := primary ('[]' | '?')*`,
 * `primary := name | '(' union ')'`); a string outside it is one opaque name.
 */
export function parseTypeRef(type: unknown): TypeNode {
	if (typeof type === "string") return parseTypeString(type);
	if (type === null || typeof type !== "object" || Array.isArray(type)) return { kind: "name", name: "" };
	const record = type as Record<string, unknown>;
	if ("function" in record) return { kind: "function" };
	if ("optional" in record) return { kind: "optional", of: parseTypeRef(record.optional) };
	if ("array" in record) return { kind: "array", of: parseTypeRef(record.array) };
	if ("map" in record) return { kind: "map", of: parseTypeRef(record.map) };
	if (Array.isArray(record.union)) return { kind: "union", of: record.union.map(parseTypeRef) };
	return { kind: "name", name: "" };
}

function parseTypeString(source: string): TypeNode {
	let at = 0;
	const text = source;
	const skip = () => {
		while (at < text.length && /\s/.test(text[at])) at++;
	};

	function union(): TypeNode | null {
		const members: TypeNode[] = [];
		const first = postfix();
		if (!first) return null;
		members.push(first);
		skip();
		while (text[at] === "|") {
			at++;
			const next = postfix();
			if (!next) return null;
			members.push(next);
			skip();
		}
		return members.length === 1 ? members[0] : { kind: "union", of: members };
	}

	function postfix(): TypeNode | null {
		let node = primary();
		if (!node) return null;
		for (;;) {
			skip();
			if (text.startsWith("[]", at)) {
				at += 2;
				node = { kind: "array", of: node };
			} else if (text[at] === "?") {
				at++;
				node = { kind: "optional", of: node };
			} else {
				return node;
			}
		}
	}

	function primary(): TypeNode | null {
		skip();
		if (text[at] === "(") {
			at++;
			const inner = union();
			skip();
			if (!inner || text[at] !== ")") return null;
			at++;
			return inner;
		}
		const match = /^[A-Za-z_$][A-Za-z0-9_$.]*/.exec(text.slice(at));
		if (!match) return null;
		at += match[0].length;
		return match[0] === "function" ? { kind: "function" } : { kind: "name", name: match[0] };
	}

	const parsed = union();
	skip();
	if (!parsed || at !== text.length) return { kind: "name", name: source };
	return parsed;
}

/**
 * Whether the declared type `node` leads, along `steps`, to a retain position. `retainHere` is
 * the `retain` flag of the parameter or field the type belongs to; it applies only to the type
 * itself or an optional of it, so a function inside an array, map, or union is not a retain
 * position unless a declared field marks it. Walking the callback's actual path, rather than
 * enumerating positions up front, keeps a recursive type retainable at any depth.
 */
function retainsAt(
	node: TypeNode,
	retainHere: boolean,
	steps: readonly PathStep[],
	types: Record<string, DeclaredType> | undefined,
): boolean {
	switch (node.kind) {
		case "function":
			return retainHere && steps.length === 0;
		case "optional":
			return retainsAt(node.of, retainHere, steps, types);
		case "array":
		case "map":
			return steps.length > 0 && retainsAt(node.of, false, steps.slice(1), types);
		case "union":
			return node.of.some((member) => retainsAt(member, false, steps, types));
		case "name": {
			if (steps.length === 0 || !types || !Object.prototype.hasOwnProperty.call(types, node.name)) return false;
			const fields = types[node.name]?.fields;
			const key = String(steps[0]);
			if (!fields || !Object.prototype.hasOwnProperty.call(fields, key)) return false;
			const field = fields[key];
			return retainsAt(parseTypeRef(field?.type), field?.retain === true, steps.slice(1), types);
		}
	}
}

/** The check for where a binding's arguments allow a callback to be retained. */
export function retainPositions(
	params: DeclaredParam[] | undefined,
	types: Record<string, DeclaredType> | undefined,
): RetainPositions {
	if (!params || params.length === 0) return () => false;
	const declared = params.map((param) => ({ node: parseTypeRef(param.type), retain: param.retain === true }));
	const last = params.length - 1;
	const variadic = params[last].variadic === true;
	return (path) => {
		const argument = path[0];
		if (typeof argument !== "number") return false;
		const param = argument < last || (argument === last && !variadic) ? declared[argument] : variadic ? declared[last] : undefined;
		return param !== undefined && retainsAt(param.node, param.retain, path.slice(1), types);
	};
}
