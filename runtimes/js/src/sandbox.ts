import vm from "node:vm";
import { BindingError, CapabilityDeniedError } from "./errors.js";

interface Manifest {
	xript: string;
	name: string;
	version?: string;
	bindings?: Record<string, Binding>;
	capabilities?: Record<string, CapabilityDef>;
	limits?: ExecutionLimits;
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
			throw new BindingError(qualifiedName, "no host implementation provided");
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

export function createSandbox(options: SandboxOptions): {
	execute: (code: string) => ExecutionResult;
	executeAsync: (code: string) => Promise<ExecutionResult>;
} {
	const { manifest } = options;
	const limits = manifest.limits || {};
	const timeoutMs = limits.timeout_ms ?? 5000;

	const sandboxGlobals = buildSandboxGlobal(options);

	const context = vm.createContext(sandboxGlobals, {
		codeGeneration: {
			strings: false,
			wasm: false,
		},
	});

	sandboxGlobals.globalThis = context;

	function execute(code: string): ExecutionResult {
		const start = performance.now();
		const script = new vm.Script(code, { filename: "xript-script.js" });
		const value = script.runInContext(context, { timeout: timeoutMs });
		const duration_ms = performance.now() - start;
		return { value, duration_ms };
	}

	async function executeAsync(code: string): Promise<ExecutionResult> {
		const start = performance.now();
		const wrappedCode = `(async () => { ${code} })()`;
		const script = new vm.Script(wrappedCode, { filename: "xript-script.js" });
		const promise = script.runInContext(context, { timeout: timeoutMs });
		const value = await promise;
		const duration_ms = performance.now() - start;
		return { value, duration_ms };
	}

	return { execute, executeAsync };
}
