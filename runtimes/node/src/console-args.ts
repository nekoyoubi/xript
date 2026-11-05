import { CrossingRefusal, MAX_CROSSING_DEPTH, TOO_DEEP_MESSAGE } from "./errors.js";

const NAMED = ["name", "message", "stack"] as const;
const MAX_LENGTH = Number.MAX_SAFE_INTEGER;

const WRAPPED: Record<string, (value: object) => unknown> = {
	"[object Number]": (value) => Number.prototype.valueOf.call(value),
	"[object String]": (value) => String.prototype.valueOf.call(value),
	"[object Boolean]": (value) => Boolean.prototype.valueOf.call(value),
	"[object BigInt]": (value) => BigInt.prototype.valueOf.call(value),
};

/**
 * Describes a thrown value the way a console line names it: `name: message` for an object with a
 * non-empty string `message` (`Error` standing in for a missing `name`), the bare name when the
 * message is empty, and `String(value)` for anything else.
 */
export function describeThrown(thrown: unknown): string {
	try {
		if (thrown !== null && typeof thrown === "object") {
			const { name, message } = thrown as { name?: unknown; message?: unknown };
			const label = typeof name === "string" ? name : "Error";
			return typeof message === "string" && message !== "" ? `${label}: ${message}` : label;
		}
		return String(thrown);
	} catch {
		return "Error";
	}
}

/** The text an argument that cannot be read reaches the host as. */
export function unreadable(thrown: unknown): string {
	return `[unreadable: ${describeThrown(thrown)}]`;
}

function isObject(value: unknown): value is object {
	return value !== null && typeof value === "object";
}

function unwrap(value: object): unknown {
	const proto = Object.getPrototypeOf(value);
	if (proto === null || Array.isArray(value)) return value;
	let tag: string;
	try {
		tag = Object.prototype.toString.call(value);
	} catch {
		return value;
	}
	const valueOf = WRAPPED[tag];
	if (!valueOf) return value;
	try {
		return valueOf(value);
	} catch {
		return value;
	}
}

function prepare(key: string, value: unknown): unknown {
	if (value === null || (typeof value !== "object" && typeof value !== "function" && typeof value !== "bigint")) return value;
	const toJSON = (value as { toJSON?: unknown }).toJSON;
	if (typeof toJSON === "function") {
		let replaced: unknown;
		try {
			replaced = Reflect.apply(toJSON, value, [key]);
		} catch {
			return isObject(value) ? unwrap(value) : value;
		}
		return isObject(replaced) ? unwrap(replaced) : replaced;
	}
	return isObject(value) ? unwrap(value) : value;
}

function findDescriptor(value: object, key: string): PropertyDescriptor | undefined {
	for (let target: object | null = value; target !== null; target = Object.getPrototypeOf(target)) {
		const descriptor = Object.getOwnPropertyDescriptor(target, key);
		if (descriptor !== undefined) return descriptor;
	}
	return undefined;
}

/** Whether a property may hold an accepted value, decided without running a getter, so each getter runs once. */
function mayHold(descriptor: PropertyDescriptor | undefined, accepts: (value: unknown) => boolean): boolean {
	if (descriptor === undefined) return false;
	return "get" in descriptor || "set" in descriptor || accepts(descriptor.value);
}

function needsNamed(value: unknown): boolean {
	if (!isObject(value) || Array.isArray(value)) return false;
	try {
		if (mayHold(findDescriptor(value, "toJSON"), (item) => typeof item === "function")) return true;
		for (const name of NAMED) {
			if (!Object.prototype.propertyIsEnumerable.call(value, name) && mayHold(findDescriptor(value, name), (item) => item !== undefined)) return true;
		}
	} catch {
		return true;
	}
	return false;
}

function toLength(value: unknown): number {
	const length = Number(value);
	if (!(length > 0)) return 0;
	return Math.min(Math.floor(length), MAX_LENGTH);
}

function define(target: object, key: string, value: unknown): void {
	Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

/**
 * Copies a sandbox value into host data by `JSON.stringify`'s rules (own enumerable string keys,
 * `toJSON`, wrappers unwrapped, symbols dropped, functions omitted from objects and `null` in
 * arrays), keeping what JSON cannot spell and keeping a cycle as a reference to the ancestor's
 * copy. Each property is read once.
 */
class ConsoleReader {
	private readonly frames: object[] = [];
	private readonly copies: object[] = [];

	read(item: unknown, namedSource: object | null = null): unknown {
		if (typeof item === "function") return null;
		if (!isObject(item)) return item;
		const at = this.frames.indexOf(item);
		if (at !== -1) return this.copies[at];
		if (this.frames.length >= MAX_CROSSING_DEPTH) throw new CrossingRefusal(TOO_DEEP_MESSAGE);
		const array = Array.isArray(item);
		const copy: object = array ? [] : {};
		this.frames.push(item);
		this.copies.push(copy);
		try {
			if (array) this.fillArray(item as unknown[], copy as unknown[]);
			else this.fillObject(item as Record<string, unknown>, copy, namedSource);
		} finally {
			this.frames.pop();
			this.copies.pop();
		}
		return copy;
	}

	private fillArray(source: unknown[], copy: unknown[]): void {
		const length = toLength(source.length);
		for (let i = 0; i < length; i++) {
			const item = prepare(String(i), source[i]);
			copy[i] = typeof item === "symbol" ? null : this.read(item);
		}
	}

	private fillObject(source: Record<string, unknown>, copy: object, namedSource: object | null): void {
		const emitted = new Set<string>();
		for (const key of Object.keys(source)) {
			const item = prepare(key, source[key]);
			if (typeof item === "symbol") continue;
			emitted.add(key);
			if (typeof item === "function") continue;
			define(copy, key, this.read(item));
		}
		if (namedSource) this.copyNamed(namedSource, copy, emitted);
	}

	private copyNamed(source: object, copy: object, emitted: Set<string>): void {
		for (const name of NAMED) {
			if (emitted.has(name)) continue;
			try {
				const value = (source as Record<string, unknown>)[name];
				if (value === undefined) continue;
				const item = prepare(name, value);
				if (typeof item === "symbol") continue;
				if (typeof item === "function") continue;
				define(copy, name, this.read(item));
			} catch {
				continue;
			}
		}
	}
}

/**
 * Reads one console argument for the host, matching what the universal runtime hands its console
 * handler: a function as its source text, a symbol as a fresh host symbol, an error-like object
 * with `name`, `message`, and `stack` copied on, everything else as data. A console call never
 * throws on what it is given: an argument whose reading throws reaches the host as
 * `[unreadable: <description>]`.
 */
export function readConsoleArgument(value: unknown): unknown {
	try {
		if (typeof value === "function") return String(value);
		if (typeof value === "symbol") return value.description === undefined ? Symbol() : Symbol(value.description);
		if (!isObject(value)) return value;
		const named = needsNamed(value);
		const prepared = prepare("", value);
		if (typeof prepared === "symbol") return undefined;
		return new ConsoleReader().read(prepared, named ? value : null);
	} catch (error) {
		return unreadable(error);
	}
}
