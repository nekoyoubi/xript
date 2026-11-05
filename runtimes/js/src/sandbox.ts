import type {
	QuickJSContext,
	QuickJSHandle,
	QuickJSRuntime,
	QuickJSAsyncContext,
	QuickJSAsyncRuntime,
	QuickJSWASMModule,
} from "quickjs-emscripten-core";
import type { AsyncVariant } from "./quickjs-loader.js";
import { AmbiguousExportError, BindingError, CapabilityDeniedError, CancellationError, InvokeError, ModEntryError, ImportDeniedError, ModuleUnsupportedError, LibraryUnavailableError, LibraryRegistrationError } from "./errors.js";
import { grantedSatisfies } from "./capabilities.js";
import { findImportSpecifier, findImportSpecifiers, detectCommonJS } from "./module-support.js";
import { marshalArgsToQuickJS, marshalToQuickJS, safeDispose } from "./marshal.js";
import { containFault, containSurface, guardEngineCallback, guardHostCallbacks, GUARDED_JSON_SOURCE, isExhausted, SAFE_ASYNC_STACK_BYTES, stackLimitBytes } from "./stack-guard.js";
import { CallbackScope, callbackSupportFor, configureCallbacks, functionParamChecks, functionParamViolation, readResult, releaseCallbackSupport, type CallbackSupport } from "./callbacks.js";
import { CallerContext, type CallerLane } from "./caller-context.js";
import { installConsoleSupport, readConsoleArgument, releaseConsoleSupport } from "./console-args.js";
import { DEFAULT_MAX_RETAINED_CALLBACKS } from "./retained.js";
import { retainPositions } from "./retain-positions.js";
import type { DebugOptions, DebugSession } from "./debug-types.js";
import { DebugUnsupportedError } from "./debug-types.js";
import { createDebugController, type DebugController } from "./debug-session.js";
import { instrumentSource } from "./debug-instrument.js";
import type { NodeRef } from "./fragment.js";
import { resolveCallerAware } from "./with-caller.js";
import { installEventBus, type EmitResult, type EventBus } from "./event-bus.js";
import {
	DeprecationChannel,
	SHADOWING_BUILTINS,
	UNTIMED,
	reportShadowedBindings,
	unbudgetedHandlerClock,
	type DeprecationHandler,
	type HandlerClock,
} from "./deprecations.js";
import {
	DEFINE_ACCESSOR_SOURCE,
	hostAccessorFor,
	isAccessorBinding,
	omitsBinding,
	ownMember,
	presenceProbeSource,
	providedBindingPaths,
	type HostAccessor,
} from "./presence.js";

export { missingBindingNames } from "./presence.js";

/**
 * Builds an error through the sandbox's own error factory, so it is a real instance of the
 * class a script catches it as (`BindingError`, `CapabilityDeniedError`, `TypeError`).
 * `null` when the factory is not installed or cannot run, and the caller builds a plain one.
 */
function constructError(
	context: QuickJSContext | QuickJSAsyncContext,
	kind: "binding" | "capability" | "type",
	first: string,
	second = "",
): QuickJSHandle | null {
	const factory = callbackSupportFor(context).errors;
	if (!factory?.alive) return null;
	const args = [context.newString(kind), context.newString(first), context.newString(second)];
	const result = context.callFunction(factory, context.undefined, ...args);
	for (const arg of args) arg.dispose();
	if (result.error) {
		result.error.dispose();
		return null;
	}
	return result.value;
}

function createCapabilityError(
	context: QuickJSContext | QuickJSAsyncContext,
	binding: string,
	capability: string,
): { error: QuickJSHandle } {
	const constructed = constructError(context, "capability", binding, capability);
	if (constructed) return { error: constructed };
	const err = context.newError(
		`${binding}() requires the "${capability}" capability, which hasn't been granted to this script. Ask the app developer to enable it.`,
	);
	const nameStr = context.newString("CapabilityDeniedError");
	defineValue(context, err, "name", nameStr);
	nameStr.dispose();
	const capStr = context.newString(capability);
	defineValue(context, err, "capability", capStr);
	capStr.dispose();
	const bindStr = context.newString(binding);
	defineValue(context, err, "binding", bindStr);
	bindStr.dispose();
	return { error: err };
}

function createTypeError(context: QuickJSContext | QuickJSAsyncContext, message: string): { error: QuickJSHandle } {
	return { error: constructError(context, "type", message) ?? context.newError({ name: "TypeError", message }) };
}

function createBindingError(
	context: QuickJSContext | QuickJSAsyncContext,
	binding: string,
	message: string,
): { error: QuickJSHandle } {
	const constructed = constructError(context, "binding", binding, message);
	if (constructed) return { error: constructed };
	const err = context.newError(`${binding}(): ${message}`);
	const nameStr = context.newString("BindingError");
	defineValue(context, err, "name", nameStr);
	nameStr.dispose();
	const bindStr = context.newString(binding);
	defineValue(context, err, "binding", bindStr);
	bindStr.dispose();
	return { error: err };
}

/**
 * A synchronous call (`execute`, a host-facing export invocation) runs the script to completion,
 * so a promise it ends with has not settled and has no value to hand over; the call belongs in
 * its async counterpart, which awaits it.
 */
function refusePromiseResult(context: QuickJSContext | QuickJSAsyncContext, handle: QuickJSHandle, subject = "execute()", asyncEntry = "executeAsync()"): void {
	const state = context.getPromiseState(handle);
	if (state.type === "fulfilled" && state.notAPromise) return;
	if (state.type === "fulfilled" && state.value !== handle) state.value.dispose();
	if (state.type === "rejected") state.error.dispose();
	handle.dispose();
	throw new Error(
		`${subject} returned a promise, which a synchronous call cannot await. Use ${asyncEntry}, which awaits the promise and returns what it settles to`,
	);
}

/** Reads a result for the host and releases its handle, whether or not reading it threw. */
function readAndRelease(context: QuickJSContext | QuickJSAsyncContext, handle: QuickJSHandle): unknown {
	try {
		return readResult(context, handle);
	} finally {
		if (handle.alive) handle.dispose();
	}
}

interface Manifest {
	xript: string;
	name: string;
	version?: string;
	bindings?: Record<string, Binding>;
	hooks?: Record<string, HookDef>;
	slots?: Slot[];
	capabilities?: Record<string, CapabilityDef>;
	events?: EventDef[];
	libraries?: Record<string, LibraryDef>;
	limits?: ExecutionLimits;
	types?: CallbackSupport["types"];
}

interface LibraryDef {
	description: string;
	capability?: string;
	version?: string;
	deprecated?: string;
}

interface Slot {
	id: string;
	accepts: string[];
	description?: string;
	capability?: string;
	payload?: unknown;
	limits?: { timeout_ms?: number };
}

const HOOK_SLOT_ACCEPT = "application/x-xript-hook";

function isHookSlot(slot: Slot): boolean {
	return Array.isArray(slot.accepts) && slot.accepts.includes(HOOK_SLOT_ACCEPT);
}

function effectiveHooks(manifest: Manifest): Record<string, HookDef> {
	const hooks: Record<string, HookDef> = { ...(manifest.hooks ?? {}) };
	for (const slot of manifest.slots ?? []) {
		if (!isHookSlot(slot)) continue;
		if (slot.id in hooks) continue;
		hooks[slot.id] = {
			description: slot.description ?? "",
			capability: slot.capability,
			...(slot.limits?.timeout_ms !== undefined ? { limits: { timeout_ms: slot.limits.timeout_ms } } : {}),
		};
	}
	return hooks;
}

interface EventDef {
	id: string;
	description: string;
	payload?: unknown;
	capability?: string;
}

interface HookDef {
	description: string;
	phases?: string[];
	params?: Parameter[];
	capability?: string;
	async?: boolean;
	limits?: ExecutionLimits;
	deprecated?: string;
}

type Binding = FunctionBinding | NamespaceBinding | AccessorBinding;

interface FunctionBinding {
	description: string;
	params?: Parameter[];
	returns?: unknown;
	async?: boolean;
	capability?: string;
	deprecated?: string;
	optional?: boolean;
}

interface NamespaceBinding {
	description: string;
	members: Record<string, Binding>;
	optional?: boolean;
}

interface AccessorBinding {
	description: string;
	accessor: "get" | "get-set";
	type?: unknown;
	capability?: string;
	deprecated?: string;
	optional?: boolean;
}

interface Parameter {
	name: string;
	type: unknown;
	default?: unknown;
	required?: boolean;
	optional?: boolean;
	variadic?: boolean;
}

interface CapabilityDef {
	description: string;
	risk?: string;
}

interface ExecutionLimits {
	timeout_ms?: number;
	memory_mb?: number;
	max_stack_depth?: number;
	max_retained_callbacks?: number;
}

/**
 * A function a host supplies for a declared binding.
 *
 * Parameters are `any[]` rather than `unknown[]` on purpose. Under `strictFunctionTypes`
 * parameters are contravariant, so an idiomatic typed binding — `(message: string) => void` —
 * is *not* assignable to `(...args: unknown[]) => unknown`, and every host writing typed
 * bindings had to widen them to `unknown` and narrow again inside. The scaffolded app hit this
 * on its own generated code. `any[]` accepts both shapes and still rejects a non-function;
 * arguments arrive as JSON-derived values whatever the signature claims, so the stricter type
 * was never enforcing anything a host could rely on.
 */
export type HostFunction = (...args: any[]) => unknown;
export interface HostNamespace {
	[key: string]: HostFunction | HostNamespace | HostAccessor;
}
export type HostBindings = Record<string, HostFunction | HostNamespace | HostAccessor>;
export type { HostAccessor };

export type LogSeverity = "trace" | "debug" | "info" | "warn" | "error";

export interface ConsoleHandler {
	log?: (...args: unknown[]) => void;
	info?: (...args: unknown[]) => void;
	warn?: (...args: unknown[]) => void;
	error?: (...args: unknown[]) => void;
	debug?: (...args: unknown[]) => void;
	trace?: (...args: unknown[]) => void;
	onLog?: (severity: LogSeverity, ...args: unknown[]) => void;
}

export type AuditDecision = "invoke" | "denied";

export interface AuditEvent {
	binding: string;
	capability: string | null;
	at: number;
	/** `"invoke"` for an allowed host-binding call, `"denied"` for a refused capability decision. */
	decision?: AuditDecision;
	/** Mod that owns the refused export. Present only on denial records. */
	mod?: string;
	/** Hook whose fill was refused. Present only on denial records for hook fills. */
	hook?: string;
}

export interface HardLimits {
	timeout_ms?: number;
	memory_mb?: number;
	max_stack_depth?: number;
}

export class CancellationToken {
	private flag = { cancelled: false };

	cancel(): void {
		this.flag.cancelled = true;
	}

	get cancelled(): boolean {
		return this.flag.cancelled;
	}
}

export interface SandboxOptions {
	manifest: Manifest;
	hostBindings: HostBindings;
	capabilities?: string[];
	libraries?: Record<string, string>;
	console?: ConsoleHandler;
	audit?: (event: AuditEvent) => void;
	hardLimits?: HardLimits;
	cancellation?: CancellationToken;
	debug?: DebugOptions;
	/** Receives deprecation notices; without it each code warns once on `console.warn`. */
	onDeprecation?: DeprecationHandler;
	/** Runs each hook and event fire under the script timeout, a fresh budget per fire. */
	budgetHandlers?: boolean;
}

export interface ExecutionResult {
	value: unknown;
	duration_ms: number;
}

export function validateLibraryRegistration(manifest: Manifest, libraries: Record<string, string> | undefined): void {
	for (const [specifier, source] of Object.entries(libraries ?? {})) {
		if (!manifest.libraries?.[specifier]) {
			throw new LibraryRegistrationError(specifier, "not declared in the host manifest's libraries map");
		}
		const artifact = detectCommonJS(source);
		if (artifact) {
			throw new LibraryRegistrationError(specifier, `CommonJS artifacts detected (found: ${artifact}); libraries must be pre-bundled ES modules`);
		}
		const nested = findImportSpecifier(source);
		if (nested !== null) {
			throw new LibraryRegistrationError(specifier, `not import-clean: contains an import of "${nested}"; libraries must be self-contained pre-bundled ES modules with no imports of their own`);
		}
	}
}

export function makeLibraryResolver(
	manifest: Manifest,
	libraries: Record<string, string> | undefined,
	granted: Set<string>,
): (specifier: string) => string {
	return (specifier: string) => {
		const declaration = manifest.libraries?.[specifier];
		if (!declaration) throw new ImportDeniedError(specifier);
		if (declaration.capability && !grantedSatisfies(granted, declaration.capability)) {
			const error = new CapabilityDeniedError(specifier, declaration.capability);
			error.message = `import of "${specifier}" requires the "${declaration.capability}" capability, which hasn't been granted to this script. Ask the app developer to enable it.`;
			throw error;
		}
		const source = libraries?.[specifier];
		if (source === undefined) throw new LibraryUnavailableError(specifier);
		return source;
	};
}

function isNamespace(binding: Binding): binding is NamespaceBinding {
	return "members" in binding;
}

function isAccessor(binding: Binding): binding is AccessorBinding {
	return isAccessorBinding(binding);
}

function collectAsyncBindingNames(bindings: Record<string, Binding> | undefined, prefix = ""): string[] {
	if (!bindings) return [];
	const names: string[] = [];
	for (const [name, binding] of Object.entries(bindings)) {
		const qualifiedName = prefix ? `${prefix}.${name}` : name;
		if (isNamespace(binding)) {
			names.push(...collectAsyncBindingNames(binding.members, qualifiedName));
		} else if (!isAccessor(binding) && binding.async) {
			names.push(qualifiedName);
		}
	}
	return names;
}

const CONSOLE_METHOD_SEVERITY: Record<string, LogSeverity> = {
	log: "info",
	info: "info",
	warn: "warn",
	error: "error",
	debug: "debug",
	trace: "trace",
};

function dispatchConsole(
	handler: ConsoleHandler,
	method: string,
	severity: LogSeverity,
	args: unknown[],
): void {
	if (handler.onLog) {
		handler.onLog(severity, ...args);
		return;
	}
	const direct = handler[method as keyof ConsoleHandler] as ((...a: unknown[]) => void) | undefined;
	if (direct) {
		direct(...args);
		return;
	}
	const fallback = severity === "warn" ? handler.warn : severity === "error" ? handler.error : handler.log;
	if (fallback) fallback(...args);
}

function injectConsole(
	context: QuickJSContext | QuickJSAsyncContext,
	sandboxConsole: ConsoleHandler,
): void {
	installConsoleSupport(context);
	const consoleObj = context.newObject();

	for (const method of Object.keys(CONSOLE_METHOD_SEVERITY)) {
		const severity = CONSOLE_METHOD_SEVERITY[method];
		const fn = context.newFunction(method, (...handles: QuickJSHandle[]) => {
			const args: unknown[] = [];
			for (const handle of handles) {
				const read = readConsoleArgument(context, handle);
				if ("interrupted" in read) return { error: read.interrupted };
				args.push(read.value);
			}
			dispatchConsole(sandboxConsole, method, severity, args);
		});
		context.setProp(consoleObj, method, fn);
		fn.dispose();
	}

	context.setProp(context.global, "console", consoleObj);
	consoleObj.dispose();
}

/**
 * Replacing the global `Function` leaves the real constructor one `.constructor` away from any
 * function (and its async, generator, and async-generator siblings from theirs), so every one of
 * those prototype links is pointed at a thrower too.
 */
const SEAL_FUNCTION_CONSTRUCTORS = `
	(function () {
		var refuse = function () {
			throw new TypeError("Function() is not permitted. Dynamic code generation is disabled in xript.");
		};
		var prototypes = [
			Object.getPrototypeOf(function () {}),
			Object.getPrototypeOf(async function () {}),
			Object.getPrototypeOf(function* () {}),
			Object.getPrototypeOf(async function* () {}),
		];
		for (var i = 0; i < prototypes.length; i++) {
			Object.defineProperty(prototypes[i], "constructor", { value: refuse, writable: true, configurable: true });
		}
	})();
`;

function blockCodeGeneration(context: QuickJSContext | QuickJSAsyncContext): void {
	evalAndDispose(context, `
		globalThis.eval = function() {
			throw new TypeError("eval() is not permitted. Dynamic code generation is disabled in xript.");
		};
		globalThis.Function = function() {
			throw new TypeError("Function() is not permitted. Dynamic code generation is disabled in xript.");
		};
		${SEAL_FUNCTION_CONSTRUCTORS}
	`);
	evalAndDispose(context, GUARDED_JSON_SOURCE);
}

/**
 * The built-ins the runtime's own sandbox-side code calls, captured when that code is installed,
 * before any script runs, so a script that later replaces one changes nothing the runtime does.
 */
const CAPTURED_INTRINSICS = `
	var reflectApply = Reflect.apply;
	var defineProperty = Object.defineProperty;
	var objectKeys = Object.keys;
	var objectCreate = Object.create;
	var objectFreeze = Object.freeze;
	var isArray = Array.isArray;
	var ErrorCtor = Error;
	var TypeErrorCtor = TypeError;
	function put(target, key, value) {
		defineProperty(target, key, { value: value, writable: true, enumerable: true, configurable: true });
	}
	function append(list, value) {
		put(list, list.length, value);
	}
	var setPrototypeOf = Object.setPrototypeOf;
	function bareList() {
		var list = [];
		setPrototypeOf(list, null);
		return list;
	}
`;

const internalsByContext = new WeakMap<QuickJSContext | QuickJSAsyncContext, QuickJSHandle>();

/** The host-held, prototype-free object the runtime's sandbox-side internals live on. No script can reach it. */
function internalsOf(context: QuickJSContext | QuickJSAsyncContext): QuickJSHandle {
	let held = internalsByContext.get(context);
	if (!held) {
		held = context.unwrapResult(context.evalCode(
			`(function () {${CAPTURED_INTRINSICS} var internals = objectCreate(null); internals.put = put; internals.lock = function (target, key, value) { defineProperty(target, key, { value: value, writable: false, enumerable: false, configurable: false }); }; return internals; })()`,
			"xript-internals.js",
		));
		internalsByContext.set(context, held);
	}
	return held;
}

function internal(context: QuickJSContext | QuickJSAsyncContext, name: string): QuickJSHandle {
	return context.getProp(internalsOf(context), name);
}

/**
 * Defines `key` on `target` as an ordinary writable data property. Unlike an assignment it never
 * reaches a setter, so a name such as `__proto__` lands as a property instead of a prototype.
 */
function defineValue(context: QuickJSContext | QuickJSAsyncContext, target: QuickJSHandle, key: string, value: QuickJSHandle): void {
	const put = internal(context, "put");
	const keyHandle = context.newString(key);
	const result = context.callFunction(put, context.undefined, target, keyHandle, value);
	keyHandle.dispose();
	put.dispose();
	context.unwrapResult(result).dispose();
}

function releaseInternals(context: QuickJSContext | QuickJSAsyncContext): void {
	const held = internalsByContext.get(context);
	internalsByContext.delete(context);
	if (held?.alive) held.dispose();
}

/** Evaluates `body` as the body of a function given the internals object, with the captured intrinsics in scope. */
function installInternals(context: QuickJSContext | QuickJSAsyncContext, body: string): void {
	const fn = context.unwrapResult(context.evalCode(`(function (internals) {${CAPTURED_INTRINSICS}${body}\n})`, "xript-internals.js"));
	const result = context.callFunction(fn, context.undefined, internalsOf(context));
	fn.dispose();
	context.unwrapResult(result).dispose();
}

function evalAndDispose(context: QuickJSContext | QuickJSAsyncContext, code: string): void {
	const result = context.evalCode(code);
	if (result.error) {
		result.error.dispose();
	} else {
		result.value.dispose();
	}
}

function injectErrorClasses(context: QuickJSContext | QuickJSAsyncContext): void {
	const factory = context.evalCode(`(function () {
		var defineProperty = Object.defineProperty;
		function own(target, key, value) {
			defineProperty(target, key, { value: value, writable: true, enumerable: true, configurable: true });
		}
		class BindingError extends Error {
			constructor(binding, message) {
				super(binding + "(): " + message);
				own(this, "name", "BindingError");
				own(this, "binding", binding);
			}
		}
		class CapabilityDeniedError extends Error {
			constructor(binding, capability) {
				super(binding + '() requires the "' + capability + '" capability, which hasn\\'t been granted to this script. Ask the app developer to enable it.');
				own(this, "name", "CapabilityDeniedError");
				own(this, "capability", capability);
				own(this, "binding", binding);
			}
		}
		globalThis.BindingError = BindingError;
		globalThis.CapabilityDeniedError = CapabilityDeniedError;
		var TypeErrorCtor = TypeError;
		return function (kind, first, second) {
			if (kind === "binding") return new BindingError(first, second);
			if (kind === "capability") return new CapabilityDeniedError(first, second);
			return new TypeErrorCtor(first);
		};
	})()`, "xript-errors.js");
	callbackSupportFor(context).errors = context.unwrapResult(factory);
}

function emitAudit(
	audit: ((event: AuditEvent) => void) | undefined,
	binding: string,
	capability: string | null,
): void {
	if (!audit) return;
	try {
		audit({ binding, capability, at: Date.now(), decision: "invoke" });
	} catch {
		// fire-and-forget: emit failures never break script execution
	}
}

function stripBindingPrefix(error: BindingError): string {
	const prefix = `${error.binding}(): `;
	return error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message;
}

/** A host error's message without a leading `<binding>(): `, so the binding error names it once. */
function unprefixed(binding: string, error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const prefix = `${binding}(): `;
	return message.startsWith(prefix) ? message.slice(prefix.length) : message;
}

const ASYNC_ON_SYNC_TIER_MESSAGE =
	'declares "async": true in the manifest, and the synchronous sandbox cannot await it. The app must create the runtime with the async entry point (initXriptAsync / createSandboxAsync) for this binding to be callable.';

const ASYNC_IN_CALLBACK_MESSAGE =
	"cannot be called from inside a callback passed to a binding: it is async, and a callback runs synchronously";

const ASYNC_FROM_EXECUTE_MESSAGE =
	"is async, and a synchronous call (execute(), invokeExport()) runs to completion, so nothing can await it. Use executeAsync() or invokeExportAsync() instead";

/**
 * How an async sandbox settles the promises its async bindings hand out: `drain` runs the job
 * queue after one settles, as the call that started it, and `syncDepth` counts the synchronous
 * `execute` calls running right now, during which an async binding refuses to start.
 */
interface AsyncHost {
	drain(lane: CallerLane): void;
	syncDepth: number;
	/** Promises handed to scripts whose host work has not settled; disposing the runtime releases them. */
	pending: Set<{ dispose(): void }>;
}

const asyncHosts = new WeakMap<QuickJSAsyncContext, AsyncHost>();

function createAsyncUnsupportedStub(
	context: QuickJSContext | QuickJSAsyncContext,
	qualifiedName: string,
): QuickJSHandle {
	return context.newFunction(qualifiedName, () =>
		createBindingError(context, qualifiedName, ASYNC_ON_SYNC_TIER_MESSAGE),
	);
}

function createHostFunctionWrapper(
	context: QuickJSContext | QuickJSAsyncContext,
	qualifiedName: string,
	binding: FunctionBinding,
	hostFn: HostFunction | undefined,
	grantedCapabilities: Set<string>,
	audit?: (binding: string, capability: string | null) => void,
): QuickJSHandle {
	const functionChecks = functionParamChecks(binding.params);
	const support = callbackSupportFor(context);
	const retainsAt = retainPositions(binding.params, support.types);
	return context.newFunction(qualifiedName, (...handles: QuickJSHandle[]) => {
		if (binding.capability && !grantedSatisfies(grantedCapabilities, binding.capability)) {
			return createCapabilityError(context, qualifiedName, binding.capability);
		}

		if (!hostFn) {
			return createBindingError(context, qualifiedName, "not implemented by the app");
		}

		const refusal = functionParamViolation(qualifiedName, functionChecks, (i) => argTypeOf(context, handles[i]));
		if (refusal) return createTypeError(context, refusal);

		if (audit) audit(qualifiedName, binding.capability ?? null);

		const scope = new CallbackScope(context, support, qualifiedName, retainsAt);
		scope.enter();
		try {
			const nativeArgs = handles.map((h, i) => scope.unmarshal(h, i));
			const halted = scope.takeOutcome(undefined);
			if (halted) return { error: halted };
			const result = hostFn(...nativeArgs);
			const stopped = scope.takeOutcome(undefined);
			if (stopped) return { error: stopped };
			return marshalToQuickJS(context, result, qualifiedName);
		} catch (e) {
			const original = scope.takeOutcome(e);
			if (original) return { error: original };
			if (e instanceof CapabilityDeniedError) {
				return createCapabilityError(context, e.binding, e.capability);
			}
			if (e instanceof BindingError) {
				return createBindingError(context, e.binding, stripBindingPrefix(e));
			}
			return createBindingError(context, qualifiedName, unprefixed(qualifiedName, e));
		} finally {
			scope.close();
		}
	});
}

function argTypeOf(context: QuickJSContext | QuickJSAsyncContext, handle: QuickJSHandle | undefined): string {
	if (handle === undefined) return "undefined";
	const kind = context.typeof(handle);
	if (kind === "object" && context.sameValue(handle, context.null)) return "null";
	return kind;
}

function registerAsyncBinding(
	context: QuickJSAsyncContext,
	qualifiedName: string,
	binding: FunctionBinding,
	hostFn: HostFunction | undefined,
	grantedCapabilities: Set<string>,
	callerContext: CallerContext,
	audit?: (binding: string, capability: string | null) => void,
): QuickJSHandle {
	const capabilityDenied = !!(binding.capability && !grantedSatisfies(grantedCapabilities, binding.capability));
	const missingImpl = !hostFn;

	let asyncImpl: QuickJSHandle = context.undefined;
	if (!capabilityDenied && !missingImpl) {
		const functionChecks = functionParamChecks(binding.params);
		const support = callbackSupportFor(context);
		const retainsAt = retainPositions(binding.params, support.types);
		const settle = async (scope: CallbackScope, nativeArgs: unknown[]) => {
			try {
				const result = await hostFn!(...nativeArgs);
				if (!context.alive) return context.undefined;
				const stopped = scope.takeOutcome(undefined);
				if (stopped) return { error: stopped };
				return marshalToQuickJS(context, result, qualifiedName);
			} catch (e) {
				if (!context.alive) return context.undefined;
				const original = scope.takeOutcome(e);
				if (original) return { error: original };
				if (e instanceof CapabilityDeniedError) {
					return createCapabilityError(context, e.binding, e.capability);
				}
				if (e instanceof BindingError) {
					return createBindingError(context, e.binding, stripBindingPrefix(e));
				}
				return createBindingError(context, qualifiedName, unprefixed(qualifiedName, e));
			} finally {
				scope.close();
			}
		};
		asyncImpl = context.newFunction(qualifiedName, (...handles: QuickJSHandle[]) => {
			const refusal = functionParamViolation(qualifiedName, functionChecks, (i) => argTypeOf(context, handles[i]));
			if (refusal) return createTypeError(context, refusal);
			if (support.depth > 0) return createBindingError(context, qualifiedName, ASYNC_IN_CALLBACK_MESSAGE);
			const host = asyncHosts.get(context);
			if (!host || host.syncDepth > 0) return createBindingError(context, qualifiedName, ASYNC_FROM_EXECUTE_MESSAGE);
			if (audit) audit(qualifiedName, binding.capability ?? null);
			const scope = new CallbackScope(context, support, qualifiedName, retainsAt);
			let nativeArgs: unknown[];
			try {
				nativeArgs = handles.map((h, i) => scope.unmarshal(h, i));
			} catch (e) {
				scope.close();
				throw e;
			}
			const halted = scope.takeOutcome(undefined);
			if (halted) {
				scope.close();
				return { error: halted };
			}
			const lane = callerContext.lane();
			const deferred = context.newPromise();
			const held = {
				dispose(): void {
					deferred.dispose();
					scope.close();
				},
			};
			host.pending.add(held);
			let pending: Promise<QuickJSHandle | { error: QuickJSHandle }>;
			scope.enter();
			try {
				pending = settle(scope, nativeArgs);
			} finally {
				scope.leave();
			}
			void pending.then((outcome) => {
				const handle = "error" in outcome ? outcome.error : outcome;
				host.pending.delete(held);
				if (!context.alive) return;
				if ("error" in outcome) deferred.reject(handle);
				else deferred.resolve(handle);
				safeDispose(context, handle);
				host.drain(lane);
			}, () => undefined);
			return deferred.handle;
		});
	}

	const kind = capabilityDenied ? "denied" : missingImpl ? "missing" : "call";
	const args = [kind, qualifiedName, binding.capability || ""].map((text) => context.newString(text));
	const factory = context.unwrapResult(context.evalCode(ASYNC_GATE_FACTORY_SOURCE, "xript-async-binding.js"));
	const gate = context.callFunction(factory, context.undefined, ...args, asyncImpl);
	factory.dispose();
	for (const handle of args) handle.dispose();
	if (asyncImpl !== context.undefined) asyncImpl.dispose();
	return context.unwrapResult(gate);
}

/** Builds an async binding's sandbox-side wrapper; the binding's names arrive as arguments, never as source. */
const ASYNC_GATE_FACTORY_SOURCE = `(function (kind, name, capability, impl) {
	if (kind === "denied") return function () { throw new CapabilityDeniedError(name, capability); };
	if (kind === "missing") return function () { throw new BindingError(name, "not implemented by the app"); };
	return function (...args) { return impl(...args); };
})`;

function registerBinding(
	context: QuickJSContext | QuickJSAsyncContext,
	target: QuickJSHandle,
	propName: string,
	qualifiedName: string,
	binding: FunctionBinding,
	hostFn: HostFunction | undefined,
	grantedCapabilities: Set<string>,
	asyncCaller: CallerContext | null,
	audit?: (binding: string, capability: string | null) => void,
): void {
	if (asyncCaller && binding.async) {
		const gateFn = registerAsyncBinding(context as QuickJSAsyncContext, qualifiedName, binding, hostFn, grantedCapabilities, asyncCaller, audit);
		defineValue(context, target, propName, gateFn);
		gateFn.dispose();
	} else if (!asyncCaller && binding.async) {
		const stub = createAsyncUnsupportedStub(context, qualifiedName);
		defineValue(context, target, propName, stub);
		stub.dispose();
	} else {
		const fn = createHostFunctionWrapper(context, qualifiedName, binding, hostFn, grantedCapabilities, audit);
		defineValue(context, target, propName, fn);
		fn.dispose();
	}
}

function registerNamespaceMembers(
	context: QuickJSContext | QuickJSAsyncContext,
	nsObj: QuickJSHandle,
	binding: NamespaceBinding,
	hostNs: HostNamespace | undefined,
	qualifiedPrefix: string,
	grantedCapabilities: Set<string>,
	asyncCaller: CallerContext | null,
	audit?: (binding: string, capability: string | null) => void,
): void {
	for (const [memberName, memberBinding] of Object.entries(binding.members)) {
		const qualifiedName = `${qualifiedPrefix}.${memberName}`;
		if (omitsBinding(memberBinding, hostNs, memberName)) {
			defineValue(context, nsObj, memberName, context.undefined);
		} else if (isAccessor(memberBinding)) {
			registerAccessor(context, nsObj, memberName, qualifiedName, memberBinding, hostNs, grantedCapabilities, audit);
		} else if (isNamespace(memberBinding)) {
			const nestedNsObj = context.newObject();
			const nestedHostNs = ownMember(hostNs, memberName) as HostNamespace | undefined;
			registerNamespaceMembers(
				context,
				nestedNsObj,
				memberBinding,
				nestedHostNs,
				qualifiedName,
				grantedCapabilities,
				asyncCaller,
				audit,
			);
			defineValue(context, nsObj, memberName, nestedNsObj);
			nestedNsObj.dispose();
		} else {
			const hostFn = ownMember(hostNs, memberName) as HostFunction | undefined;
			registerBinding(context, nsObj, memberName, qualifiedName, memberBinding, hostFn, grantedCapabilities, asyncCaller, audit);
		}
	}
}

function registerAccessor(
	context: QuickJSContext | QuickJSAsyncContext,
	target: QuickJSHandle,
	propName: string,
	qualifiedName: string,
	binding: AccessorBinding,
	hostContainer: unknown,
	grantedCapabilities: Set<string>,
	audit?: (binding: string, capability: string | null) => void,
): void {
	const supplied = hostAccessorFor(hostContainer, propName, binding.accessor);
	const gate: FunctionBinding = { description: binding.description, capability: binding.capability };
	const handles: QuickJSHandle[] = [];
	try {
		const define = context.unwrapResult(context.evalCode(DEFINE_ACCESSOR_SOURCE, "xript-accessor.js"));
		handles.push(define);
		const getter = createHostFunctionWrapper(context, qualifiedName, gate, supplied?.get, grantedCapabilities, audit);
		handles.push(getter);
		let setter: QuickJSHandle = context.undefined;
		if (binding.accessor === "get-set") {
			setter = createHostFunctionWrapper(context, qualifiedName, gate, supplied?.set, grantedCapabilities, audit);
			handles.push(setter);
		}
		const key = context.newString(propName);
		handles.push(key);
		const name = context.newString(qualifiedName);
		handles.push(name);
		const result = context.callFunction(define, context.undefined, target, key, getter, setter, name);
		handles.push(context.unwrapResult(result));
	} finally {
		for (const handle of handles) safeDispose(context, handle);
	}
}

function injectBindings(
	context: QuickJSContext | QuickJSAsyncContext,
	manifest: Manifest,
	hostBindings: HostBindings,
	grantedCapabilities: Set<string>,
	asyncCaller: CallerContext | null,
	audit?: (binding: string, capability: string | null) => void,
): void {
	evalAndDispose(context, presenceProbeSource(providedBindingPaths(manifest.bindings, hostBindings)));
	if (!manifest.bindings) return;

	for (const [name, binding] of Object.entries(manifest.bindings)) {
		if (omitsBinding(binding, hostBindings, name)) {
			defineValue(context, context.global, name, context.undefined);
		} else if (isAccessor(binding)) {
			registerAccessor(context, context.global, name, name, binding, hostBindings, grantedCapabilities, audit);
		} else if (isNamespace(binding)) {
			const nsObj = context.newObject();
			const hostNs = ownMember(hostBindings, name) as HostNamespace | undefined;
			registerNamespaceMembers(context, nsObj, binding, hostNs, name, grantedCapabilities, asyncCaller, audit);
			defineValue(context, context.global, name, nsObj);
			nsObj.dispose();
		} else {
			const hostFn = ownMember(hostBindings, name) as HostFunction | undefined;
			registerBinding(context, context.global, name, name, binding, hostFn, grantedCapabilities, asyncCaller, audit);
		}
	}

	freezeNamespaces(context, manifest);
}

/** A function expression that freezes an object and every object reachable through its data properties. */
const DEEP_FREEZE_SOURCE = `function deepFreeze(obj) {
	if (obj === null || (typeof obj !== "object" && typeof obj !== "function")) return obj;
	var keys = Object.getOwnPropertyNames(obj);
	for (var i = 0; i < keys.length; i++) {
		var descriptor = Object.getOwnPropertyDescriptor(obj, keys[i]);
		var value = descriptor && descriptor.value;
		if (value !== null && typeof value === "object" && !Object.isFrozen(value)) deepFreeze(value);
	}
	return Object.freeze(obj);
}`;

function freezeNamespaces(context: QuickJSContext | QuickJSAsyncContext, manifest: Manifest): void {
	if (!manifest.bindings) return;

	const namespaceNames = Object.entries(manifest.bindings)
		.filter(([_, binding]) => isNamespace(binding))
		.map(([name]) => name);

	if (namespaceNames.length === 0) return;

	callWithNames(
		context,
		`(function (names) { ${DEEP_FREEZE_SOURCE} for (var i = 0; i < names.length; i++) deepFreeze(Object.getOwnPropertyDescriptor(globalThis, names[i]).value); })`,
		namespaceNames,
	);
}

/**
 * Locks every global the runtime installed for scripts: each becomes a non-writable,
 * non-configurable property of `globalThis`, and `hooks`, `xript`, `console`, and the error
 * classes are frozen. A mod can then neither replace nor delete a binding another mod calls.
 */
function sealGlobals(context: QuickJSContext | QuickJSAsyncContext, manifest: Manifest): void {
	const names = [...Object.keys(manifest.bindings ?? {}), "hooks", "events", "xript", "console", "BindingError", "CapabilityDeniedError"];
	callWithNames(
		context,
		`(function (names) {
			${DEEP_FREEZE_SOURCE}
			var frozenHolders = { hooks: true, xript: true, console: true, BindingError: true, CapabilityDeniedError: true };
			for (var i = 0; i < names.length; i++) {
				var descriptor = Object.getOwnPropertyDescriptor(globalThis, names[i]);
				if (!descriptor) continue;
				if (descriptor.configurable) {
					if ("value" in descriptor) {
						Object.defineProperty(globalThis, names[i], { value: descriptor.value, writable: false, enumerable: descriptor.enumerable, configurable: false });
					} else {
						Object.defineProperty(globalThis, names[i], { get: descriptor.get, set: descriptor.set, enumerable: descriptor.enumerable, configurable: false });
					}
				}
				if (frozenHolders[names[i]] === true && "value" in descriptor) {
					deepFreeze(descriptor.value);
					if (typeof descriptor.value === "function" && descriptor.value.prototype) Object.freeze(descriptor.value.prototype);
				}
			}
		})`,
		names,
	);
}

/** Evaluates `source`, a function expression taking one array of strings, and calls it with `names` as data. */
function callWithNames(context: QuickJSContext | QuickJSAsyncContext, source: string, names: string[]): void {
	const fn = context.unwrapResult(context.evalCode(source, "xript-names.js"));
	const array = context.newArray();
	names.forEach((name, index) => {
		const text = context.newString(name);
		context.setProp(array, index, text);
		text.dispose();
	});
	const result = context.callFunction(fn, context.undefined, array);
	array.dispose();
	fn.dispose();
	context.unwrapResult(result).dispose();
}

export interface FireHookOptions {
	phase?: string;
	data?: unknown;
}

/**
 * Evaluates `factorySource`, a `(function (enterCaller, leaveCaller) { ... })` expression, and
 * calls it with host functions that enter and leave a mod on the caller context. The two are
 * reachable only inside the factory's closure, never as globals.
 */
function evalWithCallerContext(
	context: QuickJSContext | QuickJSAsyncContext,
	callerContext: CallerContext,
	factorySource: string,
	clock: HandlerClock = UNTIMED,
): void {
	const factory = context.unwrapResult(context.evalCode(
		`(function (enterCaller, leaveCaller, internals) {${CAPTURED_INTRINSICS} return (${factorySource})(enterCaller, leaveCaller, internals); })`,
		"xript-dispatch.js",
	));
	const enter = context.newFunction("enterCaller", (owner: QuickJSHandle) => {
		const modId = context.dump(owner);
		callerContext.enter(typeof modId === "string" ? modId : null);
		clock.start(callerContext.depth);
	});
	const leave = context.newFunction("leaveCaller", () => {
		clock.stop(callerContext.depth);
		callerContext.leave();
	});
	const result = context.callFunction(factory, context.undefined, enter, leave, internalsOf(context));
	enter.dispose();
	leave.dispose();
	factory.dispose();
	context.unwrapResult(result).dispose();
}

function injectHookHelpers(context: QuickJSContext | QuickJSAsyncContext, callerContext: CallerContext, clock: HandlerClock): void {
	evalWithCallerContext(context, callerContext, `(function (enterCaller, leaveCaller, internals) {
		var handlersByKey = objectCreate(null);
		var owners = objectCreate(null);
		internals.__xript_register_handler = function(key, handler, owner) {
			if (!handlersByKey[key]) {
				handlersByKey[key] = [];
				owners[key] = [];
			}
			append(handlersByKey[key], handler);
			append(owners[key], typeof owner === "string" ? owner : null);
		};
		internals.__xript_fire_handlers = function(key, data) {
			var handlers = handlersByKey[key];
			if (!handlers || handlers.length === 0) return [];
			var args;
			if (typeof data === "object" && data !== null && !isArray(data)) {
				var keys = objectKeys(data);
				args = bareList();
				for (var k = 0; k < keys.length; k++) args[k] = data[keys[k]];
			} else {
				args = data === undefined ? [] : [data];
			}
			var results = bareList();
			for (var i = 0; i < handlers.length; i++) {
				enterCaller(owners[key][i]);
				try {
					results[i] = reflectApply(handlers[i], null, args);
				} catch(e) {
					results[i] = undefined;
				} finally {
					leaveCaller();
				}
			}
			return results;
		};
	})`, clock);
}

function registerHandlerInContext(
	context: QuickJSContext | QuickJSAsyncContext,
	registryKey: string,
	handlerHandle: QuickJSHandle,
	owner: string | null,
): void {
	const registerFn = internal(context, "__xript_register_handler");
	const keyStr = context.newString(registryKey);
	const ownerHandle = owner === null ? context.null : context.newString(owner);
	const callResult = context.callFunction(registerFn, context.undefined, keyStr, handlerHandle, ownerHandle);
	keyStr.dispose();
	safeDispose(context, ownerHandle);
	registerFn.dispose();
	if (callResult.error) callResult.error.dispose();
	else callResult.value.dispose();
}

function injectHooks(
	context: QuickJSContext | QuickJSAsyncContext,
	manifest: Manifest,
	grantedCapabilities: Set<string>,
	callerContext: CallerContext,
	clock: HandlerClock,
): void {
	injectHookHelpers(context, callerContext, clock);

	const hooks = effectiveHooks(manifest);
	if (Object.keys(hooks).length === 0) {
		evalAndDispose(context, "globalThis.hooks = {};");
		return;
	}

	const hooksObj = context.newObject();

	for (const [hookName, hookDef] of Object.entries(hooks)) {
		if (hookDef.phases && hookDef.phases.length > 0) {
			const hookNs = context.newObject();

			for (const phase of hookDef.phases) {
				const registryKey = `${hookName}:${phase}`;
				const regFn = context.newFunction(`hooks.${hookName}.${phase}`, (...handles: QuickJSHandle[]) => {
					if (hookDef.capability && !grantedSatisfies(grantedCapabilities, hookDef.capability)) {
						return createCapabilityError(context, `hooks.${hookName}.${phase}`, hookDef.capability);
					}
					if (handles.length === 0) {
						return createBindingError(context, `hooks.${hookName}.${phase}`, "expected a handler function");
					}
					registerHandlerInContext(context, registryKey, handles[0], callerContext.current());
				});
				defineValue(context, hookNs, phase, regFn);
				regFn.dispose();
			}

			defineValue(context, hooksObj, hookName, hookNs);
			hookNs.dispose();
		} else {
			const registryKey = hookName;
			const regFn = context.newFunction(`hooks.${hookName}`, (...handles: QuickJSHandle[]) => {
				if (hookDef.capability && !grantedSatisfies(grantedCapabilities, hookDef.capability)) {
					return createCapabilityError(context, `hooks.${hookName}`, hookDef.capability);
				}
				if (handles.length === 0) {
					return createBindingError(context, `hooks.${hookName}`, "expected a handler function");
				}
				registerHandlerInContext(context, registryKey, handles[0], callerContext.current());
			});
			defineValue(context, hooksObj, hookName, regFn);
			regFn.dispose();
		}
	}

	context.setProp(context.global, "hooks", hooksObj);
	hooksObj.dispose();

}

function freezeHooksAndFragments(
	context: QuickJSContext | QuickJSAsyncContext,
	manifest: Manifest,
): void {
	const hookNsNames = Object.entries(effectiveHooks(manifest))
		.filter(([_, h]) => h.phases && h.phases.length > 0)
		.map(([name]) => name);

	callWithNames(
		context,
		"(function (names) { for (var i = 0; i < names.length; i++) Object.freeze(hooks[names[i]]); if (hooks.fragment) Object.freeze(hooks.fragment); Object.freeze(hooks); })",
		hookNsNames,
	);
}

function injectFragmentAPI(context: QuickJSContext | QuickJSAsyncContext): void {
	installInternals(context, `
		var fragmentHandlers = objectCreate(null);
		internals.__xript_register_fragment_handler = function(key, handler) {
			if (!fragmentHandlers[key]) {
				fragmentHandlers[key] = [];
			}
			append(fragmentHandlers[key], handler);
		};
		internals.__xript_fire_fragment_handlers = function(key, bindings) {
			var handlers = fragmentHandlers[key];
			if (!handlers || handlers.length === 0) return [];
			var allOps = bareList();
			for (var i = 0; i < handlers.length; i++) {
				var fragmentProxy = {
					toggle: function(target, condition) { allOps[allOps.length] = ({ op: "toggle", selector: target, value: !!condition }); },
					addClass: function(target, className) { allOps[allOps.length] = ({ op: "addClass", selector: target, value: className }); },
					removeClass: function(target, className) { allOps[allOps.length] = ({ op: "removeClass", selector: target, value: className }); },
					setText: function(target, text) { allOps[allOps.length] = ({ op: "setText", selector: target, value: text }); },
					setProp: function(target, prop, value) { allOps[allOps.length] = ({ op: "setProp", selector: target, prop: prop, value: value }); },
					setAttr: function(target, attr, value) { allOps[allOps.length] = ({ op: "setAttr", selector: target, attr: attr, prop: attr, value: value }); },
					removeAttr: function(target, attr) { allOps[allOps.length] = ({ op: "removeAttr", selector: target, attr: attr, prop: attr }); },
					replaceChildren: function(target, content) { allOps[allOps.length] = ({ op: "replaceChildren", selector: target, value: content }); }
				};
				try {
					reflectApply(handlers[i], undefined, [bindings, fragmentProxy]);
				} catch(e) {}
			}
			return allOps;
		};
	`);

	const hooksGlobal = context.getProp(context.global, "hooks");
	const fragmentNs = context.newObject();

	const lifecycles = ["mount", "unmount", "update", "suspend", "resume"];
	for (const lifecycle of lifecycles) {
		const regFn = context.newFunction(`hooks.fragment.${lifecycle}`, (...handles: QuickJSHandle[]) => {
			if (handles.length < 2) {
				return createBindingError(context, `hooks.fragment.${lifecycle}`, "expected (fragmentId, handler)");
			}
			const fragmentId = context.dump(handles[0]);
			const registryKey = `fragment:${lifecycle}:${fragmentId}`;

			const registerFn = internal(context, "__xript_register_fragment_handler");
			const keyStr = context.newString(registryKey);
			const callResult = context.callFunction(registerFn, context.undefined, keyStr, handles[1]);
			keyStr.dispose();
			registerFn.dispose();
			if (callResult.error) callResult.error.dispose();
			else callResult.value.dispose();
		});
		context.setProp(fragmentNs, lifecycle, regFn);
		regFn.dispose();
	}

	context.setProp(hooksGlobal, "fragment", fragmentNs);
	fragmentNs.dispose();
	hooksGlobal.dispose();
}

function injectExportsAPI(context: QuickJSContext | QuickJSAsyncContext): void {
	installInternals(context, `
		var exportsByOwner = objectCreate(null);
		exportsByOwner[""] = objectCreate(null);
		var exportOwner = "";
		internals.__xript_set_export_owner = function(owner) {
			var key = typeof owner === "string" ? owner : "";
			exportOwner = key;
			if (!exportsByOwner[key]) exportsByOwner[key] = objectCreate(null);
			return key;
		};
		function ownersOf(name) {
			var owners = [];
			var keys = objectKeys(exportsByOwner);
			for (var i = 0; i < keys.length; i++) {
				if (typeof exportsByOwner[keys[i]][name] === "function") append(owners, keys[i]);
			}
			return owners;
		}
		internals.__xript_export_owners_of = ownersOf;
		if (typeof globalThis.xript !== "object" || globalThis.xript === null) globalThis.xript = {};
		globalThis.xript.exports = objectFreeze({
			register: function(name, fn) {
				if (typeof name !== "string" || name.length === 0) {
					throw new TypeErrorCtor("xript.exports.register: name must be a non-empty string");
				}
				if (typeof fn !== "function") {
					throw new TypeErrorCtor("xript.exports.register: fn must be a function");
				}
				exportsByOwner[exportOwner][name] = fn;
			}
		});
		function failure(message, name, fields) {
			var error = new ErrorCtor(message);
			var keys = objectKeys(fields);
			for (var i = 0; i < keys.length; i++) put(error, keys[i], fields[keys[i]]);
			return error;
		}
		internals.__xript_invoke_export = function(name, args, owner) {
			var fn;
			if (typeof owner === "string") {
				var bucket = exportsByOwner[owner];
				fn = bucket ? bucket[name] : undefined;
			} else {
				var owners = ownersOf(name);
				if (owners.length > 1) {
					throw failure("export " + name + " is provided by more than one mod", name, { name: "AmbiguousExportError", export: name, owners: owners });
				}
				fn = owners.length === 1 ? exportsByOwner[owners[0]][name] : undefined;
			}
			if (typeof fn !== "function") {
				throw failure("export " + name + " not found", name, { name: "InvokeError", export: name });
			}
			return reflectApply(fn, null, args || []);
		};
		internals.__xript_harvest_exports = function(ns) {
			var harvested = [];
			var bucket = exportsByOwner[exportOwner];
			var keys = objectKeys(ns);
			for (var i = 0; i < keys.length; i++) {
				var name = keys[i];
				if (name === "default") continue;
				var value = ns[name];
				if (typeof value !== "function") continue;
				if (typeof bucket[name] === "function") continue;
				bucket[name] = value;
				append(harvested, name);
			}
			return harvested;
		};
	`);
}

type InvokeErrorDump = { name?: string; message?: string; export?: string; owners?: string[] } | undefined;

function throwInvokeFailure(errorObj: InvokeErrorDump, exportName: string): never {
	if (errorObj?.name === "AmbiguousExportError") {
		throw new AmbiguousExportError(errorObj.export ?? exportName, errorObj.owners ?? []);
	}
	const message = errorObj?.message || String(errorObj);
	throw new InvokeError(errorObj?.export ?? exportName, message);
}

function callInvokeExport(
	context: QuickJSContext | QuickJSAsyncContext,
	exportName: string,
	args: unknown[],
	owner: string | undefined,
) {
	const argsHandle = marshalArgsToQuickJS(context, args);
	const invokeFn = internal(context, "__xript_invoke_export");
	const nameStr = context.newString(exportName);
	const ownerHandle = owner === undefined ? context.undefined : context.newString(owner);

	const callResult = context.callFunction(invokeFn, context.undefined, nameStr, argsHandle, ownerHandle);
	nameStr.dispose();
	safeDispose(context, argsHandle);
	if (owner !== undefined) ownerHandle.dispose();
	invokeFn.dispose();
	return callResult;
}

/**
 * The mod an export invocation runs on behalf of: the owner the host named, else the single
 * mod whose namespace provides the export. The host's own namespace is no mod.
 */
function exportCaller(
	context: QuickJSContext | QuickJSAsyncContext,
	exportName: string,
	owner: string | undefined,
): string | null {
	if (owner !== undefined) return owner === "" ? null : owner;
	const ownersOf = internal(context, "__xript_export_owners_of");
	const nameStr = context.newString(exportName);
	const result = context.callFunction(ownersOf, context.undefined, nameStr);
	nameStr.dispose();
	ownersOf.dispose();
	if (result.error) {
		result.error.dispose();
		return null;
	}
	const owners = context.dump(result.value) as unknown;
	result.value.dispose();
	if (!Array.isArray(owners) || owners.length !== 1 || typeof owners[0] !== "string" || owners[0] === "") return null;
	return owners[0];
}

function setExportOwnerInContext(
	context: QuickJSContext | QuickJSAsyncContext,
	owner: string | null,
): void {
	const setter = internal(context, "__xript_set_export_owner");
	const ownerStr = context.newString(owner ?? "");
	const result = context.callFunction(setter, context.undefined, ownerStr);
	ownerStr.dispose();
	setter.dispose();
	if (result.error) result.error.dispose();
	else result.value.dispose();
}

function invokeExportInContext(
	context: QuickJSContext | QuickJSAsyncContext,
	exportName: string,
	args: unknown[],
	owner?: string,
	refusePromise = false,
): unknown {
	const callResult = callInvokeExport(context, exportName, args, owner);

	if (callResult.error) {
		const errorObj = context.dump(callResult.error) as InvokeErrorDump;
		callResult.error.dispose();
		throwInvokeFailure(errorObj, exportName);
	}

	if (refusePromise) refusePromiseResult(context, callResult.value, `the export "${exportName}"`, "its async invocation (invokeExportAsync(), invokeModExportAsync(), invokeCommandAsync())");
	const value = readAndRelease(context, callResult.value);
	return value;
}

async function invokeExportAsyncInContext(
	context: QuickJSContext | QuickJSAsyncContext,
	runtime: QuickJSRuntime | QuickJSAsyncRuntime,
	exportName: string,
	args: unknown[],
	owner?: string,
): Promise<unknown> {
	const callResult = callInvokeExport(context, exportName, args, owner);

	if (callResult.error) {
		const errorObj = context.dump(callResult.error) as InvokeErrorDump;
		callResult.error.dispose();
		throwInvokeFailure(errorObj, exportName);
	}

	const promiseHandle = callResult.value;
	const resolved = context.resolvePromise(promiseHandle);
	if (promiseHandle.alive) promiseHandle.dispose();
	runtime.executePendingJobs();

	const awaited = await resolved;
	if (awaited.error) {
		const errorObj = context.dump(awaited.error) as InvokeErrorDump;
		if (awaited.error.alive) awaited.error.dispose();
		throwInvokeFailure(errorObj, exportName);
	}

	const value = readAndRelease(context, awaited.value);
	return value;
}

function fireFragmentHookInContext(
	context: QuickJSContext | QuickJSAsyncContext,
	fragmentId: string,
	lifecycle: string,
	bindings?: Record<string, unknown>,
): RawFragmentOp[] {
	const registryKey = `fragment:${lifecycle}:${fragmentId}`;
	const bindingsHandle = bindings !== undefined
		? marshalToQuickJS(context, bindings)
		: context.undefined;

	const fireFn = internal(context, "__xript_fire_fragment_handlers");
	const keyStr = context.newString(registryKey);

	const callResult = context.callFunction(fireFn, context.undefined, keyStr, bindingsHandle);
	keyStr.dispose();
	if (bindings !== undefined) safeDispose(context, bindingsHandle);
	fireFn.dispose();

	if (callResult.error) {
		callResult.error.dispose();
		return [];
	}

	const result = readResult(context, callResult.value) as RawFragmentOp[];
	callResult.value.dispose();
	return Array.isArray(result) ? result : [];
}

function fireHookInContext(
	context: QuickJSContext | QuickJSAsyncContext,
	manifest: Manifest,
	hookName: string,
	options?: FireHookOptions,
	budgeted = false,
): unknown[] {
	const hookDef = effectiveHooks(manifest)[hookName];
	if (!hookDef) return [];

	let registryKey: string;
	if (options?.phase) {
		if (!hookDef.phases || !hookDef.phases.includes(options.phase)) {
			return [];
		}
		registryKey = `${hookName}:${options.phase}`;
	} else {
		registryKey = hookName;
	}

	const data = options?.data;
	const dataHandle = data !== undefined
		? marshalToQuickJS(context, data)
		: context.undefined;

	const fireFn = internal(context, "__xript_fire_handlers");
	const keyStr = context.newString(registryKey);

	const callResult = context.callFunction(fireFn, context.undefined, keyStr, dataHandle);
	keyStr.dispose();
	if (data !== undefined) safeDispose(context, dataHandle);
	fireFn.dispose();

	if (callResult.error) {
		const dumped = budgeted ? (context.dump(callResult.error) as { message?: string } | undefined) : undefined;
		callResult.error.dispose();
		if (budgeted) throw new Error(dumped?.message ?? String(dumped));
		return [];
	}

	const arrHandle = callResult.value;
	try {
		const lengthHandle = context.getProp(arrHandle, "length");
		const length = context.getNumber(lengthHandle);
		lengthHandle.dispose();

		const results: unknown[] = [];
		for (let i = 0; i < length; i++) {
			const elemHandle = context.getProp(arrHandle, i);
			try {
				results.push(readResult(context, elemHandle));
			} finally {
				elemHandle.dispose();
			}
		}
		return results;
	} finally {
		arrHandle.dispose();
	}
}

export type FragmentOpName =
	| "toggle"
	| "setText"
	| "replaceChildren"
	| "setProp"
	| "setAttr"
	| "removeAttr"
	| "addClass"
	| "removeClass";

/**
 * A command buffer entry. `selector` is the raw target string the mod passed and is always
 * populated: for an HTML-vocabulary fragment it is a working CSS selector, exactly as it
 * always was. `target` is that string parsed into a node reference, which resolves in any
 * vocabulary when it is an id.
 */
export interface FragmentOp {
	op: FragmentOpName;
	selector: string;
	target: NodeRef;
	/** `setProp` / `setAttr` / `removeAttr`. */
	prop?: string;
	/** @deprecated Alias of `prop`, populated only for `setAttr` and `removeAttr`. */
	attr?: string;
	/** Absent on `removeAttr`. */
	value?: unknown;
}

/** An op as it leaves the sandbox, before the host-side pass parses and sanitizes it. */
export interface RawFragmentOp {
	op: FragmentOpName;
	selector: string;
	prop?: string;
	attr?: string;
	value?: unknown;
}

function harvestModuleExports(
	context: QuickJSAsyncContext,
	namespace: QuickJSHandle,
	modName: string,
): string[] {
	const harvestFn = internal(context, "__xript_harvest_exports");
	const callResult = context.callFunction(harvestFn, context.undefined, namespace);
	harvestFn.dispose();
	if (namespace.alive) namespace.dispose();

	if (callResult.error) {
		const errorObj = context.dump(callResult.error) as { message?: string } | undefined;
		callResult.error.dispose();
		throw new ModEntryError(
			modName,
			`could not read the module's exports: ${errorObj?.message || String(errorObj)}`,
		);
	}

	const harvested = context.dump(callResult.value) as string[];
	callResult.value.dispose();
	return Array.isArray(harvested) ? harvested : [];
}

export interface SandboxResult {
	execute: (code: string) => ExecutionResult;
	executeAsync: (code: string) => Promise<ExecutionResult>;
	debugExecute: (code: string) => Promise<ExecutionResult>;
	evaluateModule: (modName: string, code: string) => Promise<string[]>;
	/**
	 * `timeoutOverrideMs` stands in for the manifest-wide budget for this one
	 * call — a slot's `limits.timeout_ms` arrives here. The embedder's hard
	 * ceiling still clamps it, so a manifest cannot buy more than the host gave.
	 * `refusePromise` is set by the host-facing synchronous invocations: an export that ends in a
	 * promise is refused rather than handed over unsettled, and in the async sandbox an async
	 * binding refuses to start during the call. A hook fill dispatch leaves it unset.
	 */
	invokeExport: (name: string, args: unknown[], owner?: string, timeoutOverrideMs?: number, refusePromise?: boolean) => unknown;
	invokeExportAsync: (
		name: string,
		args: unknown[],
		owner?: string,
		timeoutOverrideMs?: number,
	) => Promise<unknown>;
	/**
	 * Scopes every subsequent `xript.exports.register` / module harvest to the named
	 * mod's own export namespace. Pass `null` to return to the host bucket.
	 */
	setExportOwner: (owner: string | null) => void;
	fireHook: (hookName: string, options?: FireHookOptions) => unknown[];
	fireFragmentHook: (fragmentId: string, lifecycle: string, bindings?: Record<string, unknown>) => RawFragmentOp[];
	emit: (eventId: string, payload?: unknown) => unknown[];
	/** {@link emit} with each result tagged by the mod that subscribed the handler. */
	emitTagged: (eventId: string, payload?: unknown) => EmitResult[];
	/** Cancels every subscription `owner` holds and returns how many there were. */
	cancelOwned: (owner: string | null) => number;
	/** Adds an event to the catalogue at runtime; returns the entry as stored. */
	declareEvent: (entry: unknown) => unknown;
	/** Which mod is running right now; the runtime pushes it around every entry into a mod. */
	callerContext: CallerContext;
	debugSession: () => DebugSession | null;
	/** Releases every retained callback the named mod supplied; returns how many. */
	releaseRetained: (modName: string) => number;
	dispose: () => void;
}

function busArgs(payload: unknown): unknown[] {
	return payload === undefined ? [] : [payload];
}

/**
 * The deadline a hook or event fire runs under when the host opted into handler budgets: `arm`
 * pushes it and returns its pop, and `stopped` turns the interruption that ends an over-budget
 * fire into the execution-limit error `execute` would have raised.
 */
interface FireBudget {
	arm(limitMs: number): () => void;
	stopped(error: unknown, limitMs: number): unknown;
}

function fireBudget(
	pushInterruptFrame: (deadline: number, cancellation?: CancellationToken) => () => void,
	cancellation: CancellationToken | undefined,
): FireBudget {
	return {
		arm: (limitMs) => pushInterruptFrame(Date.now() + limitMs, cancellation),
		stopped: (error, limitMs) => interruptAsLimit(error, limitMs, cancellation),
	};
}

/**
 * The host side of the bus. An emit restores the caller stack on the way out: a handler stopped
 * by its deadline never runs the kernel's per-handler pop.
 */
function busSurface(bus: EventBus, callerContext: CallerContext, budget?: FireBudget, limitMs = DEFAULT_TIMEOUT_MS) {
	const emitTagged = (eventId: string, payload?: unknown): EmitResult[] => {
		const depth = callerContext.depth;
		const disarm = budget?.arm(limitMs);
		try {
			return bus.emit(eventId, busArgs(payload));
		} catch (error) {
			throw budget ? budget.stopped(error, limitMs) : error;
		} finally {
			disarm?.();
			callerContext.unwindTo(depth);
		}
	};
	return {
		emit: (eventId: string, payload?: unknown) => emitTagged(eventId, payload).map((result) => result.value),
		emitTagged,
		cancelOwned: (owner: string | null) => bus.cancelOwned(owner),
		declareEvent: (entry: unknown) => bus.declare(entry),
		callerContext,
	};
}

/**
 * The current value of each top-level binding the runtime may install a built-in over, taken
 * once bindings are in place so the end of construction can tell which ones a built-in replaced.
 */
function captureShadowable(
	context: QuickJSContext | QuickJSAsyncContext,
	bindings: Record<string, unknown> | undefined,
): Array<[string, QuickJSHandle]> {
	if (!bindings) return [];
	return SHADOWING_BUILTINS.filter((name) => Object.prototype.hasOwnProperty.call(bindings, name)).map((name) => [
		name,
		context.getProp(context.global, name),
	]);
}

/** The captured bindings whose global no longer holds the host's value; disposes the captures. */
function replacedBindings(context: QuickJSContext | QuickJSAsyncContext, captured: Array<[string, QuickJSHandle]>): string[] {
	const replaced: string[] = [];
	for (const [name, before] of captured) {
		const after = context.getProp(context.global, name);
		if (!context.sameValue(before, after)) replaced.push(name);
		safeDispose(context, after);
		safeDispose(context, before);
	}
	return replaced;
}

/**
 * The schema default deadline, applied where neither a slot nor the manifest
 * declares one. Pinned by `spec/slot-limit-tests.json`.
 */
export const DEFAULT_TIMEOUT_MS = 5000;

function clampLimit(requested: number | undefined, hard: number | undefined): number | undefined {
	if (requested === undefined) return hard;
	if (hard === undefined) return requested;
	return Math.min(requested, hard);
}

interface InterruptFrame {
	deadline: number;
	cancellation?: CancellationToken;
}

/**
 * Tracks nested execution regions behind a single interrupt handler. QuickJS
 * permits reentrant evaluation, so a host binding can call back into
 * `execute` / `invokeExport` / `evaluateModule` while an outer call is still
 * running. Arming and clearing the handler per call lets the inner region's
 * clear disarm the outer one for the rest of its execution; a frame stack
 * cannot, because the handler stays installed until the stack empties and the
 * tightest live deadline always governs.
 */
function createInterruptStack(runtime: QuickJSRuntime | QuickJSAsyncRuntime, callerContext: CallerContext) {
	const frames: InterruptFrame[] = [];

	function due(): boolean {
		for (const frame of frames) {
			if (frame.cancellation?.cancelled) return true;
			if (Date.now() >= frame.deadline) return true;
		}
		return false;
	}

	const handler = guardEngineCallback(runtime, due, true);

	return function pushInterruptFrame(deadline: number, cancellation?: CancellationToken): () => void {
		const frame: InterruptFrame = { deadline, cancellation };
		frames.push(frame);
		if (frames.length === 1) runtime.setInterruptHandler(handler);
		const callerDepth = callerContext.depth;

		let popped = false;
		return () => {
			if (popped) return;
			popped = true;
			callerContext.unwindTo(callerDepth);
			const index = frames.lastIndexOf(frame);
			if (index !== -1) frames.splice(index, 1);
			if (frames.length === 0) runtime.removeInterruptHandler();
		};
	};
}

function makeAuditEmitter(audit?: (event: AuditEvent) => void): ((binding: string, capability: string | null) => void) | undefined {
	if (!audit) return undefined;
	return (binding, capability) => emitAudit(audit, binding, capability);
}

/** The one execution-limit error, so every path that reports a deadline reports it identically. */
function executionLimitError(timeoutMs: number): Error {
	return Object.assign(
		new Error(`Script timed out after ${timeoutMs}ms. Optimize your script or ask the app developer to increase the limit.`),
		{ name: "ExecutionLimitError", limit: "timeout_ms" },
	);
}

/**
 * An invocation stopped by its deadline surfaces from QuickJS as an ordinary
 * invocation failure carrying an "interrupted" message. `execute` already maps
 * that to an execution-limit error; an export invocation has to report it the
 * same way rather than blaming the export for the host's budget.
 */
function interruptAsLimit(error: unknown, timeoutMs: number, cancellation?: CancellationToken): unknown {
	const message = error instanceof Error ? error.message : "";
	if (!message.includes("interrupted")) return error;
	if (cancellation?.cancelled) return new CancellationError();
	return executionLimitError(timeoutMs);
}

function throwFromError(
	errorObj: { message?: string; name?: string } | null | undefined,
	timeoutMs: number,
	cancellation?: CancellationToken,
): never {
	const interrupted =
		errorObj && typeof errorObj === "object" && typeof errorObj.message === "string" && errorObj.message.includes("interrupted");

	if (interrupted) {
		if (cancellation?.cancelled) {
			throw new CancellationError();
		}
		throw executionLimitError(timeoutMs);
	}

	const err = new Error(errorObj?.message || String(errorObj));
	if (errorObj?.name) err.name = errorObj.name;
	Object.assign(err, errorObj);
	throw err;
}

/** Installs `value` as a non-writable, non-configurable global no script can replace or delete. */
function lockGlobal(context: QuickJSContext | QuickJSAsyncContext, name: string, value: QuickJSHandle): void {
	const lock = internal(context, "lock");
	const key = context.newString(name);
	const result = context.callFunction(lock, context.undefined, context.global, key, value);
	key.dispose();
	lock.dispose();
	context.unwrapResult(result).dispose();
}

function injectDebugProbe(context: QuickJSAsyncContext, controller: DebugController): void {
	const shouldStop = controller.makeShouldStop();
	const pause = controller.makePause();

	const shouldFn = context.newFunction(controller.probeNames.shouldStop, (lineHandle: QuickJSHandle) => {
		const line = context.dump(lineHandle) as number;
		return shouldStop(line) ? context.true : context.false;
	});
	lockGlobal(context, controller.probeNames.shouldStop, shouldFn);
	shouldFn.dispose();

	const pauseFn = context.newAsyncifiedFunction(controller.probeNames.pause, async (...handles: QuickJSHandle[]) => {
		const line = context.dump(handles[0]) as number;
		const column = context.dump(handles[1]) as number;
		const locals = handles.length > 2 ? (readResult(context, handles[2], false) as Record<string, unknown>) : {};
		await pause(line, column, locals);
		return context.undefined;
	});
	lockGlobal(context, controller.probeNames.pause, pauseFn);
	pauseFn.dispose();
}

export function createSandboxSync(
	quickjs: QuickJSWASMModule,
	options: SandboxOptions,
): SandboxResult {
	if (options.debug) {
		throw new DebugUnsupportedError(
			"Debugging requires the async sandbox. Use createSandboxAsync (the QuickJS-WASM sync sandbox cannot pause synchronously).",
		);
	}
	const { manifest, capabilities = [], cancellation } = options;
	const callerContext = new CallerContext();
	const hostBindings = resolveCallerAware(options.hostBindings, callerContext);
	const grantedCapabilities = new Set(capabilities);
	validateLibraryRegistration(manifest, options.libraries);
	const limits = manifest.limits || {};
	const hard = options.hardLimits || {};
	const timeoutMs = clampLimit(limits.timeout_ms ?? 5000, hard.timeout_ms) ?? 5000;
	/**
	 * The budget governing one call. An override (a slot's `limits.timeout_ms`)
	 * replaces the manifest's, and is clamped to the embedder's ceiling rather
	 * than trusted, so a slot may widen only as far as the host allows.
	 */
	const callTimeoutMs = (overrideMs?: number): number =>
		overrideMs === undefined ? timeoutMs : (clampLimit(overrideMs, hard.timeout_ms) ?? timeoutMs);
	const memoryMb = clampLimit(limits.memory_mb, hard.memory_mb);
	const maxStackDepth = clampLimit(limits.max_stack_depth, hard.max_stack_depth);
	const auditEmit = makeAuditEmitter(options.audit);

	const runtime = quickjs.newRuntime();
	const pushInterruptFrame = createInterruptStack(runtime, callerContext);

	if (memoryMb) {
		runtime.setMemoryLimit(memoryMb * 1024 * 1024);
	}
	runtime.setMaxStackSize(stackLimitBytes(maxStackDepth));

	const context = runtime.newContext();
	guardHostCallbacks(context);
	const retained = configureCallbacks(context, manifest.types, {
		callerContext,
		limit: limits.max_retained_callbacks ?? DEFAULT_MAX_RETAINED_CALLBACKS,
		timeoutMs,
		pushInterruptFrame,
		cancellation,
	}).retained!;

	const sandboxConsole = options.console ?? {};

	const asyncBindingNames = collectAsyncBindingNames(manifest.bindings);
	if (asyncBindingNames.length > 0) {
		dispatchConsole(sandboxConsole, "warn", "warn", [
			`xript: the synchronous sandbox cannot await async bindings, so ${asyncBindingNames.map((n) => `${n}()`).join(", ")} will throw if called. Create the runtime with initXriptAsync() to enable them.`,
		]);
	}

	injectConsole(context, sandboxConsole);
	blockCodeGeneration(context);
	injectErrorClasses(context);
	injectBindings(context, manifest, hostBindings, grantedCapabilities, null, auditEmit);
	const shadowable = captureShadowable(context, manifest.bindings);
	const deprecations = new DeprecationChannel(options.onDeprecation);
	const handlerBudget = options.budgetHandlers ? fireBudget(pushInterruptFrame, cancellation) : undefined;
	const clock: HandlerClock = handlerBudget ? UNTIMED : unbudgetedHandlerClock(timeoutMs, deprecations);
	injectHooks(context, manifest, grantedCapabilities, callerContext, clock);
	const bus = installEventBus(context, manifest.events, grantedCapabilities, callerContext, clock);
	injectFragmentAPI(context);
	injectExportsAPI(context);
	freezeHooksAndFragments(context, manifest);
	reportShadowedBindings(deprecations, replacedBindings(context, shadowable));
	sealGlobals(context, manifest);

	function execute(code: string): ExecutionResult {
		if (cancellation?.cancelled) throw new CancellationError();
		const popInterrupt = pushInterruptFrame(Date.now() + timeoutMs, cancellation);
		const start = performance.now();
		let result;
		try {
			result = context.evalCode(code, "xript-script.js");
		} finally {
			popInterrupt();
		}
		const duration_ms = performance.now() - start;

		if (result.error) {
			const errorObj = context.dump(result.error);
			result.error.dispose();
			throwFromError(errorObj, timeoutMs, cancellation);
		}

		refusePromiseResult(context, result.value);
		const value = readAndRelease(context, result.value);
		return { value, duration_ms };
	}

	async function executeAsync(code: string): Promise<ExecutionResult> {
		if (cancellation?.cancelled) throw new CancellationError();
		const wrappedCode = `(async () => { ${code}\n})()`;
		const popInterrupt = pushInterruptFrame(Date.now() + timeoutMs, cancellation);
		const start = performance.now();
		let result;
		try {
			result = context.evalCode(wrappedCode, "xript-script.js");
		} finally {
			popInterrupt();
		}

		if (result.error) {
			const errorObj = context.dump(result.error);
			if (result.error.alive) result.error.dispose();
			throwFromError(errorObj, timeoutMs, cancellation);
		}

		const promiseHandle = result.value;
		const resolved = context.resolvePromise(promiseHandle);
		if (promiseHandle.alive) promiseHandle.dispose();
		runtime.executePendingJobs();

		const awaited = await resolved;
		const duration_ms = performance.now() - start;

		if (awaited.error) {
			const errorObj = context.dump(awaited.error);
			if (awaited.error.alive) awaited.error.dispose();
			throwFromError(errorObj, timeoutMs, cancellation);
		}

		const value = readAndRelease(context, awaited.value);
		return { value, duration_ms };
	}

	function invokeExport(name: string, args: unknown[], owner?: string, timeoutOverrideMs?: number, refusePromise = false): unknown {
		if (cancellation?.cancelled) throw new CancellationError();
		const budgetMs = callTimeoutMs(timeoutOverrideMs);
		const popInterrupt = pushInterruptFrame(Date.now() + budgetMs, cancellation);
		try {
			return callerContext.run(exportCaller(context, name, owner), () =>
				invokeExportInContext(context, name, args, owner, refusePromise),
			);
		} catch (error) {
			throw interruptAsLimit(error, budgetMs, cancellation);
		} finally {
			popInterrupt();
		}
	}

	async function invokeExportAsync(
		name: string,
		args: unknown[],
		owner?: string,
		timeoutOverrideMs?: number,
	): Promise<unknown> {
		if (cancellation?.cancelled) throw new CancellationError();
		const budgetMs = callTimeoutMs(timeoutOverrideMs);
		const popInterrupt = pushInterruptFrame(Date.now() + budgetMs, cancellation);
		try {
			return await callerContext.runAsync(exportCaller(context, name, owner), () =>
				invokeExportAsyncInContext(context, runtime, name, args, owner),
			);
		} catch (error) {
			throw interruptAsLimit(error, budgetMs, cancellation);
		} finally {
			popInterrupt();
		}
	}

	function setExportOwner(owner: string | null): void {
		setExportOwnerInContext(context, owner);
	}

	function fireHook(hookName: string, opts?: FireHookOptions): unknown[] {
		const depth = callerContext.depth;
		if (!handlerBudget) {
			try {
				return fireHookInContext(context, manifest, hookName, opts);
			} finally {
				callerContext.unwindTo(depth);
			}
		}
		const limitMs = callTimeoutMs(effectiveHooks(manifest)[hookName]?.limits?.timeout_ms);
		const disarm = handlerBudget.arm(limitMs);
		try {
			return fireHookInContext(context, manifest, hookName, opts, true);
		} catch (error) {
			const stopped = handlerBudget.stopped(error, limitMs);
			if (stopped !== error) throw stopped;
			return [];
		} finally {
			disarm();
			callerContext.unwindTo(depth);
		}
	}

	function fireFragmentHook(fragmentId: string, lifecycle: string, bindings?: Record<string, unknown>): RawFragmentOp[] {
		return fireFragmentHookInContext(context, fragmentId, lifecycle, bindings);
	}

	function releaseRetained(modName: string): number {
		return retained.releaseOwner(modName);
	}

	function debugExecute(): Promise<ExecutionResult> {
		return Promise.reject(
			new DebugUnsupportedError("Debugging requires the async sandbox; this sync sandbox has no debug session."),
		);
	}

	function evaluateModule(): Promise<string[]> {
		return Promise.reject(new ModuleUnsupportedError());
	}

	function debugSession(): DebugSession | null {
		return null;
	}

	function dispose(): void {
		if (isExhausted(context)) return;
		bus.dispose();
		releaseConsoleSupport(context);
		releaseCallbackSupport(context);
		releaseInternals(context);
		context.dispose();
		runtime.dispose();
	}

	return containSurface(context, { execute, executeAsync, debugExecute, evaluateModule, invokeExport, invokeExportAsync, setExportOwner, fireHook, fireFragmentHook, ...busSurface(bus, callerContext, handlerBudget, callTimeoutMs()), debugSession, releaseRetained, dispose });
}

export async function createSandboxAsync(
	options: SandboxOptions,
	variant?: AsyncVariant,
): Promise<SandboxResult> {
	const { newAsyncContext } = await import("#quickjs-async");

	const { manifest, capabilities = [], cancellation } = options;
	const callerContext = new CallerContext();
	const hostBindings = resolveCallerAware(options.hostBindings, callerContext);
	const grantedCapabilities = new Set(capabilities);
	const limits = manifest.limits || {};
	const hard = options.hardLimits || {};
	const timeoutMs = clampLimit(limits.timeout_ms ?? 5000, hard.timeout_ms) ?? 5000;
	/**
	 * The budget governing one call. An override (a slot's `limits.timeout_ms`)
	 * replaces the manifest's, and is clamped to the embedder's ceiling rather
	 * than trusted, so a slot may widen only as far as the host allows.
	 */
	const callTimeoutMs = (overrideMs?: number): number =>
		overrideMs === undefined ? timeoutMs : (clampLimit(overrideMs, hard.timeout_ms) ?? timeoutMs);
	const memoryMb = clampLimit(limits.memory_mb, hard.memory_mb);
	const maxStackDepth = clampLimit(limits.max_stack_depth, hard.max_stack_depth);
	const auditEmit = makeAuditEmitter(options.audit);

	const context = await newAsyncContext(variant);
	guardHostCallbacks(context);
	const runtime = context.runtime;
	const pushInterruptFrame = createInterruptStack(runtime, callerContext);
	const retained = configureCallbacks(context, manifest.types, {
		callerContext,
		limit: limits.max_retained_callbacks ?? DEFAULT_MAX_RETAINED_CALLBACKS,
		timeoutMs,
		pushInterruptFrame,
		cancellation,
	}).retained!;

	validateLibraryRegistration(manifest, options.libraries);
	const resolveLibrary = makeLibraryResolver(manifest, options.libraries, grantedCapabilities);

	runtime.setModuleLoader((moduleName) => {
		try {
			return { value: resolveLibrary(moduleName) };
		} catch (error) {
			return { error: error as Error };
		}
	});

	if (memoryMb) {
		runtime.setMemoryLimit(memoryMb * 1024 * 1024);
	}
	runtime.setMaxStackSize(stackLimitBytes(maxStackDepth, SAFE_ASYNC_STACK_BYTES));

	const sandboxConsole = options.console ?? {};

	const debugController = options.debug ? createDebugController(options.debug, "instrumented") : null;

	injectConsole(context, sandboxConsole);
	blockCodeGeneration(context);
	injectErrorClasses(context);
	injectBindings(context, manifest, hostBindings, grantedCapabilities, callerContext, auditEmit);
	const shadowable = captureShadowable(context, manifest.bindings);
	const deprecations = new DeprecationChannel(options.onDeprecation);
	const handlerBudget = options.budgetHandlers ? fireBudget(pushInterruptFrame, cancellation) : undefined;
	const clock: HandlerClock = handlerBudget ? UNTIMED : unbudgetedHandlerClock(timeoutMs, deprecations);
	injectHooks(context, manifest, grantedCapabilities, callerContext, clock);
	const bus = installEventBus(context, manifest.events, grantedCapabilities, callerContext, clock);
	injectFragmentAPI(context);
	injectExportsAPI(context);
	freezeHooksAndFragments(context, manifest);
	reportShadowedBindings(deprecations, replacedBindings(context, shadowable));
	sealGlobals(context, manifest);

	if (debugController) {
		injectDebugProbe(context, debugController);
	}


	const stalls = new Set<(failure: unknown) => void>();
	const asyncHost: AsyncHost = { drain: drainWithin, syncDepth: 0, pending: new Set() };
	asyncHosts.set(context, asyncHost);

	/**
	 * Drains the job queue in `lane` under a fresh budget: the continuations it runs belong to
	 * the call that queued them, so they are credited to that call's mod rather than to whichever
	 * call drains them. A continuation stopped by its budget can never settle the call it belongs
	 * to, so every call still waiting is failed with the stop instead of waiting forever.
	 */
	function drainWithin(lane: CallerLane): void {
		if (isExhausted(context)) return;
		const popInterrupt = pushInterruptFrame(Date.now() + timeoutMs, cancellation);
		let drained;
		try {
			drained = callerContext.within(lane, () => runtime.executePendingJobs());
		} catch (error) {
			const failure = containFault(context, error);
			for (const stall of [...stalls]) stall(failure);
			return;
		} finally {
			popInterrupt();
		}
		if (drained.error) {
			const failure = context.dump(drained.error);
			if (drained.error.alive) drained.error.dispose();
			for (const stall of [...stalls]) stall(failure);
		}
	}

	/** Waits for a call's promise, or for a drain that stopped the continuation it waits on. */
	function untilSettled<T>(pending: Promise<T>): Promise<T> {
		let stall: (failure: unknown) => void = () => undefined;
		const stalled = new Promise<never>((_, reject) => {
			stall = reject;
		});
		stalls.add(stall);
		return Promise.race([pending, stalled]).finally(() => stalls.delete(stall));
	}

	/**
	 * Invokes an export and waits on what it returns. The invocation and the first drain of the
	 * job queue run back to back, before any other call can queue work, so everything that drain
	 * runs belongs to this call; an export awaiting an async binding resumes when it settles.
	 */
	async function invokeSuspendable(name: string, args: unknown[], owner: string | undefined): Promise<unknown> {
		const lane = callerContext.lane();
		const result = callInvokeExport(context, name, args, owner);
		if (result.error) {
			const errorObj = context.dump(result.error) as InvokeErrorDump;
			if (result.error.alive) result.error.dispose();
			throwInvokeFailure(errorObj, name);
		}
		const resolved = context.resolvePromise(result.value);
		if (result.value.alive) result.value.dispose();
		drainWithin(lane);
		let awaited;
		try {
			awaited = await untilSettled(resolved);
		} catch (failure) {
			if (failure instanceof Error) throw failure;
			throwInvokeFailure(failure as InvokeErrorDump, name);
		}
		if (awaited.error) {
			const errorObj = context.dump(awaited.error) as InvokeErrorDump;
			if (awaited.error.alive) awaited.error.dispose();
			throwInvokeFailure(errorObj, name);
		}
		const value = readAndRelease(context, awaited.value);
		return value;
	}

	function execute(code: string): ExecutionResult {
		if (cancellation?.cancelled) throw new CancellationError();
		const popInterrupt = pushInterruptFrame(Date.now() + timeoutMs, cancellation);
		const start = performance.now();
		let result;
		asyncHost.syncDepth++;
		try {
			result = context.evalCode(code, "xript-script.js");
		} finally {
			asyncHost.syncDepth--;
			popInterrupt();
		}
		const duration_ms = performance.now() - start;

		if (result.error) {
			const errorObj = context.dump(result.error);
			result.error.dispose();
			throwFromError(errorObj, timeoutMs, cancellation);
		}

		refusePromiseResult(context, result.value);
		const value = readAndRelease(context, result.value);
		return { value, duration_ms };
	}

	async function debugExecute(code: string): Promise<ExecutionResult> {
		if (cancellation?.cancelled) throw new CancellationError();
		if (!debugController) {
			throw new DebugUnsupportedError("no debug session is attached to this runtime");
		}
		const { code: instrumented, breakableLines } = instrumentSource(code, debugController.probeNames);
		debugController.setBreakableLines("xript-script.js", breakableLines);
		const wrappedCode = `(async () => { ${instrumented}\n})()`;
		const start = performance.now();
		const lane = callerContext.lane();
		const result = await context.evalCodeAsync(wrappedCode, "xript-script.js");

		if (result.error) {
			const errorObj = context.dump(result.error);
			if (result.error.alive) result.error.dispose();
			throwFromError(errorObj, timeoutMs, cancellation);
		}

		const promiseHandle = result.value;
		const resolved = context.resolvePromise(promiseHandle);
		if (promiseHandle.alive) promiseHandle.dispose();
		drainWithin(lane);

		const awaited = await resolved;
		const duration_ms = performance.now() - start;

		if (awaited.error) {
			const errorObj = context.dump(awaited.error);
			if (awaited.error.alive) awaited.error.dispose();
			throwFromError(errorObj, timeoutMs, cancellation);
		}

		const value = readAndRelease(context, awaited.value);
		debugController.session.resume();
		return { value, duration_ms };
	}

	function debugSession(): DebugSession | null {
		return debugController ? debugController.session : null;
	}

	async function evaluateModule(modName: string, code: string): Promise<string[]> {
		if (cancellation?.cancelled) throw new CancellationError();

		for (const { specifier, dynamic } of findImportSpecifiers(code)) {
			if (dynamic) throw new ImportDeniedError(specifier);
			resolveLibrary(specifier);
		}

		const popInterrupt = pushInterruptFrame(Date.now() + timeoutMs, cancellation);
		const lane = callerContext.lane();
		let namespace: QuickJSHandle;
		try {
			const result = await context.evalCodeAsync(code, `xript-mod-${modName}.js`, { type: "module" });
			if (result.error) {
				const errorObj = context.dump(result.error) as { message?: string } | undefined;
				if (result.error.alive) result.error.dispose();
				throw new ModEntryError(modName, errorObj?.message || String(errorObj));
			}

			const resolved = context.resolvePromise(result.value);
			if (result.value.alive) result.value.dispose();
			drainWithin(lane);
			const awaited = await resolved;
			if (awaited.error) {
				const errorObj = context.dump(awaited.error) as { message?: string } | undefined;
				if (awaited.error.alive) awaited.error.dispose();
				throw new ModEntryError(modName, errorObj?.message || String(errorObj));
			}
			namespace = awaited.value;
		} finally {
			popInterrupt();
		}

		return harvestModuleExports(context, namespace, modName);
	}

	async function executeAsync(code: string): Promise<ExecutionResult> {
		if (cancellation?.cancelled) throw new CancellationError();
		const wrappedCode = `(async () => { ${code}\n})()`;
		const popInterrupt = pushInterruptFrame(Date.now() + timeoutMs, cancellation);
		const start = performance.now();
		const lane = callerContext.lane();
		let result;
		try {
			result = context.evalCode(wrappedCode, "xript-script.js");
		} finally {
			popInterrupt();
		}

		if (result.error) {
			const errorObj = context.dump(result.error);
			if (result.error.alive) result.error.dispose();
			throwFromError(errorObj, timeoutMs, cancellation);
		}

		const promiseHandle = result.value;
		const resolved = context.resolvePromise(promiseHandle);
		if (promiseHandle.alive) promiseHandle.dispose();
		drainWithin(lane);

		let awaited;
		try {
			awaited = await untilSettled(resolved);
		} catch (failure) {
			if (failure instanceof Error) throw failure;
			throwFromError(failure as { message?: string; name?: string }, timeoutMs, cancellation);
		}
		const duration_ms = performance.now() - start;

		if (awaited.error) {
			const errorObj = context.dump(awaited.error);
			if (awaited.error.alive) awaited.error.dispose();
			throwFromError(errorObj, timeoutMs, cancellation);
		}

		const value = readAndRelease(context, awaited.value);
		return { value, duration_ms };
	}

	function invokeExport(name: string, args: unknown[], owner?: string, timeoutOverrideMs?: number, refusePromise = false): unknown {
		if (cancellation?.cancelled) throw new CancellationError();
		const budgetMs = callTimeoutMs(timeoutOverrideMs);
		const popInterrupt = pushInterruptFrame(Date.now() + budgetMs, cancellation);
		if (refusePromise) asyncHost.syncDepth++;
		try {
			return callerContext.run(exportCaller(context, name, owner), () =>
				invokeExportInContext(context, name, args, owner, refusePromise),
			);
		} catch (error) {
			throw interruptAsLimit(error, budgetMs, cancellation);
		} finally {
			if (refusePromise) asyncHost.syncDepth--;
			popInterrupt();
		}
	}

	async function invokeExportAsync(
		name: string,
		args: unknown[],
		owner?: string,
		timeoutOverrideMs?: number,
	): Promise<unknown> {
		if (cancellation?.cancelled) throw new CancellationError();
		const budgetMs = callTimeoutMs(timeoutOverrideMs);
		const popInterrupt = pushInterruptFrame(Date.now() + budgetMs, cancellation);
		try {
			return await callerContext.runAsync(exportCaller(context, name, owner), () =>
				invokeSuspendable(name, args, owner),
			);
		} catch (error) {
			throw interruptAsLimit(error, budgetMs, cancellation);
		} finally {
			popInterrupt();
		}
	}

	function setExportOwner(owner: string | null): void {
		setExportOwnerInContext(context, owner);
	}

	function fireHook(hookName: string, opts?: FireHookOptions): unknown[] {
		const depth = callerContext.depth;
		if (!handlerBudget) {
			try {
				return fireHookInContext(context, manifest, hookName, opts);
			} finally {
				callerContext.unwindTo(depth);
			}
		}
		const limitMs = callTimeoutMs(effectiveHooks(manifest)[hookName]?.limits?.timeout_ms);
		const disarm = handlerBudget.arm(limitMs);
		try {
			return fireHookInContext(context, manifest, hookName, opts, true);
		} catch (error) {
			const stopped = handlerBudget.stopped(error, limitMs);
			if (stopped !== error) throw stopped;
			return [];
		} finally {
			disarm();
			callerContext.unwindTo(depth);
		}
	}

	function fireFragmentHook(fragmentId: string, lifecycle: string, bindings?: Record<string, unknown>): RawFragmentOp[] {
		return fireFragmentHookInContext(context, fragmentId, lifecycle, bindings);
	}

	function releaseRetained(modName: string): number {
		return retained.releaseOwner(modName);
	}

	function dispose(): void {
		if (isExhausted(context)) {
			asyncHost.pending.clear();
			return;
		}
		bus.dispose();
		for (const deferred of asyncHost.pending) deferred.dispose();
		asyncHost.pending.clear();
		releaseConsoleSupport(context);
		releaseCallbackSupport(context);
		releaseInternals(context);
		context.dispose();
		runtime.dispose();
	}

	return containSurface(context, { execute, executeAsync, debugExecute, evaluateModule, invokeExport, invokeExportAsync, setExportOwner, fireHook, fireFragmentHook, ...busSurface(bus, callerContext, handlerBudget, callTimeoutMs()), debugSession, releaseRetained, dispose });
}
