import type {
	QuickJSContext,
	QuickJSHandle,
	QuickJSRuntime,
	QuickJSAsyncContext,
	QuickJSAsyncRuntime,
	QuickJSWASMModule,
} from "quickjs-emscripten";
import { BindingError, CapabilityDeniedError, CancellationError, InvokeError, ModEntryError, ImportDeniedError, ModuleUnsupportedError } from "./errors.js";
import { findImportSpecifier } from "./module-support.js";
import { marshalToQuickJS, safeDispose } from "./marshal.js";
import type { DebugOptions, DebugSession } from "./debug-types.js";
import { DebugUnsupportedError } from "./debug-types.js";
import { createDebugController, type DebugController } from "./debug-session.js";
import { instrumentSource } from "./debug-instrument.js";

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
	capabilities?: Record<string, CapabilityDef>;
	limits?: ExecutionLimits;
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

export type HostFunction = (...args: unknown[]) => unknown;
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

export interface AuditEvent {
	binding: string;
	capability: string | null;
	at: number;
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

function isNamespace(binding: Binding): binding is NamespaceBinding {
	return "members" in binding;
}

function hasAsyncBindings(manifest: Manifest): boolean {
	if (!manifest.bindings) return false;
	for (const binding of Object.values(manifest.bindings)) {
		if (isNamespace(binding)) {
			for (const member of Object.values(binding.members)) {
				if (!isNamespace(member) && member.async) return true;
			}
		} else {
			if (binding.async) return true;
		}
	}
	return false;
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

function blockCodeGeneration(context: QuickJSContext | QuickJSAsyncContext): void {
	evalAndDispose(context, `
		globalThis.eval = function() {
			throw new TypeError("eval() is not permitted. Dynamic code generation is disabled in xript.");
		};
		globalThis.Function = function() {
			throw new TypeError("Function() is not permitted. Dynamic code generation is disabled in xript.");
		};
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

type AuditEmitter = (binding: string, capability: string | null) => void;

function emitAudit(
	audit: ((event: AuditEvent) => void) | undefined,
	binding: string,
	capability: string | null,
): void {
	if (!audit) return;
	try {
		audit({ binding, capability, at: Date.now() });
	} catch {
		// fire-and-forget: emit failures never break script execution
	}
}

function createHostFunctionWrapper(
	context: QuickJSContext | QuickJSAsyncContext,
	qualifiedName: string,
	binding: FunctionBinding,
	hostFn: HostFunction | undefined,
	grantedCapabilities: Set<string>,
	audit?: (binding: string, capability: string | null) => void,
): QuickJSHandle {
	return context.newFunction(qualifiedName, (...handles: QuickJSHandle[]) => {
		if (binding.capability && !grantedCapabilities.has(binding.capability)) {
			return createCapabilityError(context, qualifiedName, binding.capability);
		}

		if (!hostFn) {
			return createBindingError(context, qualifiedName, "not implemented by the app");
		}

		if (audit) audit(qualifiedName, binding.capability ?? null);

		try {
			const nativeArgs = handles.map((h) => context.dump(h));
			const result = hostFn(...nativeArgs);
			return marshalToQuickJS(context, result);
		} catch (e) {
			if (e instanceof CapabilityDeniedError) {
				return createCapabilityError(context, e.binding, e.capability);
			}
			if (e instanceof BindingError) {
				return createBindingError(context, e.binding, e.message.replace(`${e.binding}: `, ""));
			}
			const message = e instanceof Error ? e.message : String(e);
			return createBindingError(context, qualifiedName, message);
		}
	});
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
	const capabilityDenied = !!(binding.capability && !grantedCapabilities.has(binding.capability));
	const missingImpl = !hostFn;

	if (!capabilityDenied && !missingImpl) {
		const asyncImpl = context.newAsyncifiedFunction(asyncKey, async (...handles: QuickJSHandle[]) => {
			if (audit) audit(qualifiedName, binding.capability ?? null);
			try {
				const nativeArgs = handles.map((h) => context.dump(h));
				const result = await hostFn!(...nativeArgs);
				return marshalToQuickJS(context, result);
			} catch (e) {
				if (e instanceof CapabilityDeniedError) {
					return createCapabilityError(context, e.binding, e.capability);
				}
				if (e instanceof BindingError) {
					return createBindingError(context, e.binding, e.message.replace(`${e.binding}: `, ""));
				}
				const message = e instanceof Error ? e.message : String(e);
				return createBindingError(context, qualifiedName, message);
			}
		});
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

	if (!manifest.hooks) {
		evalAndDispose(context, "globalThis.hooks = {};");
		return;
	}

	const hooksObj = context.newObject();

	for (const [hookName, hookDef] of Object.entries(manifest.hooks)) {
		if (hookDef.phases && hookDef.phases.length > 0) {
			const hookNs = context.newObject();

			for (const phase of hookDef.phases) {
				const registryKey = `${hookName}:${phase}`;
				const regFn = context.newFunction(`hooks.${hookName}.${phase}`, (...handles: QuickJSHandle[]) => {
					if (hookDef.capability && !grantedCapabilities.has(hookDef.capability)) {
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
				if (hookDef.capability && !grantedCapabilities.has(hookDef.capability)) {
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

function freezeHooksAndFragments(
	context: QuickJSContext | QuickJSAsyncContext,
	manifest: Manifest,
): void {
	const hookNsNames = manifest.hooks
		? Object.entries(manifest.hooks)
			.filter(([_, h]) => h.phases && h.phases.length > 0)
			.map(([name]) => name)
		: [];

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
					toggle: function(selector, condition) { ops.push({ op: "toggle", selector: selector, value: !!condition }); },
					addClass: function(selector, className) { ops.push({ op: "addClass", selector: selector, value: className }); },
					removeClass: function(selector, className) { ops.push({ op: "removeClass", selector: selector, value: className }); },
					setText: function(selector, text) { ops.push({ op: "setText", selector: selector, value: text }); },
					setAttr: function(selector, attr, value) { ops.push({ op: "setAttr", selector: selector, attr: attr, value: value }); },
					replaceChildren: function(selector, html) {
						var content = Array.isArray(html) ? html.join("") : html;
						ops.push({ op: "replaceChildren", selector: selector, value: content });
					}
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
		globalThis.__xript_exports = {};
		globalThis.xript = globalThis.xript || {};
		globalThis.xript.exports = {
			register: function(name, fn) {
				if (typeof name !== "string" || name.length === 0) {
					throw new TypeError("xript.exports.register: name must be a non-empty string");
				}
				if (typeof fn !== "function") {
					throw new TypeError("xript.exports.register: fn must be a function");
				}
				globalThis.__xript_exports[name] = fn;
			}
		};
		Object.freeze(globalThis.xript.exports);
		globalThis.__xript_invoke_export = function(name, args) {
			var fn = globalThis.__xript_exports[name];
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
			var keys = Object.keys(ns);
			for (var i = 0; i < keys.length; i++) {
				var name = keys[i];
				if (name === "default") continue;
				var value = ns[name];
				if (typeof value !== "function") continue;
				if (typeof globalThis.__xript_exports[name] === "function") continue;
				globalThis.__xript_exports[name] = value;
				harvested.push(name);
			}
			return harvested;
		};
	`);
}

function invokeExportInContext(
	context: QuickJSContext | QuickJSAsyncContext,
	exportName: string,
	args: unknown[],
): unknown {
	const invokeFn = context.getProp(context.global, "__xript_invoke_export");
	const nameStr = context.newString(exportName);
	const argsHandle = marshalToQuickJS(context, args);

	const callResult = context.callFunction(invokeFn, context.undefined, nameStr, argsHandle);
	nameStr.dispose();
	safeDispose(context, argsHandle);
	invokeFn.dispose();

	if (callResult.error) {
		const errorObj = context.dump(callResult.error) as { message?: string; export?: string } | undefined;
		callResult.error.dispose();
		const message = errorObj?.message || String(errorObj);
		throw new InvokeError(errorObj?.export ?? exportName, message);
	}

	const value = context.dump(callResult.value);
	callResult.value.dispose();
	return value;
}

async function invokeExportAsyncInContext(
	context: QuickJSContext | QuickJSAsyncContext,
	runtime: QuickJSRuntime | QuickJSAsyncRuntime,
	exportName: string,
	args: unknown[],
): Promise<unknown> {
	const invokeFn = context.getProp(context.global, "__xript_invoke_export");
	const nameStr = context.newString(exportName);
	const argsHandle = marshalToQuickJS(context, args);

	const callResult = context.callFunction(invokeFn, context.undefined, nameStr, argsHandle);
	nameStr.dispose();
	safeDispose(context, argsHandle);
	invokeFn.dispose();

	if (callResult.error) {
		const errorObj = context.dump(callResult.error) as { message?: string; export?: string } | undefined;
		callResult.error.dispose();
		const message = errorObj?.message || String(errorObj);
		throw new InvokeError(errorObj?.export ?? exportName, message);
	}

	const promiseHandle = callResult.value;
	const resolved = context.resolvePromise(promiseHandle);
	if (promiseHandle.alive) promiseHandle.dispose();
	runtime.executePendingJobs();

	const awaited = await resolved;
	if (awaited.error) {
		const errorObj = context.dump(awaited.error) as { message?: string; export?: string } | undefined;
		if (awaited.error.alive) awaited.error.dispose();
		const message = errorObj?.message || String(errorObj);
		throw new InvokeError(errorObj?.export ?? exportName, message);
	}

	const value = context.dump(awaited.value);
	if (awaited.value.alive) awaited.value.dispose();
	return value;
}

function fireFragmentHookInContext(
	context: QuickJSContext | QuickJSAsyncContext,
	fragmentId: string,
	lifecycle: string,
	bindings?: Record<string, unknown>,
): FragmentOp[] {
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

	const result = context.dump(callResult.value) as FragmentOp[];
	callResult.value.dispose();
	return Array.isArray(result) ? result : [];
}

function fireHookInContext(
	context: QuickJSContext | QuickJSAsyncContext,
	manifest: Manifest,
	hookName: string,
	options?: FireHookOptions,
): unknown[] {
	const hookDef = manifest.hooks?.[hookName];
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

export interface FragmentOp {
	op: "toggle" | "addClass" | "removeClass" | "setText" | "setAttr" | "replaceChildren";
	selector: string;
	value?: unknown;
	attr?: string;
}

function harvestModuleExports(
	context: QuickJSAsyncContext,
	namespace: QuickJSHandle,
): string[] {
	const harvestFn = context.getProp(context.global, "__xript_harvest_exports");
	const callResult = context.callFunction(harvestFn, context.undefined, namespace);
	harvestFn.dispose();
	if (namespace.alive) namespace.dispose();

	if (callResult.error) {
		callResult.error.dispose();
		return [];
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
	invokeExport: (name: string, args: unknown[]) => unknown;
	invokeExportAsync: (name: string, args: unknown[]) => Promise<unknown>;
	fireHook: (hookName: string, options?: FireHookOptions) => unknown[];
	fireFragmentHook: (fragmentId: string, lifecycle: string, bindings?: Record<string, unknown>) => FragmentOp[];
	debugSession: () => DebugSession | null;
	dispose: () => void;
}

function clampLimit(requested: number | undefined, hard: number | undefined): number | undefined {
	if (requested === undefined) return hard;
	if (hard === undefined) return requested;
	return Math.min(requested, hard);
}

function buildInterruptHandler(deadline: number, cancellation?: CancellationToken): () => boolean {
	return () => Date.now() >= deadline || (cancellation?.cancelled ?? false);
}

function makeAuditEmitter(audit?: (event: AuditEvent) => void): ((binding: string, capability: string | null) => void) | undefined {
	if (!audit) return undefined;
	return (binding, capability) => emitAudit(audit, binding, capability);
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
		throw Object.assign(
			new Error(`Script timed out after ${timeoutMs}ms. Optimize your script or ask the app developer to increase the limit.`),
			{ name: "ExecutionLimitError", limit: "timeout_ms" },
		);
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
	const limits = manifest.limits || {};
	const hard = options.hardLimits || {};
	const timeoutMs = clampLimit(limits.timeout_ms ?? 5000, hard.timeout_ms) ?? 5000;
	const memoryMb = clampLimit(limits.memory_mb, hard.memory_mb);
	const maxStackDepth = clampLimit(limits.max_stack_depth, hard.max_stack_depth);
	const auditEmit = makeAuditEmitter(options.audit);

	const runtime = quickjs.newRuntime();

	if (memoryMb) {
		runtime.setMemoryLimit(memoryMb * 1024 * 1024);
	}
	if (maxStackDepth) {
		runtime.setMaxStackSize(maxStackDepth * 1024);
	}

	const context = runtime.newContext();

	const sandboxConsole = options.console ?? {};

	injectConsole(context, sandboxConsole);
	blockCodeGeneration(context);
	injectErrorClasses(context);
	injectBindings(context, manifest, hostBindings, grantedCapabilities, false, auditEmit);
	injectHooks(context, manifest, grantedCapabilities);
	injectFragmentAPI(context);
	injectExportsAPI(context);
	freezeHooksAndFragments(context, manifest);

	function execute(code: string): ExecutionResult {
		if (cancellation?.cancelled) throw new CancellationError();
		runtime.setInterruptHandler(buildInterruptHandler(Date.now() + timeoutMs, cancellation));
		const start = performance.now();
		const result = context.evalCode(code, "xript-script.js");
		runtime.removeInterruptHandler();
		const duration_ms = performance.now() - start;

		if (result.error) {
			const errorObj = context.dump(result.error);
			result.error.dispose();
			throwFromError(errorObj, timeoutMs, cancellation);
		}

		const value = context.dump(result.value);
		result.value.dispose();
		return { value, duration_ms };
	}

	async function executeAsync(code: string): Promise<ExecutionResult> {
		if (cancellation?.cancelled) throw new CancellationError();
		const wrappedCode = `(async () => { ${code} })()`;
		runtime.setInterruptHandler(buildInterruptHandler(Date.now() + timeoutMs, cancellation));
		const start = performance.now();
		const result = context.evalCode(wrappedCode, "xript-script.js");
		runtime.removeInterruptHandler();

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
		return { value, duration_ms };
	}

	function invokeExport(name: string, args: unknown[]): unknown {
		if (cancellation?.cancelled) throw new CancellationError();
		runtime.setInterruptHandler(buildInterruptHandler(Date.now() + timeoutMs, cancellation));
		try {
			return invokeExportInContext(context, name, args);
		} finally {
			runtime.removeInterruptHandler();
		}
	}

	async function invokeExportAsync(name: string, args: unknown[]): Promise<unknown> {
		if (cancellation?.cancelled) throw new CancellationError();
		runtime.setInterruptHandler(buildInterruptHandler(Date.now() + timeoutMs, cancellation));
		try {
			return await invokeExportAsyncInContext(context, runtime, name, args);
		} finally {
			runtime.removeInterruptHandler();
		}
	}

	function fireHook(hookName: string, opts?: FireHookOptions): unknown[] {
		return fireHookInContext(context, manifest, hookName, opts);
	}

	function fireFragmentHook(fragmentId: string, lifecycle: string, bindings?: Record<string, unknown>): FragmentOp[] {
		return fireFragmentHookInContext(context, fragmentId, lifecycle, bindings);
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
		context.dispose();
		runtime.dispose();
	}

	return { execute, executeAsync, debugExecute, evaluateModule, invokeExport, invokeExportAsync, fireHook, fireFragmentHook, debugSession, dispose };
}

export async function createSandboxAsync(
	options: SandboxOptions,
): Promise<SandboxResult> {
	const { newAsyncContext } = await import("quickjs-emscripten");

	const { manifest, hostBindings, capabilities = [], cancellation } = options;
	const grantedCapabilities = new Set(capabilities);
	const limits = manifest.limits || {};
	const hard = options.hardLimits || {};
	const timeoutMs = clampLimit(limits.timeout_ms ?? 5000, hard.timeout_ms) ?? 5000;
	const memoryMb = clampLimit(limits.memory_mb, hard.memory_mb);
	const maxStackDepth = clampLimit(limits.max_stack_depth, hard.max_stack_depth);
	const auditEmit = makeAuditEmitter(options.audit);

	const context = await newAsyncContext();
	const runtime = context.runtime;

	runtime.setModuleLoader((moduleName) => ({
		error: new ImportDeniedError(moduleName),
	}));

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
	injectFragmentAPI(context);
	injectExportsAPI(context);
	freezeHooksAndFragments(context, manifest);

	if (debugController) {
		injectDebugProbe(context, debugController);
	}

	function execute(code: string): ExecutionResult {
		if (cancellation?.cancelled) throw new CancellationError();
		runtime.setInterruptHandler(buildInterruptHandler(Date.now() + timeoutMs, cancellation));
		const start = performance.now();
		const result = context.evalCode(code, "xript-script.js");
		runtime.removeInterruptHandler();
		const duration_ms = performance.now() - start;

		if (result.error) {
			const errorObj = context.dump(result.error);
			result.error.dispose();
			throwFromError(errorObj, timeoutMs, cancellation);
		}

		const value = context.dump(result.value);
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

		const specifier = findImportSpecifier(code);
		if (specifier !== null) {
			throw new ImportDeniedError(specifier);
		}

		runtime.setInterruptHandler(buildInterruptHandler(Date.now() + timeoutMs, cancellation));
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
			runtime.removeInterruptHandler();
		}

		return harvestModuleExports(context, namespace);
	}

	async function executeAsync(code: string): Promise<ExecutionResult> {
		if (cancellation?.cancelled) throw new CancellationError();
		const wrappedCode = `(async () => { ${code} })()`;
		runtime.setInterruptHandler(buildInterruptHandler(Date.now() + timeoutMs, cancellation));
		const start = performance.now();
		const result = await context.evalCodeAsync(wrappedCode, "xript-script.js");
		runtime.removeInterruptHandler();

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
		return { value, duration_ms };
	}

	function invokeExport(name: string, args: unknown[]): unknown {
		if (cancellation?.cancelled) throw new CancellationError();
		runtime.setInterruptHandler(buildInterruptHandler(Date.now() + timeoutMs, cancellation));
		try {
			return invokeExportInContext(context, name, args);
		} finally {
			runtime.removeInterruptHandler();
		}
	}

	async function invokeExportAsync(name: string, args: unknown[]): Promise<unknown> {
		if (cancellation?.cancelled) throw new CancellationError();
		runtime.setInterruptHandler(buildInterruptHandler(Date.now() + timeoutMs, cancellation));
		try {
			return await invokeExportAsyncInContext(context, runtime, name, args);
		} finally {
			runtime.removeInterruptHandler();
		}
	}

	function fireHook(hookName: string, opts?: FireHookOptions): unknown[] {
		return fireHookInContext(context, manifest, hookName, opts);
	}

	function fireFragmentHook(fragmentId: string, lifecycle: string, bindings?: Record<string, unknown>): FragmentOp[] {
		return fireFragmentHookInContext(context, fragmentId, lifecycle, bindings);
	}

	function dispose(): void {
		context.dispose();
		runtime.dispose();
	}

	return { execute, executeAsync, debugExecute, evaluateModule, invokeExport, invokeExportAsync, fireHook, fireFragmentHook, debugSession, dispose };
}
