import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createSandbox, type HostBindings, type HostFunction, type SandboxOptions, type ExecutionResult, type FireHookOptions, type FragmentOp } from "./sandbox.js";
import {
	validateModManifest,
	validateModAgainstApp,
	createModInstance,
	type ModManifest,
	type ModInstance,
	type FragmentInstance,
	type FragmentUpdateResult,
	type FragmentEvent,
	type FragmentDeclaration,
	type SlotDeclaration,
	ModManifestValidationError,
} from "./fragment.js";

export { BindingError, CapabilityDeniedError, ExecutionLimitError } from "./errors.js";
export { ModManifestValidationError } from "./fragment.js";
export type { HostBindings, HostFunction, ExecutionResult, FireHookOptions, FragmentOp } from "./sandbox.js";
export type { ModManifest, ModInstance, FragmentInstance, FragmentUpdateResult, FragmentEvent, FragmentDeclaration, SlotDeclaration } from "./fragment.js";

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
	slots?: SlotDeclaration[];
}

export interface ModLoadOptions {
	fragmentSources?: Record<string, string>;
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
	fireFragmentHook(fragmentId: string, lifecycle: string, bindings?: Record<string, unknown>): FragmentOp[];
	loadMod(modManifest: unknown, options?: ModLoadOptions): ModInstance;
	dispose(): void;
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

export function createRuntime(manifest: unknown, options: RuntimeOptions): XriptRuntime {
	const m = checkBasicStructure(manifest);
	const grantedCapabilities = new Set(options.capabilities || []);

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
		fireHook: sandbox.fireHook,
		fireFragmentHook: sandbox.fireFragmentHook,

		loadMod(modManifest: unknown, modOptions?: ModLoadOptions): ModInstance {
			const validated = validateModManifest(modManifest);
			const slots = m.slots || [];
			const issues = validateModAgainstApp(validated, slots, grantedCapabilities);
			if (issues.length > 0) {
				throw new ModManifestValidationError(issues);
			}
			const sources = modOptions?.fragmentSources || {};
			const mod = createModInstance(validated, sources);

			if (validated.entry) {
				const entries = Array.isArray(validated.entry) ? validated.entry : [validated.entry];
				for (const entry of entries) {
					const code = sources[entry];
					if (code) sandbox.execute(code);
				}
			}

			return mod;
		},

		dispose() {},
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
