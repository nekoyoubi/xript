(function (host) {
	"use strict";
	var token = host.token;
	var callerOf = host.caller;
	var enter = host.enter;
	var leave = host.leave;
	var satisfies = host.satisfies;
	var peer = host.peer || null;
	var parse = JSON.parse;
	var stringify = JSON.stringify;
	var objectKeys = Object.keys;
	var freeze = Object.freeze;
	var define = Object.defineProperty;
	var hasOwn = Object.prototype.hasOwnProperty;
	var isArray = Array.isArray;
	var PromiseCtor = Promise;

	var ID_GRAMMAR = /^[a-z][a-z0-9.-]*$/;
	var VARIABLE_SEGMENT = /^<[A-Za-z_][A-Za-z0-9_]*>$/;
	var ENTRY_FIELDS = ["id", "description", "payload", "capability", "emit", "pattern", "addressed", "keys"];
	var SKIPPED = { ran: false };
	var SPECIAL_KEY = "$xript";
	var SPECIAL_VALUES = { "undefined": undefined, "NaN": NaN, "Infinity": Infinity, "-Infinity": -Infinity, "-0": -0 };
	var encode = typeof host.encode === "function" ? host.encode : null;
	var DECIMAL = /^-?[0-9]+$/;
	var BigIntCtor = typeof BigInt === "function" ? BigInt : null;
	var SymbolCtor = Symbol;
	var fromCharCode = String.fromCharCode;
	var BindingErrorCtor = typeof BindingError === "function" ? BindingError : null;
	var CapabilityDeniedErrorCtor = typeof CapabilityDeniedError === "function" ? CapabilityDeniedError : null;
	var reflectApply = Reflect.apply;
	var create = Object.create;
	var setPrototypeOf = Object.setPrototypeOf;
	var ErrorCtor = Error;
	var arrayIndexOf = Array.prototype.indexOf;
	var arraySort = Array.prototype.sort;
	var arrayJoin = Array.prototype.join;
	var stringIndexOf = String.prototype.indexOf;
	var stringSlice = String.prototype.slice;
	var regexpExec = RegExp.prototype.exec;
	var promiseResolve = Promise.resolve;
	var promiseReject = Promise.reject;

	function hasOwnKey(object, key) {
		return reflectApply(hasOwn, object, [key]);
	}

	function own(object, key) {
		return object !== null && typeof object === "object" && hasOwnKey(object, key) ? object[key] : undefined;
	}

	function put(object, key, value) {
		define(object, key, { value: value, writable: true, enumerable: true, configurable: true });
	}

	function append(list, value) {
		put(list, list.length, value);
	}

	function bareList() {
		var list = [];
		setPrototypeOf(list, null);
		return list;
	}

	function copyList(list) {
		var out = bareList();
		for (var i = 0; i < list.length; i++) out[out.length] = list[i];
		return out;
	}

	function mapList(list, each) {
		var out = [];
		for (var i = 0; i < list.length; i++) append(out, each(list[i]));
		return out;
	}

	function removeAt(list, index) {
		for (var i = index; i + 1 < list.length; i++) list[i] = list[i + 1];
		list.length -= 1;
	}

	function indexIn(list, value) {
		return reflectApply(arrayIndexOf, list, [value]);
	}

	function sorted(list, compare) {
		return reflectApply(arraySort, list, [compare]);
	}

	function test(pattern, text) {
		return reflectApply(regexpExec, pattern, [text]) !== null;
	}

	function splitDots(text) {
		var parts = bareList();
		var start = 0;
		for (var i = 0; i <= text.length; i++) {
			if (i === text.length || text[i] === ".") {
				parts[parts.length] = reflectApply(stringSlice, text, [start, i]);
				start = i + 1;
			}
		}
		return parts;
	}

	function bare(value) {
		if (value === null || typeof value !== "object" || isArray(value)) return value;
		var out = create(null);
		var keys = objectKeys(value);
		for (var i = 0; i < keys.length; i++) out[keys[i]] = value[keys[i]];
		return out;
	}

	function parseBare(text) {
		return parse(text, function (key, value) { return bare(value); });
	}

	var local = blankState();
	var handlers = create(null);

	function blankState() {
		return { catalogue: [], byEvent: create(null), subscriptions: create(null), spent: create(null), claims: [], sequence: 0, seeded: false };
	}

	function filled(state) {
		var blank = blankState();
		var fields = objectKeys(blank);
		for (var i = 0; i < fields.length; i++) {
			if (state[fields[i]] === undefined) state[fields[i]] = blank[fields[i]];
		}
		return state;
	}

	function view(read) {
		if (peer === null) return read(local);
		return read(filled(parseBare(peer.read()).state));
	}

	function mutate(change) {
		if (peer === null) return change(local);
		for (;;) {
			var box = parseBare(peer.read());
			var state = filled(box.state);
			var result = change(state);
			if (peer.write(box.version, stringify(state))) return result;
		}
	}

	function bindingError(binding, message) {
		if (BindingErrorCtor) return new BindingErrorCtor(binding, message);
		var error = new ErrorCtor(binding + "(): " + message);
		put(error, "name", "BindingError");
		put(error, "binding", binding);
		return error;
	}

	function capabilityError(binding, capability) {
		if (CapabilityDeniedErrorCtor) return new CapabilityDeniedErrorCtor(binding, capability);
		var error = new ErrorCtor(binding + "() requires the \"" + capability + "\" capability, which hasn't been granted to this script. Ask the app developer to enable it.");
		put(error, "name", "CapabilityDeniedError");
		put(error, "binding", binding);
		put(error, "capability", capability);
		return error;
	}

	function copy(value) {
		return value === undefined ? undefined : parse(stringify(value));
	}

	function isPlainObject(value) {
		return value !== null && typeof value === "object" && !isArray(value);
	}

	function isVariableSegment(segment) {
		return segment.length > 2 && segment[0] === "<" && segment[segment.length - 1] === ">";
	}

	function isConcrete(id) {
		if (reflectApply(stringIndexOf, id, ["<"]) === -1) return true;
		var segments = splitDots(id);
		for (var i = 0; i < segments.length; i++) {
			if (isVariableSegment(segments[i])) return false;
		}
		return true;
	}

	function isShape(id) {
		if (typeof id !== "string") return false;
		var segments = splitDots(id);
		for (var i = 0; i < segments.length; i++) {
			if (test(VARIABLE_SEGMENT, segments[i])) segments[i] = "x";
		}
		return test(ID_GRAMMAR, reflectApply(arrayJoin, segments, ["."]));
	}

	function shapeMatches(shape, id) {
		var want = splitDots(shape);
		var got = splitDots(id);
		if (want.length !== got.length) return false;
		for (var i = 0; i < want.length; i++) {
			if (isVariableSegment(want[i])) {
				if (got[i].length === 0) return false;
				continue;
			}
			if (want[i] !== got[i]) return false;
		}
		return true;
	}

	function resolveIn(catalogue, id) {
		var i;
		for (i = 0; i < catalogue.length; i++) {
			if (catalogue[i].entry.id === id) return catalogue[i];
		}
		for (i = 0; i < catalogue.length; i++) {
			var entry = catalogue[i].entry;
			if (entry.pattern === true && shapeMatches(entry.id, id)) return catalogue[i];
			var addressed = entry.addressed || [];
			for (var j = 0; j < addressed.length; j++) {
				if (shapeMatches(addressed[j], id)) return catalogue[i];
			}
		}
		return null;
	}

	function resolve(id) {
		return view(function (state) { return resolveIn(state.catalogue, id); });
	}

	function requireId(binding, id) {
		if (typeof id !== "string" || id.length === 0) {
			throw bindingError(binding, "the event id must be a non-empty string");
		}
	}

	function resolveConcrete(binding, id) {
		requireId(binding, id);
		if (!isConcrete(id)) {
			throw bindingError(binding, "'" + id + "' is a family shape, not an event; use a concrete id such as one with every <segment> filled in");
		}
		var record = resolve(id);
		if (record === null) {
			throw bindingError(binding, "event '" + id + "' is not declared by the host");
		}
		return record;
	}

	function argsFor(args) {
		if (args.length === 1 && isPlainObject(args[0])) {
			var payload = args[0];
			var keys = objectKeys(payload);
			var values = bareList();
			for (var i = 0; i < keys.length; i++) values[i] = payload[keys[i]];
			return values;
		}
		return args;
	}

	function matches(match, args) {
		var keys = objectKeys(match);
		if (keys.length === 0) return true;
		if (args.length !== 1 || !isPlainObject(args[0])) return false;
		for (var i = 0; i < keys.length; i++) {
			if (args[0][keys[i]] !== match[keys[i]]) return false;
		}
		return true;
	}

	function detachIn(state, subscriptionToken) {
		var subscription = state.subscriptions[subscriptionToken];
		if (!subscription) return;
		if (isMine(subscription)) delete handlers[subscriptionToken];
		delete state.subscriptions[subscriptionToken];
		var list = state.byEvent[subscription.event];
		if (!list) return;
		var index = indexIn(list, subscriptionToken);
		if (index !== -1) removeAt(list, index);
		if (list.length === 0) delete state.byEvent[subscription.event];
	}

	function isMine(subscription) {
		return peer === null || subscription.worker === peer.self;
	}

	function serve(subscriptionToken, args) {
		var held = handlers[subscriptionToken];
		if (!held) return SKIPPED;
		var subscription = view(function (state) { return state.subscriptions[subscriptionToken] || null; });
		if (subscription === null) {
			delete handlers[subscriptionToken];
			return SKIPPED;
		}
		if (held.match !== null && !matches(held.match, args)) return SKIPPED;
		if (subscription.once) {
			var claimed = mutate(function (state) {
				if (!state.subscriptions[subscriptionToken]) return false;
				detachIn(state, subscriptionToken);
				state.spent[subscriptionToken] = true;
				return true;
			});
			delete handlers[subscriptionToken];
			if (!claimed) return SKIPPED;
		}
		var value;
		enter(subscription.owner);
		try {
			value = reflectApply(held.handler, undefined, argsFor(args));
		} catch (error) {
			value = undefined;
		} finally {
			leave();
		}
		return { ran: true, owner: subscription.owner, value: value };
	}

	function marker(key, tag) {
		var crossing = {};
		put(crossing, key, tag);
		return crossing;
	}

	function crossingReplacer(key, value) {
		if (value === undefined) return marker(SPECIAL_KEY, "undefined");
		if (typeof value === "number") {
			if (value !== value) return marker(SPECIAL_KEY, "NaN");
			if (value === Infinity) return marker(SPECIAL_KEY, "Infinity");
			if (value === -Infinity) return marker(SPECIAL_KEY, "-Infinity");
			if (value === 0 && 1 / value < 0) return marker(SPECIAL_KEY, "-0");
		}
		if (typeof value === "function") return marker(SPECIAL_KEY, "undefined");
		return value;
	}

	function toCrossing(value) {
		return stringify(value, crossingReplacer);
	}

	function specialOf(value) {
		if (!isPlainObject(value)) return null;
		var keys = objectKeys(value);
		if (keys.length !== 1 || keys[0] !== SPECIAL_KEY) return null;
		var tag = value[SPECIAL_KEY];
		if (typeof tag !== "string" || !hasOwnKey(SPECIAL_VALUES, tag)) return null;
		return { value: SPECIAL_VALUES[tag] };
	}

	function fromJson(value) {
		var special = specialOf(value);
		if (special !== null) return special.value;
		if (value === null || typeof value !== "object") return value;
		var keys = objectKeys(value);
		for (var i = 0; i < keys.length; i++) {
			var child = value[keys[i]];
			if (child === null || typeof child !== "object") continue;
			define(value, keys[i], { value: fromJson(child), writable: true, enumerable: true, configurable: true });
		}
		return value;
	}

	function allUnits(units) {
		for (var i = 0; i < units.length; i++) {
			var unit = units[i];
			if (typeof unit !== "number" || unit < 0 || unit > 0xffff || unit % 1 !== 0) return false;
		}
		return true;
	}

	function fromUnits(units) {
		var text = "";
		for (var i = 0; i < units.length; i++) text += fromCharCode(units[i]);
		return text;
	}

	function markerOf(value, ancestors) {
		if (isArray(value) || !hasOwnKey(value, SPECIAL_KEY)) return null;
		var tag = value[SPECIAL_KEY];
		if (typeof tag !== "string") return null;
		var size = objectKeys(value).length;
		if (size === 1 && hasOwnKey(SPECIAL_VALUES, tag)) return { value: SPECIAL_VALUES[tag] };
		if (size === 1 && tag === "symbol") return { value: SymbolCtor() };
		if (size !== 2) return null;
		if (tag === "bigint" && BigIntCtor !== null && typeof value.value === "string" && test(DECIMAL, value.value)) {
			return { value: BigIntCtor(value.value) };
		}
		if (tag === "symbol" && typeof value.description === "string") return { value: SymbolCtor(value.description) };
		if (tag === "string" && isArray(value.units) && allUnits(value.units)) return { value: fromUnits(value.units) };
		if (tag === "cycle" && typeof value.up === "number" && value.up % 1 === 0 && value.up >= 1 && value.up <= ancestors.length) {
			return { value: ancestors[ancestors.length - value.up].node };
		}
		return null;
	}

	function leafOf(leaf, ancestors) {
		if (leaf === null || typeof leaf !== "object") return leaf;
		var found = markerOf(leaf, ancestors);
		return found === null ? leaf : found.value;
	}

	function fromTape(tape) {
		var ancestors = [];
		var root;
		var key = null;
		for (var i = 0; i < tape.length; i++) {
			var token = tape[i];
			var op = token[0];
			if (op === "k") {
				key = token[1];
				continue;
			}
			if (op === "e") {
				ancestors.length -= 1;
				continue;
			}
			var opened = op === "a" ? [] : op === "o" ? {} : null;
			var value = opened !== null ? opened : leafOf(token[1], ancestors);
			if (ancestors.length === 0) {
				root = value;
			} else {
				var holder = ancestors[ancestors.length - 1].node;
				var slot = isArray(holder) ? holder.length : key;
				define(holder, slot, { value: value, writable: true, enumerable: true, configurable: true });
			}
			if (opened !== null) ancestors[ancestors.length] = { node: opened };
		}
		return root;
	}

	function fromWire(value) {
		return encode === null ? fromJson(value) : fromTape(value);
	}

	function argsFromWire(list) {
		if (encode === null) return fromJson(list);
		var args = [];
		for (var i = 0; i < list.length; i++) args[i] = fromTape(list[i]);
		return args;
	}

	function requestText(subscriptionToken, args) {
		if (encode === null) return toCrossing({ token: subscriptionToken, args: args });
		var parts = [];
		for (var i = 0; i < args.length; i++) append(parts, encode(args[i]));
		return '{"token":' + stringify(subscriptionToken) + ',"args":[' + reflectApply(arrayJoin, parts, [","]) + "]}";
	}

	function outcomeText(owner, encodedValue) {
		return '{"ran":true,"owner":' + stringify(owner === undefined ? null : owner) + ',"value":' + encodedValue + "}";
	}

	function encodeOutcome(outcome) {
		if (!outcome.ran) return stringify({ ran: false });
		if (encode === null) {
			try {
				return toCrossing({ ran: true, owner: outcome.owner, value: outcome.value });
			} catch (error) {
				return toCrossing({ ran: true, owner: outcome.owner, value: undefined });
			}
		}
		var encodedValue;
		try {
			encodedValue = encode(outcome.value);
		} catch (error) {
			encodedValue = encode(undefined);
		}
		return outcomeText(outcome.owner, encodedValue);
	}

	function decodeOutcome(outcome) {
		if (!own(outcome, "ran")) return SKIPPED;
		return { ran: true, owner: own(outcome, "owner"), value: fromWire(own(outcome, "value")) };
	}

	function serveRequest(request) {
		peer.reply(own(request, "id"), encodeOutcome(serve(own(request, "token"), argsFromWire(own(request, "args")))));
	}

	function spin() {
		for (;;) {}
	}

	function deliverRemote(worker, subscriptionToken, args) {
		var ticket = peer.call(worker, requestText(subscriptionToken, args));
		for (;;) {
			var message = peer.poll(ticket);
			if (message === null) continue;
			if (message === "stop") spin();
			var parsed = parse(message);
			if (own(parsed, "done")) return decodeOutcome(own(parsed, "outcome"));
			serveRequest(own(parsed, "serve"));
		}
	}

	function deliver(subscriptionToken, args) {
		var subscription = view(function (state) { return state.subscriptions[subscriptionToken] || null; });
		if (subscription === null) return SKIPPED;
		if (isMine(subscription)) return serve(subscriptionToken, args);
		return deliverRemote(subscription.worker, subscriptionToken, args);
	}

	var sessions = Object.create(null);
	var sessionSequence = 0;

	function stepSession(session) {
		while (session.index < session.snapshot.length) {
			var subscriptionToken = session.snapshot[session.index];
			var subscription = view(function (state) { return state.subscriptions[subscriptionToken] || null; });
			if (subscription !== null && !isMine(subscription)) {
				return stringify({ remote: subscription.worker, request: requestText(subscriptionToken, session.args) });
			}
			var outcome = subscription === null ? SKIPPED : serve(subscriptionToken, session.args);
			if (outcome.ran) session.results[session.results.length] = { owner: outcome.owner, value: outcome.value };
			session.index += 1;
		}
		return stringify({ done: true });
	}

	function listenersOf(id) {
		return view(function (state) { return copyList(state.byEvent[id] || []); });
	}

	function dispatch(id, args) {
		var snapshot = listenersOf(id);
		var results = bareList();
		for (var i = 0; i < snapshot.length; i++) {
			var outcome = deliver(snapshot[i], args);
			if (outcome.ran) results[results.length] = { owner: outcome.owner, value: outcome.value };
		}
		return results;
	}

	function valuesOf(results) {
		return mapList(results, function (result) { return result.value; });
	}

	function requireModEmit(binding, id) {
		var record = resolveConcrete(binding, id);
		if (record.entry.emit !== "mods") {
			throw bindingError(binding, "event '" + id + "' is emitted by the host only; a mod may emit an event declared with \"emit\": \"mods\"");
		}
	}

	function dispatchAwaiting(id, args) {
		var session = {
			snapshot: listenersOf(id),
			args: args,
			index: 0,
			results: bareList(),
		};
		return new PromiseCtor(function (resolve, reject) {
			function walk() {
				try {
					var step = parse(stepSession(session));
					if (own(step, "done")) {
						resolve(valuesOf(session.results));
						return;
					}
					peer.ask(own(step, "remote"), own(step, "request"), answered);
				} catch (error) {
					reject(error);
				}
			}
			function answered(message) {
				if (message === "stop") {
					reject(bindingError("events.emitAsync", "the call's budget ran out while a handler on another worker was answering"));
					return;
				}
				try {
					var outcome = decodeOutcome(parse(message));
					if (outcome.ran) session.results[session.results.length] = { owner: outcome.owner, value: outcome.value };
					session.index += 1;
				} catch (error) {
					reject(error);
					return;
				}
				walk();
			}
			walk();
		});
	}

	function cancelToken(subscriptionToken) {
		var key = isPlainObject(subscriptionToken) ? subscriptionToken.id : subscriptionToken;
		if (typeof key !== "string") {
			throw bindingError("events.cancel", "expected a subscription id or the object events.on returned");
		}
		var caller = callerOf();
		var mayCancelOthers = null;
		return mutate(function (state) {
			var subscription = state.subscriptions[key];
			if (subscription) {
				if (subscription.owner !== caller) {
					if (mayCancelOthers === null) mayCancelOthers = satisfies("events.off");
					if (!mayCancelOthers) throw capabilityError("events.cancel", "events.off");
				}
				detachIn(state, key);
				return { cancelled: true, spent: false };
			}
			return { cancelled: false, spent: state.spent[key] === true };
		});
	}

	function subscribe(binding, once) {
		return function (id, handler, options) {
			var record = resolveConcrete(binding, id);
			if (typeof handler !== "function") {
				throw bindingError(binding, "expected a handler function");
			}
			var capability = record.entry.capability;
			if (typeof capability === "string" && !satisfies(capability)) {
				throw capabilityError(binding, capability);
			}
			var match = null;
			if (options !== undefined && options !== null) {
				if (!isPlainObject(options)) {
					throw bindingError(binding, "options must be an object");
				}
				if (options.match !== undefined) {
					if (!isPlainObject(options.match)) {
						throw bindingError(binding, "options.match must be an object of payload keys to values");
					}
					match = create(null);
					var keys = objectKeys(options.match);
					var declared = own(record.entry, "keys");
					for (var i = 0; i < keys.length; i++) {
						if (isArray(declared) && indexIn(declared, keys[i]) === -1) {
							throw bindingError(binding, "match key '" + keys[i] + "' is not one of the payload keys event '" + id + "' declares");
						}
						match[keys[i]] = options.match[keys[i]];
					}
				}
			}
			var owner = callerOf();
			var live = null;
			var subscriptionToken = mutate(function (state) {
				state.sequence += 1;
				var issued = "sub-" + state.sequence;
				state.subscriptions[issued] = { token: issued, event: id, owner: owner, once: once, worker: peer === null ? null : peer.self };
				append(state.byEvent[id] || (state.byEvent[id] = []), issued);
				live = state.subscriptions;
				return issued;
			});
			if (peer !== null) forgetCancelled(live);
			handlers[subscriptionToken] = { handler: handler, match: match };
			return freeze({
				id: subscriptionToken,
				event: id,
				cancel: function () { return cancelToken(subscriptionToken); },
			});
		};
	}

	function forgetCancelled(live) {
		var held = objectKeys(handlers);
		for (var i = 0; i < held.length; i++) {
			if (!live[held[i]]) delete handlers[held[i]];
		}
	}

	function cancelOwnedBy(owner) {
		return mutate(function (state) {
			var count = 0;
			var tokens = objectKeys(state.subscriptions);
			for (var i = 0; i < tokens.length; i++) {
				if (state.subscriptions[tokens[i]].owner === owner) {
					detachIn(state, tokens[i]);
					count += 1;
				}
			}
			return count;
		});
	}

	function covers(prefix, id) {
		if (id === prefix) return true;
		if (reflectApply(stringIndexOf, id, [prefix]) !== 0) return false;
		return prefix[prefix.length - 1] === "." || id[prefix.length] === ".";
	}

	function sortedClaims() {
		return sorted(view(function (state) { return copyList(state.claims); }), function (a, b) {
			if (a.prefix.length !== b.prefix.length) return b.prefix.length - a.prefix.length;
			return a.prefix < b.prefix ? -1 : a.prefix > b.prefix ? 1 : 0;
		});
	}

	function hasVariableSegment(id) {
		return !isConcrete(id);
	}

	function validateEntry(binding, entry) {
		if (!isPlainObject(entry)) throw bindingError(binding, "expected an event entry object");
		var fields = objectKeys(entry);
		for (var i = 0; i < fields.length; i++) {
			if (indexIn(ENTRY_FIELDS, fields[i]) === -1) {
				throw bindingError(binding, "unknown field '" + fields[i] + "' in the event entry");
			}
		}
		if (!isShape(entry.id)) {
			throw bindingError(binding, "'id' must be an event id (lowercase letters, digits, '.' and '-', starting with a letter); a pattern id may also write a whole '.' segment as <name>");
		}
		if (typeof entry.description !== "string" || entry.description.length === 0) {
			throw bindingError(binding, "'description' must be a non-empty string");
		}
		if (entry.emit !== undefined && entry.emit !== "host" && entry.emit !== "mods") {
			throw bindingError(binding, "'emit' must be \"host\" or \"mods\"");
		}
		if (entry.pattern !== undefined && typeof entry.pattern !== "boolean") {
			throw bindingError(binding, "'pattern' must be a boolean");
		}
		if (entry.pattern === true && !hasVariableSegment(entry.id)) {
			throw bindingError(binding, "a pattern id needs at least one <segment>");
		}
		if (entry.pattern !== true && hasVariableSegment(entry.id)) {
			throw bindingError(binding, "an id with a <segment> must declare \"pattern\": true");
		}
		if (entry.capability !== undefined && typeof entry.capability !== "string") {
			throw bindingError(binding, "'capability' must be a string");
		}
		var lists = ["addressed", "keys"];
		for (var j = 0; j < lists.length; j++) {
			var list = entry[lists[j]];
			if (list === undefined) continue;
			if (!isArray(list)) throw bindingError(binding, "'" + lists[j] + "' must be an array of strings");
			for (var k = 0; k < list.length; k++) {
				if (typeof list[k] !== "string") throw bindingError(binding, "'" + lists[j] + "' must be an array of strings");
				if (lists[j] === "addressed" && !isShape(list[k])) {
					throw bindingError(binding, "addressed form '" + list[k] + "' is not an event id shape");
				}
			}
		}
		var normalized = create(null);
		for (var f = 0; f < ENTRY_FIELDS.length; f++) {
			if (entry[ENTRY_FIELDS[f]] !== undefined) normalized[ENTRY_FIELDS[f]] = copy(entry[ENTRY_FIELDS[f]]);
		}
		return normalized;
	}

	function declare(binding, entry, party) {
		var normalized = validateEntry(binding, entry);
		return mutate(function (state) {
			for (var i = 0; i < state.catalogue.length; i++) {
				var existing = state.catalogue[i];
				if (existing.entry.id !== normalized.id) continue;
				if (existing.source === "manifest") {
					throw bindingError(binding, "event '" + normalized.id + "' is already declared by the host manifest");
				}
				if (existing.party !== party) {
					throw bindingError(binding, "event '" + normalized.id + "' is already declared by another owner");
				}
				existing.entry = normalized;
				return copy(normalized);
			}
			append(state.catalogue, { entry: normalized, source: "runtime", party: party });
			return copy(normalized);
		});
	}

	function requireToken(given) {
		if (given !== token) throw new ErrorCtor("xript event bus: host call refused");
	}

	var manifestEvents = parseBare(host.events || "[]");
	mutate(function (state) {
		if (state.seeded) return;
		state.seeded = true;
		for (var m = 0; m < manifestEvents.length; m++) {
			if (isPlainObject(manifestEvents[m]) && typeof manifestEvents[m].id === "string") {
				append(state.catalogue, { entry: manifestEvents[m], source: "manifest", party: null });
			}
		}
	});

	var on = subscribe("events.on", false);
	var events = freeze({
		on: on,
		subscribe: on,
		once: subscribe("events.once", true),
		cancel: function (subscriptionToken) {
			return cancelToken(subscriptionToken);
		},
		off: function (id) {
			requireId("events.off", id);
			if (!view(function (state) { return !!state.byEvent[id]; })) return 0;
			var everyone = satisfies("events.off");
			var caller = callerOf();
			return mutate(function (state) {
				var list = state.byEvent[id];
				if (!list) return 0;
				var dropped = 0;
				var snapshot = copyList(list);
				for (var i = 0; i < snapshot.length; i++) {
					if (everyone || state.subscriptions[snapshot[i]].owner === caller) {
						detachIn(state, snapshot[i]);
						dropped += 1;
					}
				}
				return dropped;
			});
		},
		emit: function (id, data) {
			requireModEmit("events.emit", id);
			return valuesOf(dispatch(id, data === undefined ? [] : [data]));
		},
		emitAsync: function (id, data) {
			var args = data === undefined ? [] : [data];
			try {
				requireModEmit("events.emitAsync", id);
				if (peer === null || typeof peer.ask !== "function") {
					return reflectApply(promiseResolve, PromiseCtor, [valuesOf(dispatch(id, args))]);
				}
			} catch (error) {
				return reflectApply(promiseReject, PromiseCtor, [error]);
			}
			return dispatchAwaiting(id, args);
		},
		cancelOwned: function (owner) {
			var caller = callerOf();
			if (arguments.length === 0 || owner === undefined) return cancelOwnedBy(caller);
			if (owner !== null && typeof owner !== "string") {
				throw bindingError("events.cancelOwned", "the owner must be a mod id string or null");
			}
			if (owner !== caller && !satisfies("events.off")) {
				throw capabilityError("events.cancelOwned", "events.off");
			}
			return cancelOwnedBy(owner);
		},
		claim: function (prefix) {
			if (typeof prefix !== "string" || prefix.length === 0) {
				throw bindingError("events.claim", "the prefix must be a non-empty string");
			}
			if (!satisfies("events.claim")) throw capabilityError("events.claim", "events.claim");
			var caller = callerOf();
			if (caller === null) {
				throw bindingError("events.claim", "only a mod can hold a namespace, and this code is not attributed to one");
			}
			return mutate(function (state) {
				for (var i = 0; i < state.claims.length; i++) {
					if (state.claims[i].prefix === prefix) return state.claims[i].owner === caller;
				}
				append(state.claims, { prefix: prefix, owner: caller });
				return true;
			});
		},
		namespaces: function () {
			return mapList(sortedClaims(), function (claim) { return { prefix: claim.prefix, owner: claim.owner }; });
		},
		ownerOf: function (id) {
			requireId("events.ownerOf", id);
			var ordered = sortedClaims();
			for (var i = 0; i < ordered.length; i++) {
				if (covers(ordered[i].prefix, id)) return ordered[i].owner;
			}
			return null;
		},
		declare: function (entry) {
			if (!satisfies("events.declare")) throw capabilityError("events.declare", "events.declare");
			return declare("events.declare", entry, "mod:" + callerOf());
		},
		describe: function (id) {
			requireId("events.describe", id);
			var record = resolve(id);
			return record === null ? null : copy(record.entry);
		},
		catalogue: function () {
			return view(function (state) {
				return mapList(state.catalogue, function (record) { return copy(record.entry); });
			});
		},
		names: function () {
			return sorted(view(function (state) { return objectKeys(state.byEvent); }), undefined);
		},
		listenerCount: function (id) {
			if (id === undefined) {
				return view(function (state) { return objectKeys(state.subscriptions).length; });
			}
			requireId("events.listenerCount", id);
			return view(function (state) { return state.byEvent[id] ? state.byEvent[id].length : 0; });
		},
		subscribers: function (id) {
			requireId("events.subscribers", id);
			var owners = view(function (state) {
				return mapList(state.byEvent[id] || [], function (issued) { return state.subscriptions[issued].owner; });
			});
			var counts = create(null);
			var untracked = 0;
			for (var i = 0; i < owners.length; i++) {
				if (owners[i] === null) {
					untracked += 1;
				} else {
					counts[owners[i]] = (counts[owners[i]] || 0) + 1;
				}
			}
			var named = sorted(objectKeys(counts), undefined);
			var repeated = [];
			for (var r = 0; r < named.length; r++) {
				if (counts[named[r]] > 1) append(repeated, named[r]);
			}
			return {
				event: id,
				total: owners.length,
				owners: mapList(named, function (owner) { return { owner: owner, count: counts[owner] }; }),
				repeated: repeated,
				untracked: untracked,
			};
		},
	});

	if (host.installGlobal !== false) globalThis.events = events;

	return freeze({
		emit: function (given, id, args) {
			requireToken(given);
			if (typeof id !== "string" || id.length === 0 || !isConcrete(id) || resolve(id) === null) return [];
			return dispatch(id, isArray(args) ? args : []);
		},
		cancelOwned: function (given, owner) {
			requireToken(given);
			return cancelOwnedBy(owner === undefined ? null : owner);
		},
		declare: function (given, entry) {
			requireToken(given);
			return declare("declareEvent", entry, "host");
		},
		begin: function (given, id, args) {
			requireToken(given);
			if (typeof id !== "string" || id.length === 0 || !isConcrete(id) || resolve(id) === null) return -1;
			sessionSequence += 1;
			sessions[sessionSequence] = {
				snapshot: listenersOf(id),
				args: isArray(args) ? args : [],
				index: 0,
				results: bareList(),
			};
			return sessionSequence;
		},
		step: function (given, session) {
			requireToken(given);
			return stepSession(sessions[session]);
		},
		resume: function (given, session, outcome) {
			requireToken(given);
			var held = sessions[session];
			var answered = decodeOutcome(parse(outcome));
			if (answered.ran) held.results[held.results.length] = { owner: answered.owner, value: answered.value };
			held.index += 1;
		},
		finish: function (given, session) {
			requireToken(given);
			var held = sessions[session];
			delete sessions[session];
			return held ? held.results : [];
		},
		serveInbox: function (given) {
			requireToken(given);
			if (peer === null) return 0;
			var served = 0;
			for (;;) {
				var request = peer.take();
				if (request === null) return served;
				serveRequest(parse(request));
				served += 1;
			}
		},
	});
})
