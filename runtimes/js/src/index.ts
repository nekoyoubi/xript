import type { QuickJSWASMModule } from "quickjs-emscripten";
import { createSandboxSync, createSandboxAsync, type HostBindings, type HostFunction, type SandboxOptions, type ExecutionResult, type FireHookOptions } from "./sandbox.js";

export { BindingError, CapabilityDeniedError, ExecutionLimitError } from "./errors.js";
export type { HostBindings, HostFunction, ExecutionResult, FireHookOptions } from "./sandbox.js";

interface Manifest {
	xript: string;
	name: string;
	version?: string;
	bindings?: Record<string, unknown>;
	hooks?: Record<string, unknown>;
	capabilities?: Record<string, unknown>;
	limits?: {
		timeout_ms?: number;
		memory_mb?: number;
		max_stack_depth?: number;
	};
}

export class ManifestValidationError extends Error {
	public readonly issues: Array<{ path: string; message: string }>;

	constructor(issues: Array<{ path: string; message: string }>) {
		const summary = issues.map((i) => `  ${i.path}: ${i.message}`).join("\n");
		super(`Invalid xript manifest:\n${summary}`);
		this.name = "ManifestValidationError";
		this.issues = issues;
	}
}

export interface RuntimeOptions {
	hostBindings: HostBindings;
	capabilities?: string[];
	console?: {
		log: (...args: unknown[]) => void;
		warn: (...args: unknown[]) => void;
		error: (...args: unknown[]) => void;
	};
}

export interface XriptRuntime {
	readonly manifest: Manifest;
	execute(code: string): ExecutionResult;
	executeAsync(code: string): Promise<ExecutionResult>;
	fireHook(hookName: string, options?: FireHookOptions): unknown[];
	dispose(): void;
}

export interface XriptFactory {
	createRuntime(manifest: unknown, options: RuntimeOptions): XriptRuntime;
}

function checkBasicStructure(manifest: unknown): Manifest {
	if (typeof manifest !== "object" || manifest === null) {
		throw new ManifestValidationError([{ path: "/", message: "manifest must be a non-null object" }]);
	}

	const m = manifest as Record<string, unknown>;

	const issues: Array<{ path: string; message: string }> = [];

	if (typeof m.xript !== "string" || m.xript.length === 0) {
		issues.push({ path: "/xript", message: "required field 'xript' must be a non-empty string" });
	}

	if (typeof m.name !== "string" || m.name.length === 0) {
		issues.push({ path: "/name", message: "required field 'name' must be a non-empty string" });
	}

	if (m.bindings !== undefined && (typeof m.bindings !== "object" || m.bindings === null)) {
		issues.push({ path: "/bindings", message: "'bindings' must be an object" });
	}

	if (m.hooks !== undefined && (typeof m.hooks !== "object" || m.hooks === null)) {
		issues.push({ path: "/hooks", message: "'hooks' must be an object" });
	}

	if (m.capabilities !== undefined && (typeof m.capabilities !== "object" || m.capabilities === null)) {
		issues.push({ path: "/capabilities", message: "'capabilities' must be an object" });
	}

	if (m.limits !== undefined) {
		if (typeof m.limits !== "object" || m.limits === null) {
			issues.push({ path: "/limits", message: "'limits' must be an object" });
		} else {
			const limits = m.limits as Record<string, unknown>;
			if (limits.timeout_ms !== undefined && (typeof limits.timeout_ms !== "number" || limits.timeout_ms <= 0)) {
				issues.push({ path: "/limits/timeout_ms", message: "'timeout_ms' must be a positive number" });
			}
			if (limits.memory_mb !== undefined && (typeof limits.memory_mb !== "number" || limits.memory_mb <= 0)) {
				issues.push({ path: "/limits/memory_mb", message: "'memory_mb' must be a positive number" });
			}
		}
	}

	if (issues.length > 0) {
		throw new ManifestValidationError(issues);
	}

	return manifest as Manifest;
}

export async function initXript(): Promise<XriptFactory> {
	const { getQuickJS } = await import("quickjs-emscripten");
	const quickjs: QuickJSWASMModule = await getQuickJS();

	return {
		createRuntime(manifest: unknown, options: RuntimeOptions): XriptRuntime {
			const m = checkBasicStructure(manifest);

			const sandbox = createSandboxSync(quickjs, {
				manifest: m as SandboxOptions["manifest"],
				hostBindings: options.hostBindings,
				capabilities: options.capabilities,
				console: options.console,
			});

			return {
				manifest: m,
				execute: sandbox.execute,
				executeAsync: sandbox.executeAsync,
				fireHook: sandbox.fireHook,
				dispose: sandbox.dispose,
			};
		},
	};
}

export async function initXriptAsync(): Promise<{
	createRuntime(manifest: unknown, options: RuntimeOptions): Promise<XriptRuntime>;
}> {
	return {
		async createRuntime(manifest: unknown, options: RuntimeOptions): Promise<XriptRuntime> {
			const m = checkBasicStructure(manifest);

			const sandbox = await createSandboxAsync({
				manifest: m as SandboxOptions["manifest"],
				hostBindings: options.hostBindings,
				capabilities: options.capabilities,
				console: options.console,
			});

			return {
				manifest: m,
				execute: sandbox.execute,
				executeAsync: sandbox.executeAsync,
				fireHook: sandbox.fireHook,
				dispose: sandbox.dispose,
			};
		},
	};
}
