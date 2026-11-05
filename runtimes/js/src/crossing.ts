import type { QuickJSAsyncContext, QuickJSContext, QuickJSHandle } from "quickjs-emscripten-core";
import type { PathStep } from "./retain-positions.js";

type Context = QuickJSContext | QuickJSAsyncContext;

/**
 * The deepest a value may nest, in containers, to cross the boundary in either direction.
 * Deeper, the crossing is refused with a message the binding names, instead of the engine
 * running out of stack.
 */
export const MAX_CROSSING_DEPTH = 2048;

/**
 * The deepest the engine's own recursive `JSON.stringify` is trusted with. QuickJS checks its
 * stack limit when a script function calls another, but not as `JSON.stringify` descends, so a
 * deeper value would exhaust the WebAssembly stack and leave the engine unusable.
 */
export const NATIVE_STRINGIFY_DEPTH = 1000;

/**
 * How many containers the outbound pass takes without following which ones it is inside. A
 * value nests no deeper than it has containers, so up to here it cannot reach
 * `NATIVE_STRINGIFY_DEPTH`; past here the pass follows the containers it opens and hands a value
 * that nests more than the remaining `NATIVE_STRINGIFY_DEPTH - UNTRACKED_CONTAINERS` levels to
 * the tape walk.
 */
const UNTRACKED_CONTAINERS = 900;

/** The refusal message for a value nested past `MAX_CROSSING_DEPTH`. */
export const TOO_DEEP_MESSAGE = `a value nested deeper than ${MAX_CROSSING_DEPTH} levels cannot cross the host boundary`;

/**
 * The sandbox half of every value crossing between host and sandbox, evaluated once per context
 * before any script runs, so everything it calls is captured untouched.
 *
 * Going out, `encode` makes one `JSON.stringify` pass with a replacer that spells every value
 * JSON would change as a marker string: the context's mark (a NUL and a random nonce the host
 * chose, which no script ever sees) followed by `u` undefined, `n` NaN, `i` Infinity, `j`
 * -Infinity, `z` -0, `b` and the digits of a BigInt, `c` and how many containers up a cycle
 * points (1 is the container holding it), or `f` and the index of a script function in the
 * leaves. Wrapper objects unwrap first. So `undefined`, `NaN`, the infinities, `-0`, BigInts,
 * and script functions survive at any depth, and each getter runs once, read by
 * `JSON.stringify` itself. A value with no marker crosses as plain JSON text; one with a marker
 * crosses as `[json, leaves]`, and the host turns the markers back into values.
 *
 * Following which containers the pass is inside costs a comparison per value, so it starts only
 * past `UNTRACKED_CONTAINERS` containers, from the holder in hand, which bounds how deep the
 * engine's own recursion goes (anything deeper goes to the tape walk). A cycle the pass is not
 * following yet stops `JSON.stringify` with its own circular-reference error, and the pass runs
 * again following holders from the start, marking every cycle. The pass otherwise stops only when
 * something throws inside it, a `toJSON` or a getter; the tape walk then starts over and skips a
 * `toJSON` that throws. A getter can run again only on those second passes: in a cyclic value,
 * or when something in the value threw.
 * Coming in, the host checks the value first (`isJsonExact`) and `JSON.parse` builds it;
 * anything else crosses as a tape. A tape is:
 *
 * - one buffer holding a `Float64Array` header (going out: code count, number count, text
 *   length, leaf count; coming in: code count, number count), then the numbers, then one shape
 *   code per value. Doubles carry every number exactly. The codes are the character codes of:
 *   `u` undefined, `n` null, `t` true, `f` false, `d` the next number, `s` a string whose length
 *   is the next number and whose code units are the next ones of the text, `b` a BigInt spelled
 *   in decimal the same way, `c` the ancestor container the next number of levels up (1 is the
 *   container holding it), `w` (coming in only) a string whose length is the next number and
 *   whose code units are the numbers after it, `y` (coming in only) a symbol whose description
 *   is spelled like `s`, `Y` (coming in only) a symbol with no description, `F` the next leaf,
 *   `[`...`]` an array of values, and `{`...`}` an object of entries (a string key, then its
 *   value);
 * - the text, every `s` and `b` spelling joined;
 * - the leaves: script functions going out, retained callbacks coming in.
 *
 * `encode` walks a script value going out with `JSON.stringify`'s rules (own enumerable string
 * keys in order, `toJSON`, wrapper objects unwrapped, symbols dropped), except that it keeps the
 * values JSON cannot spell, keeps a cycle as a back-reference, skips a `toJSON` that throws so
 * the object crosses by its own properties, and keeps script functions for the host to decide
 * about. A getter that throws fails the crossing with its own error. A value nested past
 * `MAX_CROSSING_DEPTH` is refused: `encode` returns a one-element array holding the refusal.
 * `copyNamed` copies `name`, `message`, and `stack` onto a top-level object that lacks them, as
 * a dump does for errors.
 *
 * `decode` builds a value coming in from own data properties only (each property is defined,
 * never assigned), so no setter a script installed on a prototype sees the value and an own
 * `__proto__` key stays data.
 *
 * `codeUnits` spells a text as UTF-16 code units, for a text the host's UTF-8 decoding would
 * not round-trip (one holding NUL or a lone surrogate).
 */
const crossingSource = (mark: string): string => `(function () {
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
	var setProtoOf = Object.setPrototypeOf;
	var ObjectProto = Object.prototype;
	var ArrayProto = Array.prototype;
	var floor = Math.floor;
	var toTag = method(Object.prototype.toString);
	var joinAll = method(Array.prototype.join);
	var slice = method(String.prototype.slice);
	var charCodeAt = method(String.prototype.charCodeAt);
	var fromCharCode = String.fromCharCode;
	var StringOf = String;
	var SymbolOf = Symbol;
	var Refusal = TypeError;
	var BigIntOf = typeof BigInt === "function" ? BigInt : null;
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
	var bigintValue = BigIntOf !== null ? method(BigInt.prototype.valueOf) : null;
	var BigIntProto = BigIntOf !== null ? BigInt.prototype : null;
	var NAMED = ["name", "message", "stack"];
	var MAX_LENGTH = 9007199254740991;
	var MAX_DEPTH = ${MAX_CROSSING_DEPTH};
	var NATIVE_DEPTH = ${NATIVE_STRINGIFY_DEPTH};
	var TRACK_AFTER = ${UNTRACKED_CONTAINERS};
	var TOO_DEEP = ${JSON.stringify(TOO_DEEP_MESSAGE)};
	var CHUNK = 4096;
	var HEADER = 4;
	var stringify = JSON.stringify;
	var parseJson = JSON.parse;
	var NumberProto = Number.prototype;
	var isEnumerable = method(Object.prototype.propertyIsEnumerable);
	var ownDescriptor = Object.getOwnPropertyDescriptor;
	var DEEP = create(null);
	var MARK = ${JSON.stringify(mark)};
	var MARK_UNDEFINED = MARK + "u";
	var MARK_NAN = MARK + "n";
	var MARK_INFINITY = MARK + "i";
	var MARK_NEGATIVE_INFINITY = MARK + "j";
	var MARK_NEGATIVE_ZERO = MARK + "z";
	var MARK_BIGINT = MARK + "b";
	var MARK_CYCLE = MARK + "c";
	var MARK_LEAF = MARK + "f";

	function findDescriptor(value, key) {
		for (var target = value; target !== null; target = protoOf(target)) {
			var descriptor = ownDescriptor(target, key);
			if (descriptor !== undefined) return descriptor;
		}
		return undefined;
	}

	function mayHold(descriptor, accepts) {
		if (descriptor === undefined) return false;
		return "get" in descriptor || "set" in descriptor || accepts(descriptor.value);
	}

	function isFunction(value) {
		return typeof value === "function";
	}

	function isDefined(value) {
		return value !== undefined;
	}

	function needsNamed(value) {
		if (value === null || typeof value !== "object" || isArray(value)) return false;
		try {
			if (mayHold(findDescriptor(value, "toJSON"), isFunction)) return true;
			for (var i = 0; i < 3; i++) {
				if (!isEnumerable(value, NAMED[i]) && mayHold(findDescriptor(value, NAMED[i]), isDefined)) return true;
			}
		} catch (error) {
			return true;
		}
		return false;
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
		if (value === null || (typeof value !== "object" && typeof value !== "function" && typeof value !== "bigint")) return value;
		var toJSON = value.toJSON;
		if (typeof toJSON === "function") {
			try {
				value = apply(toJSON, value, [typeof key === "number" ? StringOf(key) : key]);
			} catch (error) {
				return typeof value === "object" ? unwrap(value) : value;
			}
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
		return tape;
	}

	function code(tape, value) {
		if (tape.size === tape.codeCap) {
			var codes = new Uint8(tape.codeCap * 2);
			typedSet(codes, tape.codes);
			tape.codes = codes;
			tape.codeCap *= 2;
		}
		tape.codes[tape.size++] = value;
	}

	function number(tape, value) {
		if (tape.numberCount === tape.numberCap) {
			var numbers = new Float64(tape.numberCap * 2);
			typedSet(numbers, tape.numbers);
			tape.numbers = numbers;
			tape.numberCap *= 2;
		}
		tape.numbers[tape.numberCount++] = value;
	}

	function spelled(tape, kind, value) {
		code(tape, kind);
		number(tape, value.length);
		tape.texts[tape.textCount++] = value;
		tape.textLength += value.length;
	}

	function emitNamed(tape, source, emitted, functionsCross) {
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
			var numberCount = tape.numberCount, leafCount = tape.leafCount;
			try {
				var prepared = prepare(name, value);
				if (typeof prepared === "symbol") continue;
				spelled(tape, 115, name);
				walk(tape, prepared, null, functionsCross);
			} catch (error) {
				tape.size = size;
				tape.textCount = textCount;
				tape.textLength = textLength;
				tape.numberCount = numberCount;
				tape.leafCount = leafCount;
			}
		}
	}

	function leaf(tape, value) {
		var kind = typeof value;
		if (kind === "number") {
			code(tape, 100);
			number(tape, value);
		} else if (kind === "string") {
			spelled(tape, 115, value);
		} else if (kind === "boolean") {
			code(tape, value ? 116 : 102);
		} else if (kind === "undefined") {
			code(tape, 117);
		} else if (kind === "function") {
			code(tape, 70);
			tape.leaves[tape.leafCount++] = value;
		} else if (kind === "bigint") {
			spelled(tape, 98, StringOf(value));
		} else if (kind === "symbol") {
			code(tape, 110);
		} else {
			return false;
		}
		return true;
	}

	function blankStack() {
		var stack = create(null);
		stack.count = 0;
		return stack;
	}

	function open(tape, frames, value, namedSource) {
		for (var s = 0; s < frames.count; s++) {
			if (frames[s].value === value) {
				code(tape, 99);
				number(tape, frames.count - s);
				return false;
			}
		}
		if (frames.count >= MAX_DEPTH) throw DEEP;
		var frame = create(null);
		frame.value = value;
		frame.array = isArray(value);
		frame.keys = frame.array ? null : keysOf(value);
		frame.length = frame.array ? toLength(value.length) : frame.keys.length;
		frame.index = 0;
		frame.emitted = namedSource === null ? null : create(null);
		frame.namedSource = namedSource;
		frames[frames.count++] = frame;
		code(tape, frame.array ? 91 : 123);
		return true;
	}

	function walk(tape, root, namedSource, functionsCross) {
		if (leaf(tape, root) || root === null) {
			if (root === null) code(tape, 110);
			return;
		}
		var frames = blankStack();
		open(tape, frames, root, namedSource);
		while (frames.count > 0) {
			var frame = frames[frames.count - 1];
			if (frame.index === frame.length) {
				if (frame.emitted !== null) emitNamed(tape, frame.namedSource, frame.emitted, functionsCross);
				code(tape, frame.array ? 93 : 125);
				frames.count -= 1;
				continue;
			}
			var at = frame.index++;
			var key = frame.array ? at : frame.keys[at];
			var item = prepare(key, frame.value[key]);
			if (frame.array) {
				if (typeof item === "symbol") item = null;
			} else {
				if (typeof item === "symbol") continue;
				spelled(tape, 115, key);
				if (frame.emitted !== null) frame.emitted[key] = true;
			}
			if (leaf(tape, item)) continue;
			if (item === null) {
				code(tape, 110);
				continue;
			}
			open(tape, frames, item, null);
		}
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

	function blankList() {
		var list = [];
		setProtoOf(list, null);
		return list;
	}

	function isCircular(error) {
		try {
			return error instanceof Refusal && error.message === "circular reference";
		} catch (inner) {
			return false;
		}
	}

	function makePass() {
		var functionsCross = false;
		var marked = false;
		var leaves = null;
		var tracking = false;
		var limit = 0;
		var containers = 0;
		var stack = null;
		var depth = 0;
		var top = null;
		var opened = null;

		function special(item) {
			marked = true;
			if (item !== item) return MARK_NAN;
			if (item === 0) return MARK_NEGATIVE_ZERO;
			return item > 0 ? MARK_INFINITY : MARK_NEGATIVE_INFINITY;
		}

		function unwrapped(raw) {
			if (typeof raw === "bigint") {
				marked = true;
				return MARK_BIGINT + StringOf(raw);
			}
			if (raw - raw !== 0 || (raw === 0 && 1 / raw < 0)) return special(raw);
			return raw;
		}

		function leaf(item) {
			marked = true;
			if (leaves === null) leaves = blankList();
			leaves[leaves.length] = item;
			return MARK_LEAF + (leaves.length - 1);
		}

		function startTracking(holder) {
			tracking = true;
			if (stack === null) stack = blankList();
			top = holder;
			stack[0] = holder;
			depth = 1;
		}

		function follow(holder) {
			top = holder;
			if (holder === opened) {
				stack[depth++] = holder;
				return;
			}
			while (depth > 0 && stack[depth - 1] !== holder) depth--;
			if (depth === 0) stack[depth++] = holder;
		}

		function replacer(key, item) {
			if (tracking && this !== top) follow(this);
			var kind = typeof item;
			if (kind === "string") return item;
			if (kind === "number") {
				if (item - item !== 0 || (item === 0 && 1 / item < 0)) return special(item);
				return item;
			}
			if (kind === "object") {
				if (item === null) return item;
				var proto = protoOf(item);
				if (proto === NumberProto || proto === BigIntProto) {
					var raw = unwrap(item);
					if (raw !== item) return unwrapped(raw);
				}
				if (!tracking) {
					if (++containers <= TRACK_AFTER) return item;
					startTracking(this);
				}
				for (var s = depth - 1; s >= 0; s--) {
					if (stack[s] === item) {
						marked = true;
						return MARK_CYCLE + (depth - s);
					}
				}
				if (depth >= limit) throw DEEP;
				opened = item;
				return item;
			}
			if (kind === "undefined") {
				marked = true;
				return MARK_UNDEFINED;
			}
			if (kind === "bigint") {
				marked = true;
				return MARK_BIGINT + StringOf(item);
			}
			if (kind === "function" && functionsCross) return leaf(item);
			return item;
		}

		function run(value, crossFunctions, trackFromStart) {
			functionsCross = crossFunctions === true;
			marked = false;
			leaves = null;
			containers = 0;
			depth = 0;
			top = null;
			opened = null;
			tracking = false;
			limit = trackFromStart ? NATIVE_DEPTH : NATIVE_DEPTH - TRACK_AFTER;
			if (trackFromStart) {
				tracking = true;
				if (stack === null) stack = blankList();
			}
			try {
				var json = stringify(value, replacer);
				if (json === undefined || !marked) return json;
				var result = [json, leaves];
				return result;
			} finally {
				leaves = null;
				top = null;
				opened = null;
				if (stack !== null && stack.length > 0) stack.length = 0;
			}
		}

		return run;
	}

	var idlePass = null;

	function fastPass(value, functionsCross, trackFromStart) {
		var run = idlePass;
		idlePass = null;
		if (run === null) run = makePass();
		try {
			return run(value, functionsCross, trackFromStart);
		} finally {
			idlePass = run;
		}
	}

	var ownNames = Object.getOwnPropertyNames;

	// QuickJS's native JSON.stringify tracks the values it is inside on an ordinary array, so an
	// index accessor a script defines on Array.prototype or Object.prototype would receive them.
	// Array.prototype is itself an array, so any index key on it shows in its length; own keys list
	// array indices first, so the first of Object.prototype's names settles the other.
	function nativeStringifySafe() {
		if (ArrayProto.length !== 0) return false;
		var first = ownNames(ObjectProto)[0];
		return first === undefined || !(first[0] >= "0" && first[0] <= "9");
	}

	function encode(value, copyNamed, functionsCross) {
		var named = copyNamed === true && needsNamed(value);
		if (!named && nativeStringifySafe()) {
			var crossed;
			var stopped = false;
			try {
				crossed = fastPass(value, functionsCross, false);
			} catch (error) {
				stopped = true;
				if (isCircular(error)) {
					try {
						crossed = fastPass(value, functionsCross, true);
						stopped = false;
					} catch (again) {
						stopped = true;
					}
				}
			}
			if (!stopped && crossed !== undefined) return crossed;
		}
		var tape = blankTape();
		var prepared = prepare("", value);
		if (typeof prepared === "symbol") prepared = undefined;
		try {
			walk(tape, prepared, named ? value : null, functionsCross);
		} catch (error) {
			if (error === DEEP) return [TOO_DEEP];
			throw error;
		}
		return finish(tape);
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

	function readText(state) {
		var length = state.numbers[state.numberAt++];
		var value = slice(state.text, state.textAt, state.textAt + length);
		state.textAt += length;
		return value;
	}

	function decode(buffer, text) {
		var head = new Float64(buffer, 0, 2);
		var codeCount = head[0];
		var numberCount = head[1];
		var numbers = new Float64(buffer, 16, numberCount);
		var codes = new Uint8(buffer, 16 + numberCount * 8, codeCount);
		var state = create(null);
		state.numbers = numbers;
		state.text = text === undefined ? "" : text;
		state.textAt = 0;
		state.numberAt = 0;
		var leafAt = 2;
		var leaves = arguments;
		var frames = blankStack();
		var result;
		var at = 0;
		while (at < codeCount) {
			var kind = codes[at++];
			var value;
			switch (kind) {
				case 123:
				case 91: {
					var frame = create(null);
					frame.target = kind === 91 ? [] : {};
					frame.array = kind === 91;
					frame.length = 0;
					frame.key = null;
					frames[frames.count++] = frame;
					continue;
				}
				case 125:
				case 93:
					value = frames[frames.count - 1].target;
					frames.count -= 1;
					break;
				case 100: value = numbers[state.numberAt++]; break;
				case 115: value = readText(state); break;
				case 98: value = BigIntOf(readText(state)); break;
				case 121: value = SymbolOf(readText(state)); break;
				case 89: value = SymbolOf(); break;
				case 119: value = readUnits(state, numbers[state.numberAt++]); break;
				case 99: value = frames[frames.count - numbers[state.numberAt++]].target; break;
				case 117: value = undefined; break;
				case 110: value = null; break;
				case 116: value = true; break;
				case 102: value = false; break;
				case 70: value = leaves[leafAt++]; break;
				default: throw new Refusal("unreadable value crossing");
			}
			if (frames.count === 0) {
				result = value;
				continue;
			}
			var top = frames[frames.count - 1];
			if (top.array) {
				place(top.target, top.length++, value);
			} else if (top.key === null) {
				top.key = value;
			} else {
				place(top.target, top.key, value);
				top.key = null;
			}
		}
		return result;
	}

	return [encode, decode, codeUnits, parseJson];
})()`;

interface CrossingHelpers {
	encode: QuickJSHandle;
	decode: QuickJSHandle;
	codeUnits: QuickJSHandle;
	parseJson: QuickJSHandle;
	/** The prefix of every marker string this context's `encode` writes. */
	mark: string;
}

const helpersByContext = new WeakMap<Context, CrossingHelpers>();

/** A NUL and 16 random bytes in hex: unguessable to a script, so no script string can pose as a marker. */
function freshMark(): string {
	const bytes = new Uint8Array(16);
	const random = (globalThis as { crypto?: { getRandomValues?: (array: Uint8Array) => Uint8Array } }).crypto;
	if (random?.getRandomValues) random.getRandomValues(bytes);
	else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
	let hex = "";
	for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
	return `\u0000${hex}`;
}

function crossingFor(context: Context): CrossingHelpers {
	let helpers = helpersByContext.get(context);
	if (!helpers) {
		const mark = freshMark();
		const triple = context.unwrapResult(context.evalCode(crossingSource(mark), "xript-crossing.js"));
		try {
			helpers = {
				encode: context.getProp(triple, 0),
				decode: context.getProp(triple, 1),
				codeUnits: context.getProp(triple, 2),
				parseJson: context.getProp(triple, 3),
				mark,
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
const BIGINT = 98;
const CYCLE = 99;
const SYMBOL = 121;
const BARE_SYMBOL = 89;
const UNITS = 119;
const LEAF = 70;
const ARRAY_START = 91;
const ARRAY_END = 93;
const OBJECT_START = 123;
const OBJECT_END = 125;
const MARKED_NAN = 110;
const MARKED_INFINITY = 105;
const MARKED_NEGATIVE_INFINITY = 106;
const MARKED_NEGATIVE_ZERO = 122;
const MARKED_LEAF = 102;

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

/** Thrown on the host when a value cannot cross the boundary; a binding call names itself in front of it. */
export class CrossingRefusal extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CrossingRefusal";
	}
}

/** A host value on its way in, spelled as a tape (see `crossingSource`). */
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

	bigint(value: bigint): void {
		const digits = String(value);
		this.codes.push(BIGINT);
		this.numbers.push(digits.length);
		this.texts.push(digits);
	}

	/** A symbol crosses as a fresh one with the same description. */
	symbol(value: symbol): void {
		const description = value.description;
		if (description === undefined) {
			this.codes.push(BARE_SYMBOL);
			return;
		}
		if (!cStringSafe(description)) {
			this.codes.push(BARE_SYMBOL);
			return;
		}
		this.codes.push(SYMBOL);
		this.numbers.push(description.length);
		this.texts.push(description);
	}

	/** A reference to the container `up` levels above, 1 being the one holding it. */
	cycle(up: number): void {
		this.codes.push(CYCLE);
		this.numbers.push(up);
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
	/**
	 * Receives the error, and owns it, when reading the value threw inside the sandbox: a
	 * budget interrupt, or a getter's own throw. Without it the error is raised on the host.
	 */
	onStopped?: (error: QuickJSHandle) => void;
}

/**
 * Reads a sandbox value for the host with JavaScript values intact at every depth. The caller
 * keeps ownership of `handle`; every handle this creates is released before it returns. A value
 * that cannot cross throws a `CrossingRefusal`.
 */
export function readFromQuickJS(context: Context, handle: QuickJSHandle, options: ReadOptions = {}): unknown {
	const kind = context.typeof(handle);
	if (kind === "function") {
		return options.onFunction ? options.onFunction(handle.dup(), [...(options.path ?? [])]) : null;
	}
	if (kind === "string") return readString(context, handle);
	if (kind === "symbol") return readSymbol(context, handle);
	if (kind !== "object") return context.dump(handle);
	if (context.sameValue(handle, context.null)) return null;
	return walk(context, handle, options);
}

function readSymbol(context: Context, handle: QuickJSHandle): symbol {
	const description = context.getProp(handle, "description");
	try {
		return context.typeof(description) === "string" ? Symbol(context.getString(description)) : Symbol();
	} finally {
		description.dispose();
	}
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

function raiseFromSandbox(context: Context, error: QuickJSHandle): never {
	const dumped = context.dump(error) as { name?: unknown; message?: unknown } | unknown;
	error.dispose();
	if (dumped !== null && typeof dumped === "object") {
		const record = dumped as { name?: unknown; message?: unknown };
		const failure = new Error(typeof record.message === "string" ? record.message : String(record.message));
		if (typeof record.name === "string") failure.name = record.name;
		throw failure;
	}
	throw new Error(String(dumped));
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
		if (options.onStopped) {
			options.onStopped(result.error);
			return undefined;
		}
		raiseFromSandbox(context, result.error);
	}

	const tape = result.value;
	try {
		if (context.typeof(tape) === "string") return JSON.parse(context.getString(tape));
		const bufferHandle = context.getProp(tape, 0);
		let bytes: ArrayBuffer;
		try {
			if (context.typeof(bufferHandle) === "string") {
				const leavesHandle = context.getProp(tape, 1);
				try {
					if (context.typeof(leavesHandle) === "undefined") throw new CrossingRefusal(context.getString(bufferHandle));
					const leaves = context.typeof(leavesHandle) === "object" && !context.sameValue(leavesHandle, context.null) ? leavesHandle : null;
					return new MarkReader(context, helpers.mark, leaves, options).read(JSON.parse(context.getString(bufferHandle)));
				} finally {
					leavesHandle.dispose();
				}
			}
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

/**
 * Turns the marker strings in parsed JSON back into the values they stand for (see
 * `crossingSource`), in place, keeping every key where it was.
 */
class MarkReader {
	private readonly path: PathStep[];
	private readonly ancestors: object[] = [];

	constructor(
		private readonly context: Context,
		private readonly mark: string,
		private readonly leaves: QuickJSHandle | null,
		private readonly options: ReadOptions,
	) {
		this.path = [...(options.path ?? [])];
	}

	read(value: unknown): unknown {
		if (typeof value === "string") return value.startsWith(this.mark) ? this.marked(value) : value;
		if (value === null || typeof value !== "object") return value;
		this.ancestors.push(value);
		if (Array.isArray(value)) {
			for (let i = 0; i < value.length; i++) {
				const item = value[i];
				if (item === null || (typeof item !== "object" && typeof item !== "string")) continue;
				this.path.push(i);
				const read = this.read(item);
				this.path.pop();
				if (read !== item) value[i] = read;
			}
		} else {
			const record = value as Record<string, unknown>;
			for (const key of Object.keys(record)) {
				const item = record[key];
				if (item === null || (typeof item !== "object" && typeof item !== "string")) continue;
				this.path.push(key);
				const read = this.read(item);
				this.path.pop();
				if (read === item) continue;
				if (key === "__proto__") Object.defineProperty(record, key, { value: read, writable: true, enumerable: true, configurable: true });
				else record[key] = read;
			}
		}
		this.ancestors.pop();
		return value;
	}

	private marked(spelled: string): unknown {
		const body = spelled.slice(this.mark.length + 1);
		switch (spelled.charCodeAt(this.mark.length)) {
			case UNDEFINED:
				return undefined;
			case MARKED_NAN:
				return NaN;
			case MARKED_INFINITY:
				return Infinity;
			case MARKED_NEGATIVE_INFINITY:
				return -Infinity;
			case MARKED_NEGATIVE_ZERO:
				return -0;
			case BIGINT:
				return BigInt(body);
			case CYCLE:
				return this.ancestors[this.ancestors.length - Number(body)];
			case MARKED_LEAF: {
				const handle = this.context.getProp(this.leaves as QuickJSHandle, Number(body));
				if (!this.options.onFunction) {
					handle.dispose();
					return null;
				}
				return this.options.onFunction(handle, [...this.path]);
			}
			default:
				throw new Error(`xript: unreadable value crossing (marker ${spelled.charAt(this.mark.length)})`);
		}
	}
}

class TapeReader {
	private at = 0;
	private textAt = 0;
	private numberAt = 0;
	private leafAt = 0;
	private readonly path: PathStep[];
	private readonly ancestors: object[] = [];

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
			case TEXT:
				return this.spelling();
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
			case BIGINT:
				return BigInt(this.spelling());
			case CYCLE:
				return this.ancestors[this.ancestors.length - this.numbers[this.numberAt++]];
			case LEAF:
				return this.fn();
			default:
				throw new Error(`xript: unreadable value crossing (shape code ${code})`);
		}
	}

	private spelling(): string {
		const length = this.numbers[this.numberAt++];
		const value = this.text.slice(this.textAt, this.textAt + length);
		this.textAt += length;
		return value;
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
		this.ancestors.push(out);
		while (this.codes[this.at] !== ARRAY_END) {
			this.path.push(out.length);
			try {
				out.push(this.read());
			} finally {
				this.path.pop();
			}
		}
		this.ancestors.pop();
		this.at++;
		return out;
	}

	private object(): Record<string, unknown> {
		const out: Record<string, unknown> = {};
		this.ancestors.push(out);
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
		this.ancestors.pop();
		this.at++;
		return out;
	}
}
