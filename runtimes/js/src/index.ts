import type { QuickJSWASMModule } from "quickjs-emscripten";
import {
	createSandboxSync,
	createSandboxAsync,
	CancellationToken,
	type HostBindings,
	type HostFunction,
	type HostNamespace,
	type SandboxOptions,
	type ExecutionResult,
	type FireHookOptions,
	type FragmentOp,
	type ConsoleHandler,
	type LogSeverity,
	type AuditEvent,
	type HardLimits,
} from "./sandbox.js";
import {
	validateModManifest,
	validateModAgainstApp,
	createModInstance,
	modEntryScripts,
	modEntryExports,
	modEntryFormat,
	type ModManifest,
	type ModEntry,
	type ExportDeclaration,
	type ModInstance,
	type FragmentInstance,
	type FragmentUpdateResult,
	type FragmentHandler,
	type FragmentHandlerDeclaration,
	type FragmentEvent,
	type FragmentEventDeclaration,
	type FragmentDeclaration,
	type SlotDeclaration,
	type HookFill,
	normalizeModFills,
	ModManifestValidationError,
} from "./fragment.js";
import { resolveExtends, type ManifestLoader } from "./extends.js";
import { grantedSatisfies } from "./capabilities.js";
import { resolveSlotContributions, type SlotContribution } from "./slots.js";
import { resolveRole as resolveRoleImpl, resolveRoleAll as resolveRoleAllImpl, type RoleResolution } from "./roles.js";
import type { DebugOptions, DebugSession } from "./debug-types.js";

export { BindingError, CapabilityDeniedError, ExecutionLimitError, CancellationError, InvokeError, ModEntryError, ImportDeniedError, CommonJSDetectedError, ModuleUnsupportedError, LibraryUnavailableError, LibraryRegistrationError } from "./errors.js";
export { ModManifestValidationError } from "./fragment.js";
export { CancellationToken } from "./sandbox.js";
export { resolveExtends } from "./extends.js";
export type { ManifestLoader } from "./extends.js";
export { satisfies, grantedSatisfies } from "./capabilities.js";
export type { SlotContribution } from "./slots.js";
export type { RoleResolution } from "./roles.js";
export type {
	DebugOptions,
	DebugSession,
	DebugFidelity,
	SourceBreakpoint,
	Breakpoint,
	StackFrame,
	Scope,
	Variable,
	StoppedEvent,
	StoppedReason,
	ScopeName,
} from "./debug-types.js";
export { DEBUG_THREAD_ID, DebugUnsupportedError } from "./debug-types.js";
export type {
	CapabilityPrompt,
	CapabilityPromptMod,
	CapabilityRisk,
	RequestedScope,
	PromptState,
	InstallDescriptor,
	InstallSource,
	InstallSourceType,
	DiscoveryResult,
	DiscoveredMod,
} from "./shapes.js";
export type { HostBindings, HostFunction, HostNamespace, ExecutionResult, FireHookOptions, FragmentOp, ConsoleHandler, LogSeverity, AuditEvent, HardLimits } from "./sandbox.js";
export type { ModManifest, ModEntry, ExportDeclaration, ModInstance, FragmentInstance, FragmentUpdateResult, FragmentHandler, FragmentHandlerDeclaration, FragmentEvent, FragmentEventDeclaration, FragmentDeclaration, SlotDeclaration, ModContributions, ProviderRole } from "./fragment.js";

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
	events?: HostEventDeclaration[];
}

export interface HostEventDeclaration {
	id: string;
	description: string;
	payload?: unknown;
	capability?: string;
}

export interface ModLoadOptions {
	fragmentSources?: Record<string, string>;
}

export { ManifestValidationError } from "./errors.js";
import { ManifestValidationError, CapabilityDeniedError, ModuleUnsupportedError } from "./errors.js";
import { assertNoCommonJS } from "./module-support.js";

export interface RuntimeOptions {
	hostBindings: HostBindings;
	capabilities?: string[];
	libraries?: Record<string, string>;
	console?: ConsoleHandler;
	audit?: (event: AuditEvent) => void;
	hardLimits?: HardLimits;
	cancellation?: CancellationToken;
	rolePreferences?: Record<string, string>;
	debug?: DebugOptions;
}

export interface XriptRuntime {
	readonly manifest: Manifest;
	execute(code: string): ExecutionResult;
	executeAsync(code: string): Promise<ExecutionResult>;
	debugExecute(code: string): Promise<ExecutionResult>;
	invokeExport(name: string, args: unknown[]): unknown;
	invokeExportAsync(name: string, args: unknown[]): Promise<unknown>;
	fireHook(hookName: string, options?: FireHookOptions): unknown[];
	fireFragmentHook(fragmentId: string, lifecycle: string, bindings?: Record<string, unknown>): FragmentOp[];
	emit(eventId: string, payload?: unknown): unknown[];
	loadMod(modManifest: unknown, options?: ModLoadOptions): ModInstance;
	loadModAsync(modManifest: unknown, options?: ModLoadOptions): Promise<ModInstance>;
	resolveSlot(slotId: string): SlotContribution[];
	resolveSlotSingle(slotId: string): SlotContribution | null;
	resolveRole(role: string): RoleResolution | null;
	resolveRoleAll(role: string): RoleResolution[];
	debugSession(): DebugSession | null;
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

import type { SandboxResult } from "./sandbox.js";

function buildRuntime(
	m: Manifest,
	sandbox: SandboxResult,
	grantedCapabilities: Set<string>,
	rolePreferences?: Record<string, string>,
): XriptRuntime {
	const loadedMods: ModInstance[] = [];
	const slots = m.slots || [];
	const exportCapabilities = new Map<string, string | undefined>();
	const hookFillRegistry: HookFill[] = [];

	function hookFillArgs(data: unknown): unknown[] {
		if (data === undefined) return [];
		if (typeof data === "object" && data !== null && !Array.isArray(data)) return Object.values(data);
		return [data];
	}

	function fireHookWithFills(hookName: string, options?: FireHookOptions): unknown[] {
		const results = sandbox.fireHook(hookName, options);
		if (options?.phase !== undefined) return results;
		for (const fill of hookFillRegistry) {
			if (fill.hook !== hookName) continue;
			try {
				results.push(sandbox.invokeExport(fill.handler, hookFillArgs(options?.data)));
			} catch {
				results.push(undefined);
			}
		}
		return results;
	}

	function gateExport(name: string): void {
		const capability = exportCapabilities.get(name);
		if (capability && !grantedSatisfies(grantedCapabilities, capability)) {
			throw new CapabilityDeniedError(name, capability);
		}
	}

	function registerExportCapabilities(entry: ModManifest["entry"]): void {
		for (const [exportName, decl] of Object.entries(modEntryExports(entry))) {
			exportCapabilities.set(exportName, decl.capability);
		}
	}

	return {
		manifest: m,
		execute: sandbox.execute,
		executeAsync: sandbox.executeAsync,
		debugExecute: sandbox.debugExecute,
		debugSession: sandbox.debugSession,
		invokeExport(name: string, args: unknown[]): unknown {
			gateExport(name);
			return sandbox.invokeExport(name, args);
		},
		invokeExportAsync(name: string, args: unknown[]): Promise<unknown> {
			gateExport(name);
			return sandbox.invokeExportAsync(name, args);
		},
		fireHook: fireHookWithFills,
		fireFragmentHook: sandbox.fireFragmentHook,
		emit: sandbox.emit,

		loadMod(modManifest: unknown, modOptions?: ModLoadOptions): ModInstance {
			const { manifest: normalized, hookFills } = normalizeModFills(modManifest, slots, grantedCapabilities);
			const validated = validateModManifest(normalized);
			const issues = validateModAgainstApp(validated, slots, grantedCapabilities);
			if (issues.length > 0) {
				throw new ModManifestValidationError(issues);
			}
			const sources = modOptions?.fragmentSources || {};
			const mod = createModInstance(validated, sources);

			if (modEntryFormat(validated.entry) === "module") {
				throw new ModuleUnsupportedError();
			}

			for (const entryScript of modEntryScripts(validated.entry)) {
				const code = sources[entryScript];
				if (code) {
					assertNoCommonJS(code);
					sandbox.execute(code);
				}
			}

			registerExportCapabilities(validated.entry);
			hookFillRegistry.push(...hookFills);
			loadedMods.push(mod);
			return mod;
		},

		async loadModAsync(modManifest: unknown, modOptions?: ModLoadOptions): Promise<ModInstance> {
			const { manifest: normalized, hookFills } = normalizeModFills(modManifest, slots, grantedCapabilities);
			const validated = validateModManifest(normalized);
			const issues = validateModAgainstApp(validated, slots, grantedCapabilities);
			if (issues.length > 0) {
				throw new ModManifestValidationError(issues);
			}
			const sources = modOptions?.fragmentSources || {};
			const mod = createModInstance(validated, sources);
			const format = modEntryFormat(validated.entry);

			for (const entryScript of modEntryScripts(validated.entry)) {
				const code = sources[entryScript];
				if (!code) continue;
				assertNoCommonJS(code);
				if (format === "module") {
					await sandbox.evaluateModule(validated.name, code);
				} else {
					sandbox.execute(code);
				}
			}

			registerExportCapabilities(validated.entry);
			hookFillRegistry.push(...hookFills);
			loadedMods.push(mod);
			return mod;
		},

		resolveSlot(slotId: string): SlotContribution[] {
			return resolveSlotContributions(slotId, loadedMods, slots);
		},

		resolveSlotSingle(slotId: string): SlotContribution | null {
			const ordered = resolveSlotContributions(slotId, loadedMods, slots);
			return ordered.length > 0 ? ordered[0] : null;
		},

		resolveRole(role: string): RoleResolution | null {
			return resolveRoleImpl(role, loadedMods, rolePreferences);
		},

		resolveRoleAll(role: string): RoleResolution[] {
			return resolveRoleAllImpl(role, loadedMods);
		},

		dispose: sandbox.dispose,
	};
}

export async function initXript(): Promise<XriptFactory> {
	const { getQuickJS } = await import("quickjs-emscripten");
	const quickjs: QuickJSWASMModule = await getQuickJS();

	return {
		createRuntime(manifest: unknown, options: RuntimeOptions): XriptRuntime {
			const m = checkBasicStructure(manifest);
			const grantedCapabilities = new Set(options.capabilities || []);

			const sandbox = createSandboxSync(quickjs, {
				manifest: m as SandboxOptions["manifest"],
				hostBindings: options.hostBindings,
				capabilities: options.capabilities,
				libraries: options.libraries,
				console: options.console,
				audit: options.audit,
				hardLimits: options.hardLimits,
				cancellation: options.cancellation,
				debug: options.debug,
			});

			return buildRuntime(m, sandbox, grantedCapabilities, options.rolePreferences);
		},
	};
}

export async function initXriptAsync(): Promise<{
	createRuntime(manifest: unknown, options: RuntimeOptions): Promise<XriptRuntime>;
}> {
	return {
		async createRuntime(manifest: unknown, options: RuntimeOptions): Promise<XriptRuntime> {
			const m = checkBasicStructure(manifest);
			const grantedCapabilities = new Set(options.capabilities || []);

			const sandbox = await createSandboxAsync({
				manifest: m as SandboxOptions["manifest"],
				hostBindings: options.hostBindings,
				capabilities: options.capabilities,
				libraries: options.libraries,
				console: options.console,
				audit: options.audit,
				hardLimits: options.hardLimits,
				cancellation: options.cancellation,
				debug: options.debug,
			});

			return buildRuntime(m, sandbox, grantedCapabilities, options.rolePreferences);
		},
	};
}
