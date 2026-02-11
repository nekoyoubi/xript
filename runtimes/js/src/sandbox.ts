import type {
	QuickJSContext,
	QuickJSHandle,
	QuickJSRuntime,
	QuickJSAsyncContext,
	QuickJSAsyncRuntime,
	QuickJSWASMModule,
} from "quickjs-emscripten";
import { shouldInterruptAfterDeadline } from "quickjs-emscripten";
import { BindingError, CapabilityDeniedError } from "./errors.js";
import { marshalToQuickJS, safeDispose } from "./marshal.js";

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
export type HostBindings = Record<string, HostFunction | Record<string, HostFunction>>;

export interface SandboxOptions {
	manifest: Manifest;
	hostBindings: HostBindings;
	capabilities?: string[];
	console?: {
		log: (...args: unknown[]) => void;
		warn: (...args: unknown[]) => void;
		error: (...args: unknown[]) => void;
	};
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

function injectConsole(
	context: QuickJSContext | QuickJSAsyncContext,
	sandboxConsole: { log: (...args: unknown[]) => void; warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void },
): void {
	const consoleObj = context.newObject();

	for (const method of ["log", "warn", "error"] as const) {
		const fn = context.newFunction(method, (...handles: QuickJSHandle[]) => {
			const args = handles.map((h) => context.dump(h));
			sandboxConsole[method](...args);
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

function createHostFunctionWrapper(
	context: QuickJSContext | QuickJSAsyncContext,
	qualifiedName: string,
	binding: FunctionBinding,
	hostFn: HostFunction | undefined,
	grantedCapabilities: Set<string>,
): QuickJSHandle {
	return context.newFunction(qualifiedName, (...handles: QuickJSHandle[]) => {
		if (binding.capability && !grantedCapabilities.has(binding.capability)) {
			return createCapabilityError(context, qualifiedName, binding.capability);
		}

		if (!hostFn) {
			return createBindingError(context, qualifiedName, "not implemented by the app");
		}

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
): void {
	const asyncKey = `__xript_async_${qualifiedName.replace(/\./g, "_")}`;
	const capabilityDenied = !!(binding.capability && !grantedCapabilities.has(binding.capability));
	const missingImpl = !hostFn;

	if (!capabilityDenied && !missingImpl) {
		const asyncImpl = context.newAsyncifiedFunction(asyncKey, async (...handles: QuickJSHandle[]) => {
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
): void {
	if (isAsync && binding.async) {
		registerAsyncBinding(context as QuickJSAsyncContext, qualifiedName, binding, hostFn, grantedCapabilities);
		const gateKey = `__xript_gate_${qualifiedName.replace(/\./g, "_")}`;
		const gateFn = context.getProp(context.global, gateKey);
		context.setProp(target, propName, gateFn);
		gateFn.dispose();
	} else {
		const fn = createHostFunctionWrapper(context, qualifiedName, binding, hostFn, grantedCapabilities);
		context.setProp(target, propName, fn);
		fn.dispose();
	}
}

function injectBindings(
	context: QuickJSContext | QuickJSAsyncContext,
	manifest: Manifest,
	hostBindings: HostBindings,
	grantedCapabilities: Set<string>,
	isAsync: boolean,
): void {
	if (!manifest.bindings) return;

	for (const [name, binding] of Object.entries(manifest.bindings)) {
		if (isNamespace(binding)) {
			const nsObj = context.newObject();
			const hostNs = hostBindings[name] as Record<string, HostFunction> | undefined;

			for (const [memberName, memberBinding] of Object.entries(binding.members)) {
				const qualifiedName = `${name}.${memberName}`;
				if (isNamespace(memberBinding)) {
					const nestedNsObj = context.newObject();
					const nestedHostNs = hostNs
						? (hostNs[memberName] as unknown as Record<string, HostFunction>)
						: undefined;

					for (const [nestedMemberName, nestedMemberBinding] of Object.entries(memberBinding.members)) {
						if (!isNamespace(nestedMemberBinding)) {
							const nestedQualifiedName = `${qualifiedName}.${nestedMemberName}`;
							const nestedHostFn = nestedHostNs ? nestedHostNs[nestedMemberName] : undefined;
							registerBinding(context, nestedNsObj, nestedMemberName, nestedQualifiedName, nestedMemberBinding, nestedHostFn, grantedCapabilities, isAsync);
						}
					}

					context.setProp(nsObj, memberName, nestedNsObj);
					nestedNsObj.dispose();
				} else {
					const hostFn = hostNs ? hostNs[memberName] : undefined;
					registerBinding(context, nsObj, memberName, qualifiedName, memberBinding, hostFn, grantedCapabilities, isAsync);
				}
			}

			context.setProp(context.global, name, nsObj);
			nsObj.dispose();
		} else {
			const hostFn = hostBindings[name] as HostFunction | undefined;
			registerBinding(context, context.global, name, name, binding, hostFn, grantedCapabilities, isAsync);
		}
	}

	freezeNamespaces(context, manifest);
}

function freezeNamespaces(context: QuickJSContext | QuickJSAsyncContext, manifest: Manifest): void {
	if (!manifest.bindings) return;

	const namespaceNames = Object.entries(manifest.bindings)
		.filter(([_, binding]) => isNamespace(binding))
		.map(([name]) => name);

	if (namespaceNames.length === 0) return;

	const freezeCode = namespaceNames.map((name) => `Object.freeze(${name});`).join("\n");
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
		evalAndDispose(context, "globalThis.hooks = Object.freeze({});");
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

	const hookNsNames = Object.entries(manifest.hooks)
		.filter(([_, h]) => h.phases && h.phases.length > 0)
		.map(([name]) => name);

	if (hookNsNames.length > 0) {
		const freezeCode = hookNsNames.map((n) => `Object.freeze(hooks.${n});`).join("\n");
		evalAndDispose(context, `Object.freeze(hooks);\n${freezeCode}`);
	} else {
		evalAndDispose(context, "Object.freeze(hooks);");
	}
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

export interface SandboxResult {
	execute: (code: string) => ExecutionResult;
	executeAsync: (code: string) => Promise<ExecutionResult>;
	fireHook: (hookName: string, options?: FireHookOptions) => unknown[];
	dispose: () => void;
}

export function createSandboxSync(
	quickjs: QuickJSWASMModule,
	options: SandboxOptions,
): SandboxResult {
	const { manifest, hostBindings, capabilities = [] } = options;
	const grantedCapabilities = new Set(capabilities);
	const limits = manifest.limits || {};
	const timeoutMs = limits.timeout_ms ?? 5000;

	const runtime = quickjs.newRuntime();

	if (limits.memory_mb) {
		runtime.setMemoryLimit(limits.memory_mb * 1024 * 1024);
	}
	if (limits.max_stack_depth) {
		runtime.setMaxStackSize(limits.max_stack_depth * 1024);
	}

	const context = runtime.newContext();

	const sandboxConsole = options.console ?? { log: () => {}, warn: () => {}, error: () => {} };

	injectConsole(context, sandboxConsole);
	blockCodeGeneration(context);
	injectErrorClasses(context);
	injectBindings(context, manifest, hostBindings, grantedCapabilities, false);
	injectHooks(context, manifest, grantedCapabilities);

	function execute(code: string): ExecutionResult {
		runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + timeoutMs));
		const start = performance.now();
		const result = context.evalCode(code, "xript-script.js");
		runtime.removeInterruptHandler();
		const duration_ms = performance.now() - start;

		if (result.error) {
			const errorObj = context.dump(result.error);
			result.error.dispose();

			if (errorObj && typeof errorObj === "object" && errorObj.message && typeof errorObj.message === "string" && errorObj.message.includes("interrupted")) {
				throw Object.assign(new Error(`Script timed out after ${timeoutMs}ms. Optimize your script or ask the app developer to increase the limit.`), { name: "ExecutionLimitError", limit: "timeout_ms" });
			}

			const err = new Error(errorObj?.message || String(errorObj));
			if (errorObj?.name) err.name = errorObj.name;
			Object.assign(err, errorObj);
			throw err;
		}

		const value = context.dump(result.value);
		result.value.dispose();
		return { value, duration_ms };
	}

	async function executeAsync(code: string): Promise<ExecutionResult> {
		const wrappedCode = `(async () => { ${code} })()`;
		runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + timeoutMs));
		const start = performance.now();
		const result = context.evalCode(wrappedCode, "xript-script.js");
		runtime.removeInterruptHandler();

		if (result.error) {
			const errorObj = context.dump(result.error);
			if (result.error.alive) result.error.dispose();

			if (errorObj && typeof errorObj === "object" && errorObj.message && typeof errorObj.message === "string" && errorObj.message.includes("interrupted")) {
				throw Object.assign(new Error(`Script timed out after ${timeoutMs}ms. Optimize your script or ask the app developer to increase the limit.`), { name: "ExecutionLimitError", limit: "timeout_ms" });
			}

			const err = new Error(errorObj?.message || String(errorObj));
			if (errorObj?.name) err.name = errorObj.name;
			Object.assign(err, errorObj);
			throw err;
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
			const err = new Error(errorObj?.message || String(errorObj));
			if (errorObj?.name) err.name = errorObj.name;
			Object.assign(err, errorObj);
			throw err;
		}

		const value = context.dump(awaited.value);
		if (awaited.value.alive) awaited.value.dispose();
		return { value, duration_ms };
	}

	function fireHook(hookName: string, opts?: FireHookOptions): unknown[] {
		return fireHookInContext(context, manifest, hookName, opts);
	}

	function dispose(): void {
		context.dispose();
		runtime.dispose();
	}

	return { execute, executeAsync, fireHook, dispose };
}

export async function createSandboxAsync(
	options: SandboxOptions,
): Promise<SandboxResult> {
	const { newAsyncContext } = await import("quickjs-emscripten");

	const { manifest, hostBindings, capabilities = [] } = options;
	const grantedCapabilities = new Set(capabilities);
	const limits = manifest.limits || {};
	const timeoutMs = limits.timeout_ms ?? 5000;

	const context = await newAsyncContext();
	const runtime = context.runtime;

	if (limits.memory_mb) {
		runtime.setMemoryLimit(limits.memory_mb * 1024 * 1024);
	}
	if (limits.max_stack_depth) {
		runtime.setMaxStackSize(limits.max_stack_depth * 1024);
	}

	const sandboxConsole = options.console ?? { log: () => {}, warn: () => {}, error: () => {} };

	injectConsole(context, sandboxConsole);
	blockCodeGeneration(context);
	injectErrorClasses(context);
	injectBindings(context, manifest, hostBindings, grantedCapabilities, true);
	injectHooks(context, manifest, grantedCapabilities);

	function execute(code: string): ExecutionResult {
		runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + timeoutMs));
		const start = performance.now();
		const result = context.evalCode(code, "xript-script.js");
		runtime.removeInterruptHandler();
		const duration_ms = performance.now() - start;

		if (result.error) {
			const errorObj = context.dump(result.error);
			result.error.dispose();

			if (errorObj && typeof errorObj === "object" && errorObj.message && typeof errorObj.message === "string" && errorObj.message.includes("interrupted")) {
				throw Object.assign(new Error(`Script timed out after ${timeoutMs}ms. Optimize your script or ask the app developer to increase the limit.`), { name: "ExecutionLimitError", limit: "timeout_ms" });
			}

			const err = new Error(errorObj?.message || String(errorObj));
			if (errorObj?.name) err.name = errorObj.name;
			Object.assign(err, errorObj);
			throw err;
		}

		const value = context.dump(result.value);
		result.value.dispose();
		return { value, duration_ms };
	}

	async function executeAsync(code: string): Promise<ExecutionResult> {
		const wrappedCode = `(async () => { ${code} })()`;
		runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + timeoutMs));
		const start = performance.now();
		const result = await context.evalCodeAsync(wrappedCode, "xript-script.js");
		runtime.removeInterruptHandler();

		if (result.error) {
			const errorObj = context.dump(result.error);
			if (result.error.alive) result.error.dispose();
			const duration_ms = performance.now() - start;

			if (errorObj && typeof errorObj === "object" && errorObj.message && typeof errorObj.message === "string" && errorObj.message.includes("interrupted")) {
				throw Object.assign(new Error(`Script timed out after ${timeoutMs}ms. Optimize your script or ask the app developer to increase the limit.`), { name: "ExecutionLimitError", limit: "timeout_ms" });
			}

			const err = new Error(errorObj?.message || String(errorObj));
			if (errorObj?.name) err.name = errorObj.name;
			Object.assign(err, errorObj);
			throw err;
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
			const err = new Error(errorObj?.message || String(errorObj));
			if (errorObj?.name) err.name = errorObj.name;
			Object.assign(err, errorObj);
			throw err;
		}

		const value = context.dump(awaited.value);
		if (awaited.value.alive) awaited.value.dispose();
		return { value, duration_ms };
	}

	function fireHook(hookName: string, opts?: FireHookOptions): unknown[] {
		return fireHookInContext(context, manifest, hookName, opts);
	}

	function dispose(): void {
		context.dispose();
		runtime.dispose();
	}

	return { execute, executeAsync, fireHook, dispose };
}
