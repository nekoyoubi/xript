import vm from "node:vm";
import { BindingError, CapabilityDeniedError, ExecutionLimitError } from "./errors.js";

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

function buildSandboxGlobal(options: SandboxOptions): Record<string, unknown> {
	const { manifest, hostBindings, capabilities = [] } = options;
	const grantedCapabilities = new Set(capabilities);

	const sandboxConsole = options.console || {
		log: () => {},
		warn: () => {},
		error: () => {},
	};

	const globals: Record<string, unknown> = {};

	globals.console = {
		log: (...args: unknown[]) => sandboxConsole.log(...args),
		warn: (...args: unknown[]) => sandboxConsole.warn(...args),
		error: (...args: unknown[]) => sandboxConsole.error(...args),
	};

	globals.JSON = { parse: JSON.parse, stringify: JSON.stringify };
	globals.Math = Math;
	globals.Date = Date;
	globals.Number = Number;
	globals.String = String;
	globals.Boolean = Boolean;
	globals.Array = Array;
	globals.Object = Object;
	globals.Map = Map;
	globals.Set = Set;
	globals.WeakMap = WeakMap;
	globals.WeakSet = WeakSet;
	globals.Promise = Promise;
	globals.Error = Error;
	globals.TypeError = TypeError;
	globals.RangeError = RangeError;
	globals.SyntaxError = SyntaxError;
	globals.ReferenceError = ReferenceError;
	globals.RegExp = RegExp;
	globals.Symbol = Symbol;
	globals.ArrayBuffer = ArrayBuffer;
	globals.DataView = DataView;
	globals.Int8Array = Int8Array;
	globals.Uint8Array = Uint8Array;
	globals.Int16Array = Int16Array;
	globals.Uint16Array = Uint16Array;
	globals.Int32Array = Int32Array;
	globals.Uint32Array = Uint32Array;
	globals.Float32Array = Float32Array;
	globals.Float64Array = Float64Array;
	globals.BigInt64Array = BigInt64Array;
	globals.BigUint64Array = BigUint64Array;
	globals.BigInt = BigInt;
	globals.Proxy = Proxy;
	globals.Reflect = Reflect;

	globals.isNaN = isNaN;
	globals.isFinite = isFinite;
	globals.parseInt = parseInt;
	globals.parseFloat = parseFloat;
	globals.undefined = undefined;
	globals.NaN = NaN;
	globals.Infinity = Infinity;

	globals.BindingError = BindingError;
	globals.CapabilityDeniedError = CapabilityDeniedError;

	globals.eval = () => {
		throw new TypeError("eval() is not permitted. Dynamic code generation is disabled in xript.");
	};
	globals.Function = new Proxy(Function, {
		construct() {
			throw new TypeError(
				"new Function() is not permitted. Dynamic code generation is disabled in xript.",
			);
		},
		apply() {
			throw new TypeError(
				"Function() is not permitted. Dynamic code generation is disabled in xript.",
			);
		},
	});

	if (manifest.bindings) {
		for (const [name, binding] of Object.entries(manifest.bindings)) {
			if (isNamespace(binding)) {
				globals[name] = buildNamespace(
					name,
					binding,
					hostBindings[name] as Record<string, HostFunction> | undefined,
					grantedCapabilities,
				);
			} else {
				globals[name] = buildFunction(
					name,
					binding,
					hostBindings[name] as HostFunction | undefined,
					grantedCapabilities,
				);
			}
		}
	}

	return globals;
}

function buildFunction(
	qualifiedName: string,
	binding: FunctionBinding,
	hostFn: HostFunction | undefined,
	grantedCapabilities: Set<string>,
): HostFunction {
	return (...args: unknown[]) => {
		if (binding.capability && !grantedCapabilities.has(binding.capability)) {
			throw new CapabilityDeniedError(qualifiedName, binding.capability);
		}

		if (!hostFn) {
			throw new BindingError(qualifiedName, "not implemented by the app");
		}

		try {
			return hostFn(...args);
		} catch (e) {
			if (e instanceof CapabilityDeniedError || e instanceof BindingError) throw e;
			const message = e instanceof Error ? e.message : String(e);
			throw new BindingError(qualifiedName, message);
		}
	};
}

function buildNamespace(
	namespaceName: string,
	binding: NamespaceBinding,
	hostNs: Record<string, HostFunction> | undefined,
	grantedCapabilities: Set<string>,
): Record<string, unknown> {
	const ns: Record<string, unknown> = {};

	for (const [memberName, memberBinding] of Object.entries(binding.members)) {
		const qualifiedName = `${namespaceName}.${memberName}`;
		if (isNamespace(memberBinding)) {
			const nestedHostNs = hostNs
				? (hostNs[memberName] as unknown as Record<string, HostFunction>)
				: undefined;
			ns[memberName] = buildNamespace(qualifiedName, memberBinding, nestedHostNs, grantedCapabilities);
		} else {
			const hostFn = hostNs ? hostNs[memberName] : undefined;
			ns[memberName] = buildFunction(qualifiedName, memberBinding, hostFn, grantedCapabilities);
		}
	}

	return Object.freeze(ns);
}

export interface FireHookOptions {
	phase?: string;
	data?: unknown;
}

export interface FragmentOp {
	op: "toggle" | "addClass" | "removeClass" | "setText" | "setAttr" | "replaceChildren";
	selector: string;
	value?: unknown;
	attr?: string;
}

type HookHandlerEntry = { fn: (...args: unknown[]) => unknown };

interface HandlerRegistry {
	handlers: Map<string, HookHandlerEntry[]>;
	register(key: string, entry: HookHandlerEntry): void;
}

function createHandlerRegistry(): HandlerRegistry {
	const handlers = new Map<string, HookHandlerEntry[]>();
	return {
		handlers,
		register(key: string, entry: HookHandlerEntry) {
			let list = handlers.get(key);
			if (!list) {
				list = [];
				handlers.set(key, list);
			}
			list.push(entry);
		},
	};
}

function buildHooksGlobal(
	manifest: Manifest,
	grantedCapabilities: Set<string>,
	hookRegistry: HandlerRegistry,
	fragmentRegistry: HandlerRegistry,
): Record<string, unknown> {
	const hooksObj: Record<string, unknown> = {};

	if (manifest.hooks) {
		for (const [hookName, hookDef] of Object.entries(manifest.hooks)) {
			if (hookDef.phases && hookDef.phases.length > 0) {
				const hookNs: Record<string, unknown> = {};

				for (const phase of hookDef.phases) {
					const registryKey = `${hookName}:${phase}`;
					hookNs[phase] = (handler: (...args: unknown[]) => unknown) => {
						if (hookDef.capability && !grantedCapabilities.has(hookDef.capability)) {
							throw new CapabilityDeniedError(`hooks.${hookName}.${phase}`, hookDef.capability);
						}
						if (typeof handler !== "function") {
							throw new BindingError(`hooks.${hookName}.${phase}`, "expected a handler function");
						}
						hookRegistry.register(registryKey, { fn: handler });
					};
				}

				hooksObj[hookName] = Object.freeze(hookNs);
			} else {
				const registryKey = hookName;
				hooksObj[hookName] = (handler: (...args: unknown[]) => unknown) => {
					if (hookDef.capability && !grantedCapabilities.has(hookDef.capability)) {
						throw new CapabilityDeniedError(`hooks.${hookName}`, hookDef.capability);
					}
					if (typeof handler !== "function") {
						throw new BindingError(`hooks.${hookName}`, "expected a handler function");
					}
					hookRegistry.register(registryKey, { fn: handler });
				};
			}
		}
	}

	const fragmentNs: Record<string, unknown> = {};
	const lifecycles = ["mount", "unmount", "update", "suspend", "resume"];
	for (const lifecycle of lifecycles) {
		fragmentNs[lifecycle] = (fragmentId: string, handler: (...args: unknown[]) => unknown) => {
			if (typeof handler !== "function") {
				throw new BindingError(`hooks.fragment.${lifecycle}`, "expected (fragmentId, handler)");
			}
			const registryKey = `fragment:${lifecycle}:${fragmentId}`;
			fragmentRegistry.register(registryKey, { fn: handler });
		};
	}
	hooksObj.fragment = Object.freeze(fragmentNs);

	return Object.freeze(hooksObj);
}

function fireHookFromRegistry(
	hookRegistry: HandlerRegistry,
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

	const entries = hookRegistry.handlers.get(registryKey);
	if (!entries || entries.length === 0) return [];

	const data = options?.data;
	const args = data !== undefined
		? (typeof data === "object" && data !== null && !Array.isArray(data)
			? Object.values(data as Record<string, unknown>)
			: [data])
		: [];

	const results: unknown[] = [];
	for (const entry of entries) {
		try {
			results.push(entry.fn(...args));
		} catch {
			results.push(undefined);
		}
	}
	return results;
}

function fireFragmentHookFromRegistry(
	fragmentRegistry: HandlerRegistry,
	fragmentId: string,
	lifecycle: string,
	bindings?: Record<string, unknown>,
): FragmentOp[] {
	const registryKey = `fragment:${lifecycle}:${fragmentId}`;
	const entries = fragmentRegistry.handlers.get(registryKey);
	if (!entries || entries.length === 0) return [];

	const allOps: FragmentOp[] = [];
	for (const entry of entries) {
		const ops: FragmentOp[] = [];
		const fragmentProxy = {
			toggle(selector: string, condition: unknown) { ops.push({ op: "toggle", selector, value: !!condition }); },
			addClass(selector: string, className: string) { ops.push({ op: "addClass", selector, value: className }); },
			removeClass(selector: string, className: string) { ops.push({ op: "removeClass", selector, value: className }); },
			setText(selector: string, text: string) { ops.push({ op: "setText", selector, value: text }); },
			setAttr(selector: string, attr: string, value: unknown) { ops.push({ op: "setAttr", selector, attr, value }); },
			replaceChildren(selector: string, html: unknown) {
				const content = Array.isArray(html) ? html.join("") : html;
				ops.push({ op: "replaceChildren", selector, value: content });
			},
		};
		try {
			entry.fn(bindings, fragmentProxy);
		} catch {
			// swallow errors from individual handlers
		}
		allOps.push(...ops);
	}
	return allOps;
}

export function createSandbox(options: SandboxOptions): {
	execute: (code: string) => ExecutionResult;
	executeAsync: (code: string) => Promise<ExecutionResult>;
	fireHook: (hookName: string, options?: FireHookOptions) => unknown[];
	fireFragmentHook: (fragmentId: string, lifecycle: string, bindings?: Record<string, unknown>) => FragmentOp[];
} {
	const { manifest, capabilities = [] } = options;
	const grantedCapabilities = new Set(capabilities);
	const limits = manifest.limits || {};
	const timeoutMs = limits.timeout_ms ?? 5000;
	const hookRegistry = createHandlerRegistry();
	const fragmentRegistry = createHandlerRegistry();

	const sandboxGlobals = buildSandboxGlobal(options);
	sandboxGlobals.hooks = buildHooksGlobal(manifest, grantedCapabilities, hookRegistry, fragmentRegistry);

	const context = vm.createContext(sandboxGlobals, {
		codeGeneration: {
			strings: false,
			wasm: false,
		},
	});

	sandboxGlobals.globalThis = context;

	function cleanStack(err: Error): void {
		if (!err.stack) return;
		err.stack = err.stack
			.split("\n")
			.filter((line) => !line.includes("node:vm") && !line.includes("node:internal"))
			.join("\n");
	}

	function isTimeoutError(e: unknown): boolean {
		if (typeof e !== "object" || e === null) return false;
		const err = e as Record<string, unknown>;
		if (err.code === "ERR_SCRIPT_EXECUTION_TIMEOUT") return true;
		return typeof err.message === "string" && err.message.includes("Script execution timed out");
	}

	function wrapTimeoutError(e: unknown): never {
		if (isTimeoutError(e)) {
			throw new ExecutionLimitError(
				"timeout_ms",
				`Script timed out after ${timeoutMs}ms. Optimize your script or ask the app developer to increase the limit.`,
			);
		}
		if (e instanceof Error) cleanStack(e);
		throw e;
	}

	function execute(code: string): ExecutionResult {
		const start = performance.now();
		const script = new vm.Script(code, { filename: "xript-script.js" });
		try {
			const value = script.runInContext(context, { timeout: timeoutMs });
			const duration_ms = performance.now() - start;
			return { value, duration_ms };
		} catch (e) {
			return wrapTimeoutError(e);
		}
	}

	async function executeAsync(code: string): Promise<ExecutionResult> {
		const start = performance.now();
		const wrappedCode = `(async () => { ${code} })()`;
		const script = new vm.Script(wrappedCode, { filename: "xript-script.js" });
		try {
			const promise = script.runInContext(context, { timeout: timeoutMs });
			const value = await promise;
			const duration_ms = performance.now() - start;
			return { value, duration_ms };
		} catch (e) {
			return wrapTimeoutError(e);
		}
	}

	function fireHook(hookName: string, opts?: FireHookOptions): unknown[] {
		return fireHookFromRegistry(hookRegistry, manifest, hookName, opts);
	}

	function fireFragmentHook(fragmentId: string, lifecycle: string, bindings?: Record<string, unknown>): FragmentOp[] {
		return fireFragmentHookFromRegistry(fragmentRegistry, fragmentId, lifecycle, bindings);
	}

	return { execute, executeAsync, fireHook, fireFragmentHook };
}
