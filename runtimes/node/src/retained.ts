import { CallbackError, RetainError } from "./errors.js";

/** The default for `limits.max_retained_callbacks`. */
export const DEFAULT_MAX_RETAINED_CALLBACKS = 10000;

/** Whether a callback found at a path (argument index, then keys and indices) is at a retain position. */
export type RetainPositions = (path: readonly (string | number)[]) => boolean;

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

/** The manifest's `types` block, as far as finding retain positions needs it. */
export type DeclaredTypes = Record<string, { fields?: Record<string, DeclaredField> }> | undefined;

type TypeNode =
	| { kind: "name"; name: string }
	| { kind: "function" }
	| { kind: "optional"; of: TypeNode }
	| { kind: "array"; of: TypeNode }
	| { kind: "map"; of: TypeNode }
	| { kind: "union"; members: TypeNode[] };

/**
 * Parses the string form of a type reference: `union := postfix ('|' postfix)*`,
 * `postfix := primary ('[]' | '?')*`, `primary := name | '(' union ')'`.
 */
function parseTypeString(source: string): TypeNode | null {
	let pos = 0;
	const skip = () => {
		while (pos < source.length && /\s/.test(source[pos])) pos++;
	};
	const union = (): TypeNode | null => {
		const members: TypeNode[] = [];
		for (;;) {
			const member = postfix();
			if (!member) return null;
			members.push(member);
			skip();
			if (source[pos] !== "|") break;
			pos++;
		}
		return members.length === 1 ? members[0] : { kind: "union", members };
	};
	const postfix = (): TypeNode | null => {
		let node = primary();
		if (!node) return null;
		for (;;) {
			skip();
			if (source.startsWith("[]", pos)) {
				pos += 2;
				node = { kind: "array", of: node };
			} else if (source[pos] === "?") {
				pos++;
				node = { kind: "optional", of: node };
			} else {
				return node;
			}
		}
	};
	const primary = (): TypeNode | null => {
		skip();
		if (source[pos] === "(") {
			pos++;
			const inner = union();
			skip();
			if (source[pos] !== ")") return null;
			pos++;
			return inner;
		}
		const start = pos;
		while (pos < source.length && !/[\s|()[\]?]/.test(source[pos])) pos++;
		return pos > start ? { kind: "name", name: source.slice(start, pos) } : null;
	};
	const node = union();
	skip();
	return node && pos === source.length ? node : null;
}

function toTypeNode(ref: unknown): TypeNode | null {
	if (typeof ref === "string") return parseTypeString(ref);
	if (ref === null || typeof ref !== "object" || Array.isArray(ref)) return null;
	const object = ref as Record<string, unknown>;
	if ("function" in object) return { kind: "function" };
	const wrap = (kind: "optional" | "array" | "map", inner: unknown): TypeNode | null => {
		const of = toTypeNode(inner);
		return of ? { kind, of } : null;
	};
	if ("optional" in object) return wrap("optional", object.optional);
	if ("array" in object) return wrap("array", object.array);
	if ("map" in object) return wrap("map", object.map);
	if (Array.isArray(object.union)) {
		const members = object.union.map(toTypeNode).filter((m): m is TypeNode => m !== null);
		return { kind: "union", members };
	}
	return null;
}

/**
 * Whether the declared type `node` leads, along `steps`, to a retain position. `retainHere` is
 * the `retain` flag of the parameter or field the type belongs to; it applies only to the type
 * itself or an optional of it, so a function inside an array, map, or union is not a retain
 * position unless a declared field marks it. Walking the callback's actual path, rather than
 * enumerating positions up front, keeps a recursive type retainable at any depth.
 */
function retainsAt(node: TypeNode | null, retainHere: boolean, steps: readonly (string | number)[], types: DeclaredTypes): boolean {
	if (!node) return false;
	switch (node.kind) {
		case "function":
			return retainHere && steps.length === 0;
		case "optional":
			return retainsAt(node.of, retainHere, steps, types);
		case "array":
		case "map":
			return steps.length > 0 && retainsAt(node.of, false, steps.slice(1), types);
		case "union":
			return node.members.some((member) => retainsAt(member, false, steps, types));
		case "name": {
			if (node.name === "function") return retainHere && steps.length === 0;
			if (steps.length === 0) return false;
			const fields = types?.[node.name]?.fields;
			const key = String(steps[0]);
			if (!fields || !Object.prototype.hasOwnProperty.call(fields, key)) return false;
			const field = fields[key];
			return retainsAt(toTypeNode(field?.type), field?.retain === true, steps.slice(1), types);
		}
	}
}

/** The check for where a binding's arguments allow a callback to be retained. */
export function retainPositions(params: DeclaredParam[] | undefined, types: DeclaredTypes): RetainPositions {
	if (!params || params.length === 0) return () => false;
	const declared = params.map((param) => ({ node: toTypeNode(param.type), retain: param.retain === true }));
	const last = params.length - 1;
	const variadic = params[last].variadic === true;
	return (path) => {
		const argument = path[0] as number;
		const param = argument < last || (argument === last && !variadic) ? declared[argument] : variadic ? declared[last] : undefined;
		return param !== undefined && retainsAt(param.node, param.retain, path.slice(1), types);
	};
}

type ScriptFunction = (...args: unknown[]) => unknown;

/** A callback the host retained past its binding call. */
export interface RetainedCallback {
	/** Calls the script function: re-entrantly inside a running binding call, else on a fresh budget. */
	call(...args: unknown[]): unknown;
	/** Releases the callback; calling it afterwards fails as `released`. Releasing twice does nothing. */
	release(): void;
	readonly released: boolean;
	/** The binding the callback was retained from. */
	readonly binding: string;
}

/** The runtime state behind one retained callback. */
export interface RetainedRecord {
	fn: ScriptFunction | null;
	readonly owner: string | null;
	readonly binding: string;
	readonly registry: RetainedRegistry;
	readonly handle: RetainedCallback;
	released: boolean;
}

/** Every live handle in the process, so one passed to the wrong runtime is recognized and refused. */
const recordsByHandle = new WeakMap<object, RetainedRecord>();

/** Calls a retained callback's script function; supplied by the sandbox, which owns budgets. */
export type RetainedInvoker = (record: RetainedRecord, args: unknown[]) => unknown;

/** One runtime's retained callbacks: at most one per script function per mod, capped by the limit. */
export class RetainedRegistry {
	private readonly byFunction = new Map<ScriptFunction, Map<string | null, RetainedRecord>>();
	private count = 0;

	constructor(
		private readonly limit: number,
		private readonly invoke: RetainedInvoker,
	) {}

	/**
	 * Retains `fn` for `owner`. A function already retained for the same owner returns its
	 * existing handle wherever it arrived; anything else must be at a retain position and fit
	 * under the limit.
	 */
	retain(fn: ScriptFunction, binding: string, owner: string | null, retainable: boolean): RetainedCallback {
		const existing = this.byFunction.get(fn)?.get(owner);
		if (existing) return existing.handle;
		if (!retainable) throw new RetainError(binding, "undeclared");
		if (this.count >= this.limit) throw new RetainError(binding, "limit", this.limit);

		const registry = this;
		const handle: RetainedCallback = Object.freeze({
			call(...args: unknown[]): unknown {
				if (record.released || record.fn === null) throw new CallbackError(binding, "released");
				return registry.invoke(record, args);
			},
			release(): void {
				registry.release(record);
			},
			get released(): boolean {
				return record.released;
			},
			binding,
		});
		const record: RetainedRecord = { fn, owner, binding, registry, handle, released: false };
		recordsByHandle.set(handle, record);
		let owners = this.byFunction.get(fn);
		if (!owners) {
			owners = new Map();
			this.byFunction.set(fn, owners);
		}
		owners.set(owner, record);
		this.count++;
		return handle;
	}

	release(record: RetainedRecord): void {
		if (record.released) return;
		record.released = true;
		const owners = record.fn ? this.byFunction.get(record.fn) : undefined;
		owners?.delete(record.owner);
		if (owners && owners.size === 0 && record.fn) this.byFunction.delete(record.fn);
		record.fn = null;
		this.count--;
	}

	/** Releases every callback `mod` supplied, returning how many. */
	releaseOwner(mod: string): number {
		const records: RetainedRecord[] = [];
		for (const owners of this.byFunction.values()) {
			const record = owners.get(mod);
			if (record) records.push(record);
		}
		for (const record of records) this.release(record);
		return records.length;
	}

	releaseAll(): void {
		for (const owners of [...this.byFunction.values()]) {
			for (const record of [...owners.values()]) this.release(record);
		}
	}

	/**
	 * The script function a retained handle crossing into the sandbox stands for, or `undefined`
	 * when `value` is not a retained handle at all. A released handle, another runtime's, or one
	 * crossing in while a different mod is running than the one that supplied it is refused.
	 */
	resolve(value: object, current: string | null): ScriptFunction | undefined {
		const record = recordsByHandle.get(value);
		if (!record) return undefined;
		if (record.released || record.fn === null) throw new CallbackError(record.binding, "released");
		if (record.registry !== this || (current !== null && current !== record.owner)) {
			throw new CallbackError(record.binding, "expired", undefined, "foreign");
		}
		return record.fn;
	}
}
