import type { QuickJSAsyncContext, QuickJSContext, QuickJSHandle } from "quickjs-emscripten-core";
import type { PathStep } from "./retain-positions.js";

type Context = QuickJSContext | QuickJSAsyncContext;

/**
 * The sandbox half of every value crossing between host and sandbox, evaluated once per context
 * before any script runs, so everything it calls is captured untouched.
 *
 * A value JSON carries exactly crosses as JSON text, which is the fast path both ways. Anything
 * else crosses as a tape, so `undefined`, `NaN`, the infinities, `-0`, and script functions
 * survive at any depth. Going out, `encode` tries `JSON.stringify` with a replacer that throws
 * at the first value JSON would change, and falls back to the tape; a getter or `toJSON` the
 * aborted pass already reached runs again then. Coming in, the host checks the value first
 * (`isJsonExact`) and `JSON.parse` builds it. A tape is:
 *
 * - one buffer holding a `Float64Array` header (going out: code count, number count, text
 *   length, leaf count; coming in: code count, number count), then the numbers, then one shape
 *   code per value. Doubles carry every number exactly. The codes are the character codes of:
 *   `u` undefined, `n` null, `t` true, `f` false, `d` the next number, `s` a string whose length
 *   is the next number and whose code units are the next ones of the text, `w` (coming in only)
 *   a string whose length is the next number and whose code units are the numbers after it,
 *   `F` the next leaf, `[`...`]` an array of values, and `{`...`}` an object of entries (a
 *   string key, then its value);
 * - the text, every `s` string joined;
 * - the leaves: script functions going out, retained callbacks coming in.
 *
 * `encode` walks a script value going out with `JSON.stringify`'s rules (own enumerable string
 * keys in order, `toJSON`, wrapper objects unwrapped, symbols dropped, a cycle or a BigInt
 * refusing the whole value), except that it keeps the values JSON cannot spell and keeps script
 * functions for the host to decide about. A refused value crosses as its `String()` (or `""`),
 * which is what a dump of it always produced. `copyNamed` copies `name`, `message`, and `stack`
 * onto a top-level object that lacks them, as a dump does for errors.
 *
 * `decode` builds a value coming in from own data properties only (an object is spread from a
 * null-prototype record, an array made by `Array.of`), so no setter a script installed on a
 * prototype sees the value and an own `__proto__` key stays data.
 *
 * `codeUnits` spells a text as UTF-16 code units, for a text the host's UTF-8 decoding would
 * not round-trip (one holding NUL or a lone surrogate).
 */
const CROSSING_SOURCE = `(function () {
	var apply = Reflect.apply;
	var bind = Function.prototype.bind;
	var call = Function.prototype.call;
	function method(fn) {
		return apply(bind, call, [fn]);
	}
	var TypedArrayProto = Object.getPrototypeOf(Float64Array.prototype);
	var isArray = Array.isArray;
	var keysOf = Object.keys;
	var create = Object.create;
	var defineProperty = Object.defineProperty;
	var protoOf = Object.getPrototypeOf;
	var ObjectProto = Object.prototype;
	var ArrayProto = Array.prototype;
	var ArrayCtor = Array;
	var arrayOf = Array.of;
	var floor = Math.floor;
	var toTag = method(Object.prototype.toString);
	var joinAll = method(Array.prototype.join);
	var slice = method(String.prototype.slice);
	var charCodeAt = method(String.prototype.charCodeAt);
	var fromCharCode = String.fromCharCode;
	var StringOf = String;
	var Refusal = TypeError;
	var Buffer = ArrayBuffer;
	var Float64 = Float64Array;
	var Uint8 = Uint8Array;
	var Uint16 = Uint16Array;
	var bufferOf = method(Object.getOwnPropertyDescriptor(TypedArrayProto, "buffer").get);
	var typedSet = method(TypedArrayProto.set);
	var subarray = method(TypedArrayProto.subarray);
	var numberValue = method(Number.prototype.valueOf);
	var stringValue = method(String.prototype.valueOf);
	var booleanValue = method(Boolean.prototype.valueOf);
	var bigintValue = typeof BigInt === "function" ? method(BigInt.prototype.valueOf) : null;
	var NAMED = ["name", "message", "stack"];
	var MAX_LENGTH = 9007199254740991;
	var MAX_SPREAD = 32768;
	var CHUNK = 4096;
	var HEADER = 4;
	var stringify = JSON.stringify;
	var parseJson = JSON.parse;
	var NumberProto = Number.prototype;
	var isEnumerable = method(Object.prototype.propertyIsEnumerable);
	var SPECIAL = create(null);

	function resultReplacer(key, value) {
		var kind = typeof value;
		if (kind === "string") return value;
		if (kind === "number") {
			if (value - value !== 0 || (value === 0 && 1 / value < 0)) throw SPECIAL;
			return value;
		}
		if (kind === "object") {
			if (value !== null && protoOf(value) === NumberProto) throw SPECIAL;
			return value;
		}
		if (kind === "undefined") throw SPECIAL;
		return value;
	}

	function argReplacer(key, value) {
		var kind = typeof value;
		if (kind === "string") return value;
		if (kind === "number") {
			if (value - value !== 0 || (value === 0 && 1 / value < 0)) throw SPECIAL;
			return value;
		}
		if (kind === "object") {
			if (value !== null && protoOf(value) === NumberProto) throw SPECIAL;
			return value;
		}
		if (kind === "undefined" || kind === "function") throw SPECIAL;
		return value;
	}

	function needsNamed(value) {
		if (value === null || typeof value !== "object" || isArray(value)) return false;
		try {
			if (typeof value.toJSON === "function") return true;
			for (var i = 0; i < 3; i++) {
				if (!isEnumerable(value, NAMED[i]) && value[NAMED[i]] !== undefined) return true;
			}
		} catch (error) {
			return true;
		}
		return false;
	}

	function spread(record) {
		return { ...record };
	}

	function holds(valueOf, value) {
		try {
			valueOf(value);
			return true;
		} catch (error) {
			return false;
		}
	}

	function unwrap(value) {
		var proto = protoOf(value);
		if (proto === ObjectProto || proto === ArrayProto || proto === null) return value;
		var tag;
		try {
			tag = toTag(value);
		} catch (error) {
			return value;
		}
		if (tag === "[object Number]" && holds(numberValue, value)) return +value;
		if (tag === "[object String]" && holds(stringValue, value)) return StringOf(value);
		if (tag === "[object Boolean]" && holds(booleanValue, value)) return booleanValue(value);
		if (tag === "[object BigInt]" && bigintValue !== null && holds(bigintValue, value)) return bigintValue(value);
		return value;
	}

	function prepare(key, value) {
		var toJSON = value.toJSON;
		if (typeof toJSON === "function") {
			value = apply(toJSON, value, [typeof key === "number" ? StringOf(key) : key]);
			if (value === null || typeof value !== "object") return value;
		} else if (typeof value !== "object") {
			return value;
		}
		return unwrap(value);
	}

	function toLength(value) {
		var length = +value;
		if (!(length > 0)) return 0;
		length = floor(length);
		return length > MAX_LENGTH ? MAX_LENGTH : length;
	}

	function blankTape() {
		var tape = create(null);
		tape.codes = new Uint8(64);
		tape.codeCap = 64;
		tape.size = 0;
		tape.numbers = new Float64(16);
		tape.numberCap = 16;
		tape.numberCount = 0;
		tape.texts = create(null);
		tape.textCount = 0;
		tape.textLength = 0;
		tape.leaves = create(null);
		tape.leafCount = 0;
		tape.stack = create(null);
		tape.depth = 0;
		return tape;
	}

	function growCodes(tape) {
		var codes = new Uint8(tape.codeCap * 2);
		typedSet(codes, tape.codes);
		tape.codes = codes;
		tape.codeCap *= 2;
	}

	function growNumbers(tape) {
		var numbers = new Float64(tape.numberCap * 2);
		typedSet(numbers, tape.numbers);
		tape.numbers = numbers;
		tape.numberCap *= 2;
	}

	function text(tape, value) {
		if (tape.size === tape.codeCap) growCodes(tape);
		tape.codes[tape.size++] = 115;
		if (tape.numberCount === tape.numberCap) growNumbers(tape);
		tape.numbers[tape.numberCount++] = value.length;
		tape.texts[tape.textCount++] = value;
		tape.textLength += value.length;
	}

	function emitNamed(tape, source, emitted) {
		for (var i = 0; i < 3; i++) {
			var name = NAMED[i];
			if (emitted[name] === true) continue;
			var value;
			try {
				value = source[name];
			} catch (error) {
				continue;
			}
			if (value === undefined) continue;
			var size = tape.size, textCount = tape.textCount, textLength = tape.textLength;
			var numberCount = tape.numberCount, leafCount = tape.leafCount, depth = tape.depth;
			try {
				var prepared = value !== null && (typeof value === "object" || typeof value === "function" || typeof value === "bigint")
					? prepare(name, value)
					: value;
				if (typeof prepared === "symbol") continue;
				text(tape, name);
				emit(tape, prepared, null);
			} catch (error) {
				tape.size = size;
				tape.textCount = textCount;
				tape.textLength = textLength;
				tape.numberCount = numberCount;
				tape.leafCount = leafCount;
				tape.depth = depth;
			}
		}
	}

	function emit(tape, value, namedSource) {
		var kind = typeof value;
		if (tape.size === tape.codeCap) growCodes(tape);
		if (kind === "number") {
			tape.codes[tape.size++] = 100;
			if (tape.numberCount === tape.numberCap) growNumbers(tape);
			tape.numbers[tape.numberCount++] = value;
			return;
		}
		if (kind === "string") {
			text(tape, value);
			return;
		}
		if (kind === "boolean") {
			tape.codes[tape.size++] = value ? 116 : 102;
			return;
		}
		if (kind === "undefined") {
			tape.codes[tape.size++] = 117;
			return;
		}
		if (kind === "function") {
			tape.codes[tape.size++] = 70;
			tape.leaves[tape.leafCount++] = value;
			return;
		}
		if (kind === "bigint") throw new Refusal("a BigInt cannot cross to the host");
		if (value === null) {
			tape.codes[tape.size++] = 110;
			return;
		}
		for (var s = 0; s < tape.depth; s++) {
			if (tape.stack[s] === value) throw new Refusal("a cyclic value cannot cross to the host");
		}
		tape.stack[tape.depth++] = value;
		var raw, entry, i;
		if (isArray(value)) {
			tape.codes[tape.size++] = 91;
			var length = toLength(value.length);
			for (i = 0; i < length; i++) {
				raw = value[i];
				entry = raw !== null && (typeof raw === "object" || typeof raw === "function" || typeof raw === "bigint") ? prepare(i, raw) : raw;
				if (typeof entry === "symbol") entry = null;
				emit(tape, entry, null);
			}
			if (tape.size === tape.codeCap) growCodes(tape);
			tape.codes[tape.size++] = 93;
		} else {
			tape.codes[tape.size++] = 123;
			var emitted = namedSource === null ? null : create(null);
			var keys = keysOf(value);
			for (i = 0; i < keys.length; i++) {
				var key = keys[i];
				raw = value[key];
				entry = raw !== null && (typeof raw === "object" || typeof raw === "function" || typeof raw === "bigint") ? prepare(key, raw) : raw;
				if (typeof entry === "symbol") continue;
				text(tape, key);
				emit(tape, entry, null);
				if (emitted !== null) emitted[key] = true;
			}
			if (emitted !== null) emitNamed(tape, namedSource, emitted);
			if (tape.size === tape.codeCap) growCodes(tape);
			tape.codes[tape.size++] = 125;
		}
		tape.depth -= 1;
	}

	function joined(record, count) {
		record.length = count;
		return joinAll(record, "");
	}

	function finish(tape) {
		var numberBytes = (HEADER + tape.numberCount) * 8;
		var buffer = new Buffer(numberBytes + tape.size);
		var head = new Float64(buffer, 0, HEADER + tape.numberCount);
		head[0] = tape.size;
		head[1] = tape.numberCount;
		head[2] = tape.textLength;
		head[3] = tape.leafCount;
		if (tape.numberCount > 0) typedSet(head, subarray(tape.numbers, 0, tape.numberCount), HEADER);
		typedSet(new Uint8(buffer, numberBytes, tape.size), subarray(tape.codes, 0, tape.size));
		var text = joined(tape.texts, tape.textCount);
		if (tape.leafCount === 0) return [buffer, text];
		tape.leaves.length = tape.leafCount;
		return [buffer, text, tape.leaves];
	}

	function refusedTape(value) {
		var refused;
		try {
			refused = StringOf(value);
		} catch (inner) {
			refused = "";
		}
		var tape = blankTape();
		text(tape, refused);
		return finish(tape);
	}

	function encodeTape(value, copyNamed) {
		var tape = blankTape();
		try {
			var prepared = value !== null && (typeof value === "object" || typeof value === "function" || typeof value === "bigint")
				? prepare("", value)
				: value;
			if (typeof prepared === "symbol") prepared = undefined;
			emit(tape, prepared, copyNamed === true ? value : null);
			return finish(tape);
		} catch (error) {
			return refusedTape(value);
		}
	}

	function encode(value, copyNamed, functionsCross) {
		if (!(copyNamed === true && needsNamed(value))) {
			try {
				var json = stringify(value, functionsCross === true ? argReplacer : resultReplacer);
				if (json !== undefined) return json;
			} catch (error) {
				if (error !== SPECIAL) return refusedTape(value);
			}
		}
		return encodeTape(value, copyNamed);
	}

	function codeUnits(source) {
		var units = new Uint16(source.length);
		for (var i = 0; i < source.length; i++) units[i] = charCodeAt(source, i);
		return bufferOf(units);
	}

	var slot = create(null);

	function place(target, key, value) {
		slot.value = value;
		slot.writable = true;
		slot.enumerable = true;
		slot.configurable = true;
		defineProperty(target, key, slot);
	}

	function readUnits(state, length) {
		var pieces = create(null);
		var count = 0;
		for (var offset = 0; offset < length; offset += CHUNK) {
			var size = length - offset < CHUNK ? length - offset : CHUNK;
			var units = new Uint16(size);
			for (var i = 0; i < size; i++) units[i] = state.numbers[state.numberAt++];
			pieces[count++] = apply(fromCharCode, undefined, units);
		}
		return joined(pieces, count);
	}

	function readArray(state) {
		var items = create(null);
		var count = 0;
		while (state.codes[state.at] !== 93) items[count++] = readValue(state);
		state.at += 1;
		if (count <= MAX_SPREAD) {
			items.length = count;
			return apply(arrayOf, ArrayCtor, items);
		}
		var array = [];
		for (var i = 0; i < count; i++) place(array, i, items[i]);
		return array;
	}

	function readObject(state) {
		var record = create(null);
		while (state.codes[state.at] !== 125) {
			var key = readValue(state);
			record[key] = readValue(state);
		}
		state.at += 1;
		return spread(record);
	}

	function readValue(state) {
		var code = state.codes[state.at++];
		switch (code) {
			case 100: return state.numbers[state.numberAt++];
			case 115: {
				var length = state.numbers[state.numberAt++];
				var value = slice(state.text, state.textAt, state.textAt + length);
				state.textAt += length;
				return value;
			}
			case 123: return readObject(state);
			case 91: return readArray(state);
			case 117: return undefined;
			case 110: return null;
			case 116: return true;
			case 102: return false;
			case 119: return readUnits(state, state.numbers[state.numberAt++]);
			case 70: return state.leaves[state.leafAt++];
		}
		throw new Refusal("unreadable value crossing");
	}

	function decode(buffer, text) {
		var head = new Float64(buffer, 0, 2);
		var codeCount = head[0];
		var numberCount = head[1];
		var state = create(null);
		state.numbers = new Float64(buffer, 16, numberCount);
		state.codes = new Uint8(buffer, 16 + numberCount * 8, codeCount);
		state.text = text === undefined ? "" : text;
		state.leaves = arguments;
		state.at = 0;
		state.textAt = 0;
		state.numberAt = 0;
		state.leafAt = 2;
		return readValue(state);
	}

	return [encode, decode, codeUnits, parseJson];
})()`;

interface CrossingHelpers {
	encode: QuickJSHandle;
	decode: QuickJSHandle;
	codeUnits: QuickJSHandle;
	parseJson: QuickJSHandle;
}

const helpersByContext = new WeakMap<Context, CrossingHelpers>();

function crossingFor(context: Context): CrossingHelpers {
	let helpers = helpersByContext.get(context);
	if (!helpers) {
		const triple = context.unwrapResult(context.evalCode(CROSSING_SOURCE, "xript-crossing.js"));
		try {
			helpers = {
				encode: context.getProp(triple, 0),
				decode: context.getProp(triple, 1),
				codeUnits: context.getProp(triple, 2),
				parseJson: context.getProp(triple, 3),
			};
		} finally {
			triple.dispose();
		}
		helpersByContext.set(context, helpers);
	}
	return helpers;
}

/** Installs the context's crossing helpers; must run before any script does. */
export function installCrossing(context: Context): void {
	crossingFor(context);
}

/** Releases the context's crossing helpers; must run before the context is disposed. */
export function releaseCrossing(context: Context): void {
	const helpers = helpersByContext.get(context);
	if (!helpers) return;
	helpersByContext.delete(context);
	for (const handle of [helpers.encode, helpers.decode, helpers.codeUnits, helpers.parseJson]) {
		if (handle.alive) handle.dispose();
	}
}

function isStaticHandle(context: Context, handle: QuickJSHandle): boolean {
	return handle === context.undefined || handle === context.null || handle === context.true || handle === context.false;
}

function release(context: Context, handle: QuickJSHandle): void {
	if (!isStaticHandle(context, handle) && handle.alive) handle.dispose();
}

const UNDEFINED = 117;
const NULL = 110;
const TRUE = 116;
const FALSE = 102;
const NUMBER = 100;
const TEXT = 115;
const UNITS = 119;
const LEAF = 70;
const ARRAY_START = 91;
const ARRAY_END = 93;
const OBJECT_START = 123;
const OBJECT_END = 125;

const HIGH = `${String.fromCharCode(0xd800)}-${String.fromCharCode(0xdbff)}`;
const LOW = `${String.fromCharCode(0xdc00)}-${String.fromCharCode(0xdfff)}`;
const LONE_SURROGATE = new RegExp(`[${HIGH}](?![${LOW}])|(?:^|[^${HIGH}])[${LOW}]`);

/**
 * Whether `value` survives the trip into the sandbox as a C string: it ends at NUL, and the UTF-8
 * encoder folds a lone high surrogate into the character after it.
 */
export function cStringSafe(value: string): boolean {
	if (value.includes("\0")) return false;
	const wellFormed = (value as { isWellFormed?: () => boolean }).isWellFormed;
	return typeof wellFormed === "function" ? wellFormed.call(value) : !LONE_SURROGATE.test(value);
}

/** A host value on its way in, spelled as a tape (see `CROSSING_SOURCE`). */
export class InboundTape {
	private readonly codes: number[] = [];
	private readonly texts: string[] = [];
	private readonly numbers: number[] = [];
	private readonly leaves: QuickJSHandle[] = [];

	undefined(): void {
		this.codes.push(UNDEFINED);
	}

	null(): void {
		this.codes.push(NULL);
	}

	boolean(value: boolean): void {
		this.codes.push(value ? TRUE : FALSE);
	}

	number(value: number): void {
		this.codes.push(NUMBER);
		this.numbers.push(value);
	}

	/** A string a C string cannot carry exactly (see `cStringSafe`) crosses as its code units. */
	text(value: string): void {
		this.numbers.push(value.length);
		if (cStringSafe(value)) {
			this.codes.push(TEXT);
			this.texts.push(value);
			return;
		}
		this.codes.push(UNITS);
		for (let i = 0; i < value.length; i++) this.numbers.push(value.charCodeAt(i));
	}

	/** Takes ownership of `handle`, which the sandbox receives as itself. */
	leaf(handle: QuickJSHandle): void {
		this.codes.push(LEAF);
		this.leaves.push(handle);
	}

	open(array: boolean): void {
		this.codes.push(array ? ARRAY_START : OBJECT_START);
	}

	close(array: boolean): void {
		this.codes.push(array ? ARRAY_END : OBJECT_END);
	}

	/** Builds the value inside the sandbox and releases every handle the tape held. */
	build(context: Context): QuickJSHandle {
		const numberBytes = (2 + this.numbers.length) * 8;
		const bytes = new ArrayBuffer(numberBytes + this.codes.length);
		const head = new Float64Array(bytes, 0, 2 + this.numbers.length);
		head[0] = this.codes.length;
		head[1] = this.numbers.length;
		head.set(this.numbers, 2);
		new Uint8Array(bytes, numberBytes).set(this.codes);
		const text = this.texts.join("");

		const parts: QuickJSHandle[] = [];
		try {
			parts.push(context.newArrayBuffer(bytes));
			parts.push(text === "" ? context.undefined : context.newString(text));
			return context.unwrapResult(context.callFunction(crossingFor(context).decode, context.undefined, ...parts, ...this.leaves));
		} finally {
			this.discard(context);
			for (const handle of parts) release(context, handle);
		}
	}

	/** Releases every handle the tape held. */
	discard(context: Context): void {
		for (const handle of this.leaves) release(context, handle);
		this.leaves.length = 0;
	}
}

/**
 * Builds a host value JSON carries exactly (see `isJsonExact`) inside the sandbox through the
 * captured `JSON.parse`, which defines own data properties, so no prototype setter sees it.
 */
export function parseIntoSandbox(context: Context, value: unknown): QuickJSHandle {
	const json = context.newString(JSON.stringify(value));
	try {
		return context.unwrapResult(context.callFunction(crossingFor(context).parseJson, context.undefined, json));
	} finally {
		json.dispose();
	}
}

export interface ReadOptions {
	/** Copies `name`, `message`, and `stack` onto a top-level object the way a dump does. */
	copyNamed?: boolean;
	/**
	 * Receives each script function inside the value along with its path, and owns the handle.
	 * Without it a function carries no data: null at the top level and as an array element,
	 * omitted as an object property.
	 */
	onFunction?: (fn: QuickJSHandle, path: PathStep[]) => unknown;
	/** Where the value sits, for `onFunction`'s paths. */
	path?: PathStep[];
	/** Receives the error, and owns it, when the walk itself was stopped (a budget interrupt). */
	onStopped?: (error: QuickJSHandle) => void;
}

/**
 * Reads a sandbox value for the host with JavaScript values intact at every depth. The caller
 * keeps ownership of `handle`; every handle this creates is released before it returns.
 */
export function readFromQuickJS(context: Context, handle: QuickJSHandle, options: ReadOptions = {}): unknown {
	const kind = context.typeof(handle);
	if (kind === "function") {
		return options.onFunction ? options.onFunction(handle.dup(), [...(options.path ?? [])]) : null;
	}
	if (kind === "string") return readString(context, handle);
	if (kind !== "object") return context.dump(handle);
	if (context.sameValue(handle, context.null)) return null;
	return walk(context, handle, options);
}

/**
 * The host decodes a C string as UTF-8, which ends at NUL and replaces a lone surrogate, so a
 * string whose decoded length disagrees with its own crosses through the tape instead.
 */
function readString(context: Context, handle: QuickJSHandle): string {
	const value = context.getString(handle);
	const lengthHandle = context.getProp(handle, "length");
	const length = context.getNumber(lengthHandle);
	lengthHandle.dispose();
	if (length === value.length) return value;
	return walk(context, handle, {}) as string;
}

function walk(context: Context, handle: QuickJSHandle, options: ReadOptions): unknown {
	const helpers = crossingFor(context);
	const result = context.callFunction(
		helpers.encode,
		context.undefined,
		handle,
		options.copyNamed ? context.true : context.false,
		options.onFunction ? context.true : context.false,
	);
	if (result.error) {
		if (options.onStopped) options.onStopped(result.error);
		else result.error.dispose();
		return "";
	}

	const tape = result.value;
	try {
		if (context.typeof(tape) === "string") return JSON.parse(context.getString(tape));
		const bufferHandle = context.getProp(tape, 0);
		let bytes: ArrayBuffer;
		try {
			bytes = copyBuffer(context, bufferHandle);
		} finally {
			bufferHandle.dispose();
		}
		const [codeCount, numberCount, textLength, leafCount] = new Float64Array(bytes, 0, 4);
		const numbers = new Float64Array(bytes, 32, numberCount);
		const codes = new Uint8Array(bytes, 32 + numberCount * 8, codeCount);
		const text = textLength === 0 ? "" : readText(context, helpers, tape, textLength);
		const leaves = leafCount > 0 ? context.getProp(tape, 2) : null;
		try {
			return new TapeReader(context, codes, text, numbers, leaves, options).read();
		} finally {
			leaves?.dispose();
		}
	} finally {
		tape.dispose();
	}
}

function copyBuffer(context: Context, buffer: QuickJSHandle): ArrayBuffer {
	const bytes = context.getArrayBuffer(buffer);
	try {
		return bytes.value.slice().buffer;
	} finally {
		bytes.dispose();
	}
}

/**
 * The host decodes a C string as UTF-8, which ends at NUL and replaces a lone surrogate; a text
 * that came back shorter or longer than it is crosses again as UTF-16 code units.
 */
function readText(context: Context, helpers: CrossingHelpers, tape: QuickJSHandle, length: number): string {
	const textHandle = context.getProp(tape, 1);
	try {
		const text = context.getString(textHandle);
		if (text.length === length) return text;
		const buffer = context.unwrapResult(context.callFunction(helpers.codeUnits, context.undefined, textHandle));
		try {
			return fromCodeUnits(new Uint16Array(copyBuffer(context, buffer)));
		} finally {
			buffer.dispose();
		}
	} finally {
		textHandle.dispose();
	}
}

const CODE_UNIT_CHUNK = 4096;

function fromCodeUnits(units: Uint16Array): string {
	let out = "";
	for (let offset = 0; offset < units.length; offset += CODE_UNIT_CHUNK) {
		out += String.fromCharCode(...units.subarray(offset, offset + CODE_UNIT_CHUNK));
	}
	return out;
}

class TapeReader {
	private at = 0;
	private textAt = 0;
	private numberAt = 0;
	private leafAt = 0;
	private readonly path: PathStep[];

	constructor(
		private readonly context: Context,
		private readonly codes: Uint8Array,
		private readonly text: string,
		private readonly numbers: Float64Array,
		private readonly leaves: QuickJSHandle | null,
		private readonly options: ReadOptions,
	) {
		this.path = [...(options.path ?? [])];
	}

	read(): unknown {
		const code = this.codes[this.at++];
		switch (code) {
			case NUMBER:
				return this.numbers[this.numberAt++];
			case TEXT: {
				const length = this.numbers[this.numberAt++];
				const value = this.text.slice(this.textAt, this.textAt + length);
				this.textAt += length;
				return value;
			}
			case OBJECT_START:
				return this.object();
			case ARRAY_START:
				return this.array();
			case UNDEFINED:
				return undefined;
			case NULL:
				return null;
			case TRUE:
				return true;
			case FALSE:
				return false;
			case LEAF:
				return this.fn();
			default:
				throw new Error(`xript: unreadable value crossing (shape code ${code})`);
		}
	}

	private fn(): unknown {
		const handle = this.context.getProp(this.leaves as QuickJSHandle, this.leafAt++);
		if (!this.options.onFunction) {
			handle.dispose();
			return null;
		}
		return this.options.onFunction(handle, [...this.path]);
	}

	private array(): unknown[] {
		const out: unknown[] = [];
		while (this.codes[this.at] !== ARRAY_END) {
			this.path.push(out.length);
			try {
				out.push(this.read());
			} finally {
				this.path.pop();
			}
		}
		this.at++;
		return out;
	}

	private object(): Record<string, unknown> {
		const out: Record<string, unknown> = {};
		while (this.codes[this.at] !== OBJECT_END) {
			const key = this.read() as string;
			if (this.codes[this.at] === LEAF && !this.options.onFunction) {
				this.at++;
				this.leafAt++;
				continue;
			}
			this.path.push(key);
			let value: unknown;
			try {
				value = this.read();
			} finally {
				this.path.pop();
			}
			if (key === "__proto__") {
				Object.defineProperty(out, key, { value, writable: true, enumerable: true, configurable: true });
			} else {
				out[key] = value;
			}
		}
		this.at++;
		return out;
	}
}
