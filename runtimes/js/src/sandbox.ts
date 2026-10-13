import type {
	QuickJSContext,
	QuickJSHandle,
	QuickJSRuntime,
	QuickJSAsyncContext,
	QuickJSAsyncRuntime,
	QuickJSWASMModule,
	AsyncFunctionImplementation,
} from "quickjs-emscripten-core";
import type { AsyncVariant } from "./quickjs-loader.js";
import { AmbiguousExportError, BindingError, CapabilityDeniedError, CancellationError, InvokeError, ModEntryError, ImportDeniedError, ModuleUnsupportedError, LibraryUnavailableError, LibraryRegistrationError } from "./errors.js";
import { grantedSatisfies } from "./capabilities.js";
import { findImportSpecifier, findImportSpecifiers, detectCommonJS } from "./module-support.js";
import { marshalToQuickJS, safeDispose } from "./marshal.js";
import { CallbackScope, callbackSupportFor, functionParamChecks, functionParamViolation, releaseCallbackSupport } from "./callbacks.js";
import type { DebugOptions, DebugSession } from "./debug-types.js";
import { DebugUnsupportedError } from "./debug-types.js";
import { createDebugController, type DebugController } from "./debug-session.js";
import { instrumentSource } from "./debug-instrument.js";
import type { NodeRef } from "./fragment.js";

function createCapabilityError(
	context: QuickJSContext | QuickJSAsyncContext,
	binding: string,
	capability: string,
): { error: QuickJSHandle } {
	const err = context.newError(
		`${binding}() requires the "${capability}" capability, which hasn't been granted to this script. Ask the app developer to enable it.`,
	);
	const nameStr = context.newString("CapabilityDeniedError");
	context.setProp(err, "name", nameStr);
	nameStr.dispose();
	const capStr = context.newString(capability);
	context.setProp(err, "capability", capStr);
	capStr.dispose();
	const bindStr = context.newString(binding);
	context.setProp(err, "binding", bindStr);
	bindStr.dispose();
	return { error: err };
}

function createBindingError(
	context: QuickJSContext | QuickJSAsyncContext,
	binding: string,
	message: string,
): { error: QuickJSHandle } {
	const err = context.newError(`${binding}(): ${message}`);
	const nameStr = context.newString("BindingError");
	context.setProp(err, "name", nameStr);
	nameStr.dispose();
	const bindStr = context.newString(binding);
	context.setProp(err, "binding", bindStr);
	bindStr.dispose();
	return { error: err };
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

type Binding = FunctionBinding | NamespaceBinding;

interface FunctionBinding {
	description: string;
	params?: Parameter[];
	returns?: unknown;
	async?: boolean;
	capability?: string;
	deprecated?: string;
}

interface NamespaceBinding {
	description: string;
	members: Record<string, Binding>;
}

interface Parameter {
	name: string;
	type: unknown;
	default?: unknown;
	required?: boolean;
}

interface CapabilityDef {
	description: string;
	risk?: string;
}

interface ExecutionLimits {
	timeout_ms?: number;
	memory_mb?: number;
	max_stack_depth?: number;
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
	[key: string]: HostFunction | HostNamespace;
}
export type HostBindings = Record<string, HostFunction | HostNamespace>;

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

/**
 * Every binding the manifest declares that the host did not supply, fully qualified and sorted.
 *
 * A declared-but-unsupplied binding still installs — as a stub that throws when a mod calls it —
 * so the manifest and the host's actual wiring could disagree indefinitely with nothing to catch
 * it. A mod author reads the manifest, ships against a binding that is documented and absent, and
 * the failure lands on a user. This is the drift, computed once at construction so a host can see
 * it before a mod does.
 */
export function missingBindingNames(
	bindings: Record<string, Binding> | undefined,
	hostBindings: Record<string, unknown> | undefined,
	prefix = "",
): string[] {
	if (!bindings) return [];
	const missing: string[] = [];
	for (const [name, binding] of Object.entries(bindings)) {
		const qualified = prefix ? `${prefix}.${name}` : name;
		const supplied = hostBindings?.[name];
		if (isNamespace(binding)) {
			const nested = typeof supplied === "object" && supplied !== null ? (supplied as Record<string, unknown>) : undefined;
			missing.push(...missingBindingNames(binding.members, nested, qualified));
		} else if (typeof supplied !== "function") {
			missing.push(qualified);
		}
	}
	return missing.sort();
}

function isNamespace(binding: Binding): binding is NamespaceBinding {
	return "members" in binding;
}

function collectAsyncBindingNames(bindings: Record<string, Binding> | undefined, prefix = ""): string[] {
	if (!bindings) return [];
	const names: string[] = [];
	for (const [name, binding] of Object.entries(bindings)) {
		const qualifiedName = prefix ? `${prefix}.${name}` : name;
		if (isNamespace(binding)) {
			names.push(...collectAsyncBindingNames(binding.members, qualifiedName));
		} else if (binding.async) {
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
	const consoleObj = context.newObject();

	for (const method of Object.keys(CONSOLE_METHOD_SEVERITY)) {
		const severity = CONSOLE_METHOD_SEVERITY[method];
		const fn = context.newFunction(method, (...handles: QuickJSHandle[]) => {
			const args = handles.map((h) => context.dump(h));
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
	evalAndDispose(context, `
		class BindingError extends Error {
			constructor(binding, message) {
				super(binding + "(): " + message);
				this.name = "BindingError";
				this.binding = binding;
			}
		}
		class CapabilityDeniedError extends Error {
			constructor(binding, capability) {
				super(binding + '() requires the "' + capability + '" capability, which hasn\\'t been granted to this script. Ask the app developer to enable it.');
				this.name = "CapabilityDeniedError";
				this.capability = capability;
				this.binding = binding;
			}
		}
		globalThis.BindingError = BindingError;
		globalThis.CapabilityDeniedError = CapabilityDeniedError;
	`);
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

const ASYNC_ON_SYNC_TIER_MESSAGE =
	'declares "async": true in the manifest, and the synchronous sandbox cannot await it. The app must create the runtime with the async entry point (initXriptAsync / createSandboxAsync) for this binding to be callable.';

const ASYNC_IN_CALLBACK_MESSAGE =
	"cannot be called from inside a callback passed to a binding: it is async, and a callback runs synchronously";

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
	return context.newFunction(qualifiedName, (...handles: QuickJSHandle[]) => {
		if (binding.capability && !grantedSatisfies(grantedCapabilities, binding.capability)) {
			return createCapabilityError(context, qualifiedName, binding.capability);
		}

		if (!hostFn) {
			return createBindingError(context, qualifiedName, "not implemented by the app");
		}

		const refusal = functionParamViolation(qualifiedName, functionChecks, (i) => argTypeOf(context, handles[i]));
		if (refusal) return { error: context.newError({ name: "TypeError", message: refusal }) };

		if (audit) audit(qualifiedName, binding.capability ?? null);

		const scope = new CallbackScope(context, callbackSupportFor(context), qualifiedName);
		try {
			const nativeArgs = handles.map((h) => scope.unmarshal(h));
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
			const message = e instanceof Error ? e.message : String(e);
			return createBindingError(context, qualifiedName, message);
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
	audit?: (binding: string, capability: string | null) => void,
): void {
	const asyncKey = `__xript_async_${qualifiedName.replace(/\./g, "_")}`;
	const capabilityDenied = !!(binding.capability && !grantedSatisfies(grantedCapabilities, binding.capability));
	const missingImpl = !hostFn;

	if (!capabilityDenied && !missingImpl) {
		const functionChecks = functionParamChecks(binding.params);
		const settle = async (scope: CallbackScope, nativeArgs: unknown[]) => {
			try {
				const result = await hostFn!(...nativeArgs);
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
				const message = e instanceof Error ? e.message : String(e);
				return createBindingError(context, qualifiedName, message);
			} finally {
				scope.close();
			}
		};
		const asyncImpl = context.newAsyncifiedFunction(asyncKey, ((...handles: QuickJSHandle[]) => {
			const refusal = functionParamViolation(qualifiedName, functionChecks, (i) => argTypeOf(context, handles[i]));
			if (refusal) return { error: context.newError({ name: "TypeError", message: refusal }) };
			const support = callbackSupportFor(context);
			if (support.depth > 0) return createBindingError(context, qualifiedName, ASYNC_IN_CALLBACK_MESSAGE);
			if (audit) audit(qualifiedName, binding.capability ?? null);
			const scope = new CallbackScope(context, support, qualifiedName);
			let nativeArgs: unknown[];
			try {
				nativeArgs = handles.map((h) => scope.unmarshal(h));
			} catch (e) {
				scope.close();
				throw e;
			}
			return settle(scope, nativeArgs);
		}) as AsyncFunctionImplementation);
		context.setProp(context.global, asyncKey, asyncImpl);
		asyncImpl.dispose();
	}

	const escapedName = qualifiedName.replace(/"/g, '\\"');
	const escapedCap = (binding.capability || "").replace(/"/g, '\\"');

	let wrapperCode: string;
	if (capabilityDenied) {
		wrapperCode = `(function() { throw new CapabilityDeniedError("${escapedName}", "${escapedCap}"); })`;
	} else if (missingImpl) {
		wrapperCode = `(function() { throw new BindingError("${escapedName}", "not implemented by the app"); })`;
	} else {
		wrapperCode = `(function(...args) { return globalThis["${asyncKey}"](...args); })`;
	}

	const wrapperResult = context.evalCode(wrapperCode, "xript-async-binding.js");
	if (wrapperResult.error) {
		wrapperResult.error.dispose();
		return;
	}

	context.setProp(context.global, `__xript_gate_${qualifiedName.replace(/\./g, "_")}`, wrapperResult.value);
	wrapperResult.value.dispose();
}

function registerBinding(
	context: QuickJSContext | QuickJSAsyncContext,
	target: QuickJSHandle,
	propName: string,
	qualifiedName: string,
	binding: FunctionBinding,
	hostFn: HostFunction | undefined,
	grantedCapabilities: Set<string>,
	isAsync: boolean,
	audit?: (binding: string, capability: string | null) => void,
): void {
	if (isAsync && binding.async) {
		registerAsyncBinding(context as QuickJSAsyncContext, qualifiedName, binding, hostFn, grantedCapabilities, audit);
		const gateKey = `__xript_gate_${qualifiedName.replace(/\./g, "_")}`;
		const gateFn = context.getProp(context.global, gateKey);
		context.setProp(target, propName, gateFn);
		gateFn.dispose();
	} else if (!isAsync && binding.async) {
		const stub = createAsyncUnsupportedStub(context, qualifiedName);
		context.setProp(target, propName, stub);
		stub.dispose();
	} else {
		const fn = createHostFunctionWrapper(context, qualifiedName, binding, hostFn, grantedCapabilities, audit);
		context.setProp(target, propName, fn);
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
	isAsync: boolean,
	audit?: (binding: string, capability: string | null) => void,
): void {
	for (const [memberName, memberBinding] of Object.entries(binding.members)) {
		const qualifiedName = `${qualifiedPrefix}.${memberName}`;
		if (isNamespace(memberBinding)) {
			const nestedNsObj = context.newObject();
			const nestedHostNs = hostNs ? (hostNs[memberName] as HostNamespace | undefined) : undefined;
			registerNamespaceMembers(
				context,
				nestedNsObj,
				memberBinding,
				nestedHostNs,
				qualifiedName,
				grantedCapabilities,
				isAsync,
				audit,
			);
			context.setProp(nsObj, memberName, nestedNsObj);
			nestedNsObj.dispose();
		} else {
			const hostFn = hostNs ? (hostNs[memberName] as HostFunction | undefined) : undefined;
			registerBinding(context, nsObj, memberName, qualifiedName, memberBinding, hostFn, grantedCapabilities, isAsync, audit);
		}
	}
}

function injectBindings(
	context: QuickJSContext | QuickJSAsyncContext,
	manifest: Manifest,
	hostBindings: HostBindings,
	grantedCapabilities: Set<string>,
	isAsync: boolean,
	audit?: (binding: string, capability: string | null) => void,
): void {
	if (!manifest.bindings) return;

	for (const [name, binding] of Object.entries(manifest.bindings)) {
		if (isNamespace(binding)) {
			const nsObj = context.newObject();
			const hostNs = hostBindings[name] as HostNamespace | undefined;
			registerNamespaceMembers(context, nsObj, binding, hostNs, name, grantedCapabilities, isAsync, audit);
			context.setProp(context.global, name, nsObj);
			nsObj.dispose();
		} else {
			const hostFn = hostBindings[name] as HostFunction | undefined;
			registerBinding(context, context.global, name, name, binding, hostFn, grantedCapabilities, isAsync, audit);
		}
	}

	freezeNamespaces(context, manifest);
}

const DEEP_FREEZE_HELPER = `
	globalThis.__xript_deep_freeze = function(obj) {
		if (obj === null || typeof obj !== "object") return obj;
		var keys = Object.getOwnPropertyNames(obj);
		for (var i = 0; i < keys.length; i++) {
			var value = obj[keys[i]];
			if (value !== null && typeof value === "object") {
				globalThis.__xript_deep_freeze(value);
			}
		}
		return Object.freeze(obj);
	};
`;

function freezeNamespaces(context: QuickJSContext | QuickJSAsyncContext, manifest: Manifest): void {
	if (!manifest.bindings) return;

	const namespaceNames = Object.entries(manifest.bindings)
		.filter(([_, binding]) => isNamespace(binding))
		.map(([name]) => name);

	if (namespaceNames.length === 0) return;

	evalAndDispose(context, DEEP_FREEZE_HELPER);
	const freezeCode = namespaceNames.map((name) => `__xript_deep_freeze(${name});`).join("\n");
	evalAndDispose(context, freezeCode);
}

export interface FireHookOptions {
	phase?: string;
	data?: unknown;
}

function injectHookHelpers(context: QuickJSContext | QuickJSAsyncContext): void {
	evalAndDispose(context, `
		globalThis.__xript_hook_handlers = {};
		globalThis.__xript_register_handler = function(key, handler) {
			if (!globalThis.__xript_hook_handlers[key]) {
				globalThis.__xript_hook_handlers[key] = [];
			}
			globalThis.__xript_hook_handlers[key].push(handler);
		};
		globalThis.__xript_fire_handlers = function(key, data) {
			var handlers = globalThis.__xript_hook_handlers[key];
			if (!handlers || handlers.length === 0) return [];
			var args;
			if (data === undefined) {
				args = [];
			} else if (typeof data === "object" && data !== null && !Array.isArray(data)) {
				args = Object.values(data);
			} else {
				args = [data];
			}
			var results = [];
			for (var i = 0; i < handlers.length; i++) {
				try {
					results.push(handlers[i].apply(null, args));
				} catch(e) {
					results.push(undefined);
				}
			}
			return results;
		};
	`);
}

function registerHandlerInContext(
	context: QuickJSContext | QuickJSAsyncContext,
	registryKey: string,
	handlerHandle: QuickJSHandle,
): void {
	const registerFn = context.getProp(context.global, "__xript_register_handler");
	const keyStr = context.newString(registryKey);
	const callResult = context.callFunction(registerFn, context.undefined, keyStr, handlerHandle);
	keyStr.dispose();
	registerFn.dispose();
	if (callResult.error) callResult.error.dispose();
	else callResult.value.dispose();
}

function injectHooks(
	context: QuickJSContext | QuickJSAsyncContext,
	manifest: Manifest,
	grantedCapabilities: Set<string>,
): void {
	injectHookHelpers(context);

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
					registerHandlerInContext(context, registryKey, handles[0]);
				});
				context.setProp(hookNs, phase, regFn);
				regFn.dispose();
			}

			context.setProp(hooksObj, hookName, hookNs);
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
				registerHandlerInContext(context, registryKey, handles[0]);
			});
			context.setProp(hooksObj, hookName, regFn);
			regFn.dispose();
		}
	}

	context.setProp(context.global, "hooks", hooksObj);
	hooksObj.dispose();

}

function injectEventHelpers(context: QuickJSContext | QuickJSAsyncContext): void {
	evalAndDispose(context, `
		globalThis.__xript_event_handlers = {};
		globalThis.__xript_register_event_handler = function(id, handler) {
			if (!globalThis.__xript_event_handlers[id]) {
				globalThis.__xript_event_handlers[id] = [];
			}
			globalThis.__xript_event_handlers[id].push(handler);
		};
		globalThis.__xript_emit = function(id, payload) {
			var handlers = globalThis.__xript_event_handlers[id];
			if (!handlers || handlers.length === 0) return [];
			var args;
			if (payload === undefined) {
				args = [];
			} else if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
				args = Object.values(payload);
			} else {
				args = [payload];
			}
			var results = [];
			for (var i = 0; i < handlers.length; i++) {
				try {
					results.push(handlers[i].apply(null, args));
				} catch(e) {
					results.push(undefined);
				}
			}
			return results;
		};
	`);
}

function injectEvents(
	context: QuickJSContext | QuickJSAsyncContext,
	manifest: Manifest,
	grantedCapabilities: Set<string>,
): void {
	injectEventHelpers(context);

	const eventDefs = manifest.events ?? [];
	const gateByEventId = new Map<string, string | undefined>();
	for (const def of eventDefs) {
		gateByEventId.set(def.id, def.capability);
	}

	const subscribe = context.newFunction("events.on", (...handles: QuickJSHandle[]) => {
		if (handles.length < 2) {
			return createBindingError(context, "events.on", "expected (eventId, handler)");
		}
		const eventId = context.dump(handles[0]);
		if (typeof eventId !== "string" || eventId.length === 0) {
			return createBindingError(context, "events.on", "eventId must be a non-empty string");
		}
		if (!gateByEventId.has(eventId)) {
			return createBindingError(context, "events.on", `event '${eventId}' is not declared in the host manifest`);
		}
		const required = gateByEventId.get(eventId);
		if (required && !grantedSatisfies(grantedCapabilities, required)) {
			return createCapabilityError(context, "events.on", required);
		}

		const registerFn = context.getProp(context.global, "__xript_register_event_handler");
		const idStr = context.newString(eventId);
		const callResult = context.callFunction(registerFn, context.undefined, idStr, handles[1]);
		idStr.dispose();
		registerFn.dispose();
		if (callResult.error) {
			callResult.error.dispose();
		} else {
			callResult.value.dispose();
		}
	});

	const eventsObj = context.newObject();
	context.setProp(eventsObj, "on", subscribe);
	context.setProp(eventsObj, "subscribe", subscribe);
	subscribe.dispose();

	context.setProp(context.global, "events", eventsObj);
	eventsObj.dispose();

	evalAndDispose(context, "Object.freeze(globalThis.events);");
}

function emitInContext(
	context: QuickJSContext | QuickJSAsyncContext,
	manifest: Manifest,
	eventId: string,
	payload?: unknown,
): unknown[] {
	const declared = manifest.events?.some((e) => e.id === eventId) ?? false;
	if (!declared) return [];

	const emitFn = context.getProp(context.global, "__xript_emit");
	const idStr = context.newString(eventId);

	const payloadHandle = payload !== undefined
		? marshalToQuickJS(context, payload)
		: context.undefined;

	const callResult = context.callFunction(emitFn, context.undefined, idStr, payloadHandle);
	idStr.dispose();
	if (payload !== undefined) safeDispose(context, payloadHandle);
	emitFn.dispose();

	if (callResult.error) {
		callResult.error.dispose();
		return [];
	}

	const arrHandle = callResult.value;
	const lengthHandle = context.getProp(arrHandle, "length");
	const length = context.dump(lengthHandle) as number;
	lengthHandle.dispose();

	const results: unknown[] = [];
	for (let i = 0; i < length; i++) {
		const elemHandle = context.getProp(arrHandle, String(i));
		results.push(context.dump(elemHandle));
		elemHandle.dispose();
	}

	arrHandle.dispose();
	return results;
}

function freezeHooksAndFragments(
	context: QuickJSContext | QuickJSAsyncContext,
	manifest: Manifest,
): void {
	const hookNsNames = Object.entries(effectiveHooks(manifest))
		.filter(([_, h]) => h.phases && h.phases.length > 0)
		.map(([name]) => name);

	const freezeParts = [
		...hookNsNames.map((n) => `Object.freeze(hooks.${n});`),
		"if (hooks.fragment) Object.freeze(hooks.fragment);",
		"Object.freeze(hooks);",
	];

	evalAndDispose(context, freezeParts.join("\n"));
}

function injectFragmentAPI(context: QuickJSContext | QuickJSAsyncContext): void {
	evalAndDispose(context, `
		globalThis.__xript_fragment_handlers = {};
		globalThis.__xript_register_fragment_handler = function(key, handler) {
			if (!globalThis.__xript_fragment_handlers[key]) {
				globalThis.__xript_fragment_handlers[key] = [];
			}
			globalThis.__xript_fragment_handlers[key].push(handler);
		};
		globalThis.__xript_fire_fragment_handlers = function(key, bindings) {
			var handlers = globalThis.__xript_fragment_handlers[key];
			if (!handlers || handlers.length === 0) return [];
			var allOps = [];
			for (var i = 0; i < handlers.length; i++) {
				var ops = [];
				var fragmentProxy = {
					toggle: function(target, condition) { ops.push({ op: "toggle", selector: target, value: !!condition }); },
					addClass: function(target, className) { ops.push({ op: "addClass", selector: target, value: className }); },
					removeClass: function(target, className) { ops.push({ op: "removeClass", selector: target, value: className }); },
					setText: function(target, text) { ops.push({ op: "setText", selector: target, value: text }); },
					setProp: function(target, prop, value) { ops.push({ op: "setProp", selector: target, prop: prop, value: value }); },
					setAttr: function(target, attr, value) { ops.push({ op: "setAttr", selector: target, attr: attr, prop: attr, value: value }); },
					removeAttr: function(target, attr) { ops.push({ op: "removeAttr", selector: target, attr: attr, prop: attr }); },
					replaceChildren: function(target, content) { ops.push({ op: "replaceChildren", selector: target, value: content }); }
				};
				try {
					handlers[i](bindings, fragmentProxy);
				} catch(e) {}
				allOps = allOps.concat(ops);
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

			const registerFn = context.getProp(context.global, "__xript_register_fragment_handler");
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
	evalAndDispose(context, `
		globalThis.__xript_exports = { "": {} };
		globalThis.__xript_export_owner = "";
		globalThis.__xript_set_export_owner = function(owner) {
			var key = typeof owner === "string" ? owner : "";
			globalThis.__xript_export_owner = key;
			if (!globalThis.__xript_exports[key]) globalThis.__xript_exports[key] = {};
			return key;
		};
		globalThis.__xript_export_owners_of = function(name) {
			var owners = [];
			var keys = Object.keys(globalThis.__xript_exports);
			for (var i = 0; i < keys.length; i++) {
				if (typeof globalThis.__xript_exports[keys[i]][name] === "function") owners.push(keys[i]);
			}
			return owners;
		};
		globalThis.xript = globalThis.xript || {};
		globalThis.xript.exports = {
			register: function(name, fn) {
				if (typeof name !== "string" || name.length === 0) {
					throw new TypeError("xript.exports.register: name must be a non-empty string");
				}
				if (typeof fn !== "function") {
					throw new TypeError("xript.exports.register: fn must be a function");
				}
				var bucket = globalThis.__xript_exports[globalThis.__xript_export_owner];
				bucket[name] = fn;
			}
		};
		Object.freeze(globalThis.xript.exports);
		globalThis.__xript_invoke_export = function(name, args, owner) {
			var fn;
			if (typeof owner === "string") {
				var bucket = globalThis.__xript_exports[owner];
				fn = bucket ? bucket[name] : undefined;
			} else {
				var owners = globalThis.__xript_export_owners_of(name);
				if (owners.length > 1) {
					var ambiguous = new Error("export " + name + " is provided by more than one mod");
					ambiguous.name = "AmbiguousExportError";
					ambiguous.export = name;
					ambiguous.owners = owners;
					throw ambiguous;
				}
				fn = owners.length === 1 ? globalThis.__xript_exports[owners[0]][name] : undefined;
			}
			if (typeof fn !== "function") {
				var notFound = new Error("export " + name + " not found");
				notFound.name = "InvokeError";
				notFound.export = name;
				throw notFound;
			}
			return fn.apply(null, args || []);
		};
		globalThis.__xript_harvest_exports = function(ns) {
			var harvested = [];
			var bucket = globalThis.__xript_exports[globalThis.__xript_export_owner];
			var keys = Object.keys(ns);
			for (var i = 0; i < keys.length; i++) {
				var name = keys[i];
				if (name === "default") continue;
				var value = ns[name];
				if (typeof value !== "function") continue;
				if (typeof bucket[name] === "function") continue;
				bucket[name] = value;
				harvested.push(name);
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
	const invokeFn = context.getProp(context.global, "__xript_invoke_export");
	const nameStr = context.newString(exportName);
	const argsHandle = marshalToQuickJS(context, args);
	const ownerHandle = owner === undefined ? context.undefined : context.newString(owner);

	const callResult = context.callFunction(invokeFn, context.undefined, nameStr, argsHandle, ownerHandle);
	nameStr.dispose();
	safeDispose(context, argsHandle);
	if (owner !== undefined) ownerHandle.dispose();
	invokeFn.dispose();
	return callResult;
}

function setExportOwnerInContext(
	context: QuickJSContext | QuickJSAsyncContext,
	owner: string | null,
): void {
	const setter = context.getProp(context.global, "__xript_set_export_owner");
	const ownerStr = context.newString(owner ?? "");
	const result = context.callFunction(setter, context.undefined, ownerStr);
	ownerStr.dispose();
	setter.dispose();
	if (result.error) result.error.dispose();
	else result.value.dispose();
}

/**
 * Dumps a result handle for the host, marshalling a bare script function to null. A function
 * carries no data across the boundary and must not reach the host as something callable;
 * `context.dump` already drops or nulls functions nested in objects and arrays, so only the
 * top-level handle needs this guard.
 */
function dumpForHost(context: QuickJSContext | QuickJSAsyncContext, handle: QuickJSHandle): unknown {
	if (context.typeof(handle) === "function") return null;
	return context.dump(handle);
}

function invokeExportInContext(
	context: QuickJSContext | QuickJSAsyncContext,
	exportName: string,
	args: unknown[],
	owner?: string,
): unknown {
	const callResult = callInvokeExport(context, exportName, args, owner);

	if (callResult.error) {
		const errorObj = context.dump(callResult.error) as InvokeErrorDump;
		callResult.error.dispose();
		throwInvokeFailure(errorObj, exportName);
	}

	const value = dumpForHost(context, callResult.value);
	callResult.value.dispose();
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

	const value = dumpForHost(context, awaited.value);
	if (awaited.value.alive) awaited.value.dispose();
	return value;
}

function fireFragmentHookInContext(
	context: QuickJSContext | QuickJSAsyncContext,
	fragmentId: string,
	lifecycle: string,
	bindings?: Record<string, unknown>,
): RawFragmentOp[] {
	const registryKey = `fragment:${lifecycle}:${fragmentId}`;
	const fireFn = context.getProp(context.global, "__xript_fire_fragment_handlers");
	const keyStr = context.newString(registryKey);

	const bindingsHandle = bindings !== undefined
		? marshalToQuickJS(context, bindings)
		: context.undefined;

	const callResult = context.callFunction(fireFn, context.undefined, keyStr, bindingsHandle);
	keyStr.dispose();
	if (bindings !== undefined) safeDispose(context, bindingsHandle);
	fireFn.dispose();

	if (callResult.error) {
		callResult.error.dispose();
		return [];
	}

	const result = context.dump(callResult.value) as RawFragmentOp[];
	callResult.value.dispose();
	return Array.isArray(result) ? result : [];
}

function fireHookInContext(
	context: QuickJSContext | QuickJSAsyncContext,
	manifest: Manifest,
	hookName: string,
	options?: FireHookOptions,
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

	const fireFn = context.getProp(context.global, "__xript_fire_handlers");
	const keyStr = context.newString(registryKey);

	const data = options?.data;
	const dataHandle = data !== undefined
		? marshalToQuickJS(context, data)
		: context.undefined;

	const callResult = context.callFunction(fireFn, context.undefined, keyStr, dataHandle);
	keyStr.dispose();
	if (data !== undefined) safeDispose(context, dataHandle);
	fireFn.dispose();

	if (callResult.error) {
		callResult.error.dispose();
		return [];
	}

	const arrHandle = callResult.value;
	const lengthHandle = context.getProp(arrHandle, "length");
	const length = context.dump(lengthHandle) as number;
	lengthHandle.dispose();

	const results: unknown[] = [];
	for (let i = 0; i < length; i++) {
		const elemHandle = context.getProp(arrHandle, String(i));
		results.push(context.dump(elemHandle));
		elemHandle.dispose();
	}

	arrHandle.dispose();
	return results;
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
	const harvestFn = context.getProp(context.global, "__xript_harvest_exports");
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
	 */
	invokeExport: (name: string, args: unknown[], owner?: string, timeoutOverrideMs?: number) => unknown;
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
	debugSession: () => DebugSession | null;
	dispose: () => void;
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
function createInterruptStack(runtime: QuickJSRuntime | QuickJSAsyncRuntime) {
	const frames: InterruptFrame[] = [];

	function handler(): boolean {
		for (const frame of frames) {
			if (frame.cancellation?.cancelled) return true;
			if (Date.now() >= frame.deadline) return true;
		}
		return false;
	}

	return function pushInterruptFrame(deadline: number, cancellation?: CancellationToken): () => void {
		const frame: InterruptFrame = { deadline, cancellation };
		frames.push(frame);
		if (frames.length === 1) runtime.setInterruptHandler(handler);

		let popped = false;
		return () => {
			if (popped) return;
			popped = true;
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

function injectDebugProbe(context: QuickJSAsyncContext, controller: DebugController): void {
	const shouldStop = controller.makeShouldStop();
	const pause = controller.makePause();

	const shouldFn = context.newFunction(controller.probeNames.shouldStop, (lineHandle: QuickJSHandle) => {
		const line = context.dump(lineHandle) as number;
		return shouldStop(line) ? context.true : context.false;
	});
	context.setProp(context.global, controller.probeNames.shouldStop, shouldFn);
	shouldFn.dispose();

	const pauseFn = context.newAsyncifiedFunction(controller.probeNames.pause, async (...handles: QuickJSHandle[]) => {
		const line = context.dump(handles[0]) as number;
		const column = context.dump(handles[1]) as number;
		const locals = handles.length > 2 ? (context.dump(handles[2]) as Record<string, unknown>) : {};
		await pause(line, column, locals);
		return context.undefined;
	});
	context.setProp(context.global, controller.probeNames.pause, pauseFn);
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
	const { manifest, hostBindings, capabilities = [], cancellation } = options;
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
	const pushInterruptFrame = createInterruptStack(runtime);

	if (memoryMb) {
		runtime.setMemoryLimit(memoryMb * 1024 * 1024);
	}
	if (maxStackDepth) {
		runtime.setMaxStackSize(maxStackDepth * 1024);
	}

	const context = runtime.newContext();

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
	injectBindings(context, manifest, hostBindings, grantedCapabilities, false, auditEmit);
	injectHooks(context, manifest, grantedCapabilities);
	injectEvents(context, manifest, grantedCapabilities);
	injectFragmentAPI(context);
	injectExportsAPI(context);
	freezeHooksAndFragments(context, manifest);

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

		const value = dumpForHost(context, result.value);
		result.value.dispose();
		return { value, duration_ms };
	}

	async function executeAsync(code: string): Promise<ExecutionResult> {
		if (cancellation?.cancelled) throw new CancellationError();
		const wrappedCode = `(async () => { ${code} })()`;
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

		const value = dumpForHost(context, awaited.value);
		if (awaited.value.alive) awaited.value.dispose();
		return { value, duration_ms };
	}

	function invokeExport(name: string, args: unknown[], owner?: string, timeoutOverrideMs?: number): unknown {
		if (cancellation?.cancelled) throw new CancellationError();
		const budgetMs = callTimeoutMs(timeoutOverrideMs);
		const popInterrupt = pushInterruptFrame(Date.now() + budgetMs, cancellation);
		try {
			return invokeExportInContext(context, name, args, owner);
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
			return await invokeExportAsyncInContext(context, runtime, name, args, owner);
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
		return fireHookInContext(context, manifest, hookName, opts);
	}

	function fireFragmentHook(fragmentId: string, lifecycle: string, bindings?: Record<string, unknown>): RawFragmentOp[] {
		return fireFragmentHookInContext(context, fragmentId, lifecycle, bindings);
	}

	function emit(eventId: string, payload?: unknown): unknown[] {
		return emitInContext(context, manifest, eventId, payload);
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
		releaseCallbackSupport(context);
		context.dispose();
		runtime.dispose();
	}

	return { execute, executeAsync, debugExecute, evaluateModule, invokeExport, invokeExportAsync, setExportOwner, fireHook, fireFragmentHook, emit, debugSession, dispose };
}

export async function createSandboxAsync(
	options: SandboxOptions,
	variant?: AsyncVariant,
): Promise<SandboxResult> {
	const { newAsyncContext } = await import("#quickjs-async");

	const { manifest, hostBindings, capabilities = [], cancellation } = options;
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
	const runtime = context.runtime;
	const pushInterruptFrame = createInterruptStack(runtime);

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
	if (maxStackDepth) {
		runtime.setMaxStackSize(maxStackDepth * 1024);
	}

	const sandboxConsole = options.console ?? {};

	const debugController = options.debug ? createDebugController(options.debug, "instrumented") : null;

	injectConsole(context, sandboxConsole);
	blockCodeGeneration(context);
	injectErrorClasses(context);
	injectBindings(context, manifest, hostBindings, grantedCapabilities, true, auditEmit);
	injectHooks(context, manifest, grantedCapabilities);
	injectEvents(context, manifest, grantedCapabilities);
	injectFragmentAPI(context);
	injectExportsAPI(context);
	freezeHooksAndFragments(context, manifest);

	if (debugController) {
		injectDebugProbe(context, debugController);
	}

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

		const value = dumpForHost(context, result.value);
		result.value.dispose();
		return { value, duration_ms };
	}

	async function debugExecute(code: string): Promise<ExecutionResult> {
		if (cancellation?.cancelled) throw new CancellationError();
		if (!debugController) {
			throw new DebugUnsupportedError("no debug session is attached to this runtime");
		}
		const { code: instrumented, breakableLines } = instrumentSource(code, debugController.probeNames);
		debugController.setBreakableLines("xript-script.js", breakableLines);
		const wrappedCode = `(async () => { ${instrumented} })()`;
		const start = performance.now();
		const result = await context.evalCodeAsync(wrappedCode, "xript-script.js");

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

		const value = context.dump(awaited.value);
		if (awaited.value.alive) awaited.value.dispose();
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
			runtime.executePendingJobs();
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
		const wrappedCode = `(async () => { ${code} })()`;
		const popInterrupt = pushInterruptFrame(Date.now() + timeoutMs, cancellation);
		const start = performance.now();
		let result;
		try {
			result = await context.evalCodeAsync(wrappedCode, "xript-script.js");
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

		const value = dumpForHost(context, awaited.value);
		if (awaited.value.alive) awaited.value.dispose();
		return { value, duration_ms };
	}

	function invokeExport(name: string, args: unknown[], owner?: string, timeoutOverrideMs?: number): unknown {
		if (cancellation?.cancelled) throw new CancellationError();
		const budgetMs = callTimeoutMs(timeoutOverrideMs);
		const popInterrupt = pushInterruptFrame(Date.now() + budgetMs, cancellation);
		try {
			return invokeExportInContext(context, name, args, owner);
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
			return await invokeExportAsyncInContext(context, runtime, name, args, owner);
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
		return fireHookInContext(context, manifest, hookName, opts);
	}

	function fireFragmentHook(fragmentId: string, lifecycle: string, bindings?: Record<string, unknown>): RawFragmentOp[] {
		return fireFragmentHookInContext(context, fragmentId, lifecycle, bindings);
	}

	function emit(eventId: string, payload?: unknown): unknown[] {
		return emitInContext(context, manifest, eventId, payload);
	}

	function dispose(): void {
		releaseCallbackSupport(context);
		context.dispose();
		runtime.dispose();
	}

	return { execute, executeAsync, debugExecute, evaluateModule, invokeExport, invokeExportAsync, setExportOwner, fireHook, fireFragmentHook, emit, debugSession, dispose };
}
