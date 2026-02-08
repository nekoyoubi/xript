import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createSandbox, type HostBindings, type HostFunction, type SandboxOptions, type ExecutionResult } from "./sandbox.js";

export { BindingError, CapabilityDeniedError, ExecutionLimitError } from "./errors.js";
export type { HostBindings, HostFunction, ExecutionResult } from "./sandbox.js";

interface Manifest {
	xript: string;
	name: string;
	version?: string;
	bindings?: Record<string, unknown>;
	capabilities?: Record<string, unknown>;
	limits?: {
		timeout_ms?: number;
		memory_mb?: number;
		max_stack_depth?: number;
	};
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
}

export function createRuntime(manifest: unknown, options: RuntimeOptions): XriptRuntime {
	const m = manifest as Manifest;

	if (!m.xript || !m.name) {
		throw new Error("Invalid manifest: 'xript' and 'name' are required fields.");
	}

	const sandbox = createSandbox({
		manifest: m as SandboxOptions["manifest"],
		hostBindings: options.hostBindings,
		capabilities: options.capabilities,
		console: options.console,
	});

	return {
		manifest: m,
		execute: sandbox.execute,
		executeAsync: sandbox.executeAsync,
	};
}

export async function createRuntimeFromFile(
	manifestPath: string,
	options: RuntimeOptions,
): Promise<XriptRuntime> {
	const absolutePath = resolve(manifestPath);
	const raw = await readFile(absolutePath, "utf-8");
	const manifest = JSON.parse(raw) as unknown;
	return createRuntime(manifest, options);
}
