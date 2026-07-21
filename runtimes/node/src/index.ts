import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import {
	DEFAULT_TIMEOUT_MS,
	createSandbox,
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
	missingBindingNames,
} from "./sandbox.js";
import {
	validateModManifest,
	normalizeModFills,
	type HookFill,
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
	type FragmentEvent,
	type FragmentDeclaration,
	type SlotDeclaration,
	ModManifestValidationError,
} from "./fragment.js";
import { finalizeOps, type FragmentDiagnosticListener, type RuntimeDiagnostic } from "./ops.js";
import { BUILTIN_PROFILES } from "@xriptjs/sanitize";
import { MissingBindingsError, ManifestValidationError, CapabilityDeniedError, CommandInputError, ModuleUnsupportedError, AmbiguousExportError } from "./errors.js";
import { assertNoCommonJS } from "./module-support.js";
import { resolveExtends, type ManifestLoader } from "./extends.js";
import { resolveSlotContributions, type SlotContribution } from "./slots.js";
import { resolveRole as resolveRoleImpl, resolveRoleAll as resolveRoleAllImpl, type RoleResolution } from "./roles.js";
import {
	mergeCommandArgs,
	resolveCommand as resolveCommandImpl,
	resolveCommands as resolveCommandsImpl,
	resolveCommandsAll as resolveCommandsAllImpl,
	type ResolvedCommand,
} from "./commands.js";
import { grantedSatisfies } from "./capabilities.js";
import type { DebugOptions, DebugSession } from "./debug-types.js";

export { MissingBindingsError } from "./errors.js";
export { AmbiguousExportError, BindingError, CapabilityDeniedError, CommandInputError, ExecutionLimitError, CancellationError, InvokeError, ManifestValidationError, ModEntryError, ImportDeniedError, CommonJSDetectedError, ModuleUnsupportedError, LibraryUnavailableError, LibraryRegistrationError } from "./errors.js";
export { ModManifestValidationError } from "./fragment.js";
export { FragmentFormatError, FragmentSanitizeError, createFragmentInstance, createModInstance, normalizeModFills, sanitizeSource, processTree, parseNodeRef, TREE_CONTRACT_VERSION, BUILTIN_PROFILES, DEFAULT_URI_SCHEMES, DEFAULT_URI_SCHEME_SET, PROHIBITED_URI_SCHEMES, URI_SCHEME_NAME_PATTERN } from "./fragment.js";
export { treeToHtml, treeToJsml } from "@xriptjs/sanitize";
export { finalizeOps } from "./ops.js";
export type { RuntimeDiagnostic, RuntimeDiagnosticCode, FragmentDiagnosticListener } from "./ops.js";
export { CancellationToken } from "./sandbox.js";
export { resolveExtends } from "./extends.js";
export { satisfies, grantedSatisfies, splitMode } from "./capabilities.js";
export type { ManifestLoader } from "./extends.js";
export { resolveSlotContributions } from "./slots.js";
export type { SlotContribution } from "./slots.js";
export { resolveRole, resolveRoleAll } from "./roles.js";
export type { RoleResolution } from "./roles.js";
export {
	COMMAND_ID_PATTERN,
	mergeCommandArgs,
	resolveCommand,
	resolveCommands,
	resolveCommandsAll,
} from "./commands.js";
export type { CommandFill, ResolvedCommand } from "./commands.js";
export {
	COMMAND_SLOT_ACCEPT,
	HOOK_SLOT_ACCEPT,
	ROLE_SLOT_ACCEPT,
	RESERVED_SLOT_ACCEPTS,
	isCommandSlot,
	isHookSlot,
	isRoleSlot,
	slotKindForFill,
} from "./slot-kinds.js";
export type { SlotKind } from "./slot-kinds.js";
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
export type { HostBindings, HostFunction, HostNamespace, ExecutionResult, FireHookOptions, FragmentOp, FragmentOpName, RawFragmentOp, ConsoleHandler, LogSeverity, AuditEvent, AuditDecision, HardLimits } from "./sandbox.js";
export type { ModManifest, ModEntry, ExportDeclaration, ModInstance, FragmentInstance, FragmentUpdateResult, FragmentHandler, FragmentHandlerDeclaration, FragmentEvent, FragmentEventDeclaration, FragmentDeclaration, SlotDeclaration, ModContributions, ProviderRole, NodeRef, FragmentContentType, FragmentTree, FragmentNode, FragmentElement, PropValue, FormatProfile, FragmentDiagnostic, FragmentOptions } from "./fragment.js";

interface Manifest {
	xript: string;
	name: string;
	version?: string;
	bindings?: Record<string, unknown>;
	hooks?: Record<string, unknown>;
	events?: Array<{ id: string; description: string; payload?: unknown; capability?: string }>;
	capabilities?: Record<string, unknown>;
	limits?: {
		timeout_ms?: number;
		memory_mb?: number;
		max_stack_depth?: number;
	};
	slots?: SlotDeclaration[];
	formats?: Record<string, unknown>;
	vocabularies?: Record<string, unknown>;
}

export interface ModLoadOptions {
	fragmentSources?: Record<string, string>;
}

/**
 * A host-supplied argument check. Returns the problems it found; an empty or absent result
 * means the arguments are acceptable. Only called for commands that declare an `input`.
 */
export type CommandInputValidator = (
	input: unknown,
	args: Record<string, unknown>,
	command: ResolvedCommand,
) => string[] | null | undefined | void;

export interface RuntimeOptions {
	hostBindings: HostBindings;
	capabilities?: string[];
	libraries?: Record<string, string>;
	console?: ConsoleHandler;
	audit?: (event: AuditEvent) => void;
	hardLimits?: HardLimits;
	cancellation?: CancellationToken;
	rolePreferences?: Record<string, string>;
	/** Preferred owning mod, keyed by command id or by command slot id, for bare-id lookups. */
	commandPreferences?: Record<string, string>;
	/**
	 * Optional argument checking at invoke. The runtime bundles no JSON Schema validator; a
	 * host that wants full `input` validation passes its own predicate.
	 */
	validateInput?: CommandInputValidator;
	debug?: DebugOptions;
	/**
	 * Promotes an unknown node under the built-in HTML vocabulary from a warning to an
	 * error. HTML's tag surface is open, so the allowlist drops unknown tags by default;
	 * a host that wants the stricter contract opts in.
	 */
	strictHtmlVocabulary?: boolean;
	/**
	 * Refuse to construct the runtime when the manifest declares a binding the host did not
	 * supply. Off by default; the missing set is always available as `missingBindings`.
	 */
	strictBindings?: boolean;
	/** Push channel for sanitization findings, at load and at op time. */
	onFragmentDiagnostic?: FragmentDiagnosticListener;
}

export interface XriptRuntime {
	readonly manifest: Manifest;
	execute(code: string): ExecutionResult;
	executeAsync(code: string): Promise<ExecutionResult>;
	debugExecute(code: string): Promise<ExecutionResult>;
	invokeExport(name: string, args: unknown[]): unknown;
	invokeExportAsync(name: string, args: unknown[]): Promise<unknown>;
	/**
	 * Invokes an export inside one named mod's own namespace. Gated by that mod's own
	 * declaration, so a second mod declaring the same name cannot weaken the gate.
	 */
	invokeModExport(mod: string, name: string, args: unknown[]): unknown;
	invokeModExportAsync(mod: string, name: string, args: unknown[]): Promise<unknown>;
	fireHook(hookName: string, options?: FireHookOptions): unknown[];
	emit(eventId: string, payload?: unknown): unknown[];
	fireFragmentHook(fragmentId: string, lifecycle: string, bindings?: Record<string, unknown>): FragmentOp[];
	loadMod(modManifest: unknown, options?: ModLoadOptions): ModInstance;
	loadModAsync(modManifest: unknown, options?: ModLoadOptions): Promise<ModInstance>;
	resolveSlot(slotId: string): SlotContribution[];
	resolveSlotSingle(slotId: string): SlotContribution | null;
	resolveRole(role: string): RoleResolution | null;
	resolveRoleAll(role: string): RoleResolution[];
	/** The commands a host should offer for a slot, with the slot's cardinality applied. */
	resolveCommands(slotId: string): ResolvedCommand[];
	/** Every command filled into a slot, ordered, with cardinality ignored. */
	resolveCommandsAll(slotId: string): ResolvedCommand[];
	/** Looks a command up by bare id or a `mod:id` qualified id. */
	resolveCommand(ref: string): ResolvedCommand | null;
	/**
	 * Runs a command: bound arguments overlaid by the caller's, then the handler invoked
	 * inside its declaring mod's own export namespace, behind that export's capability
	 * gate. A throwing handler propagates -- a user-triggered action that fails says so.
	 */
	/**
	 * The deadline that governs a call into a fill of this slot, after the slot's
	 * own `limits`, the manifest's, and the embedder's ceiling have been applied.
	 * A host routing long work needs to know the budget it is routing under.
	 */
	effectiveSlotTimeoutMs(slotId: string): number;
	/** Bindings the manifest declares that the host did not supply, fully qualified and sorted. */
	readonly missingBindings: readonly string[];
	invokeCommand(command: ResolvedCommand, callArgs?: Record<string, unknown> | null): unknown;
	invokeCommandAsync(command: ResolvedCommand, callArgs?: Record<string, unknown> | null): Promise<unknown>;
	debugSession(): DebugSession | null;
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
	const slots = m.slots || [];
	const missingBindings = missingBindingNames(
		m.bindings as Record<string, never> | undefined,
		options.hostBindings as Record<string, unknown> | undefined,
	);
	if (options.strictBindings && missingBindings.length > 0) {
		throw new MissingBindingsError(missingBindings);
	}
	const loadedMods: ModInstance[] = [];
	const exportCapabilities = new Map<string, Map<string, string | undefined>>();
	const exportOwners = new Map<string, string[]>();
	const hookFillRegistry: HookFill[] = [];
	const reportedHookFillDenials = new Set<string>();
	const fragmentOptions = {
		formats: m.formats,
		vocabularies: m.vocabularies,
		strictHtmlVocabulary: options.strictHtmlVocabulary,
	};

	function emitFragmentDiagnostics(mod: ModInstance): ModInstance {
		if (!options.onFragmentDiagnostic) return mod;
		for (const fragment of mod.fragments) {
			for (const diagnostic of fragment.diagnostics) {
				options.onFragmentDiagnostic({ ...diagnostic, fragmentId: fragment.id });
			}
		}
		return mod;
	}

	function fragmentProfile(fragmentId: string) {
		for (const mod of loadedMods) {
			for (const fragment of mod.fragments) {
				if (fragment.id === fragmentId) return fragment.profile;
			}
		}
		return BUILTIN_PROFILES["text/html"];
	}

	function fireFragmentHookFinalized(
		fragmentId: string,
		lifecycle: string,
		bindings?: Record<string, unknown>,
	): FragmentOp[] {
		const raw = sandbox.fireFragmentHook(fragmentId, lifecycle, bindings);
		const listener = options.onFragmentDiagnostic;
		return finalizeOps(
			raw,
			fragmentProfile(fragmentId),
			listener ? (diagnostic: RuntimeDiagnostic) => listener({ ...diagnostic, fragmentId }) : undefined,
		);
	}

	function hookFillArgs(data: unknown): unknown[] {
		if (data === undefined) return [];
		if (typeof data === "object" && data !== null && !Array.isArray(data)) return Object.values(data);
		return [data];
	}

	function fireHookWithFills(hookName: string, fireOptions?: FireHookOptions): unknown[] {
		const results = sandbox.fireHook(hookName, fireOptions);
		if (fireOptions?.phase !== undefined) return results;
		for (const fill of hookFillRegistry) {
			if (fill.hook !== hookName) continue;
			const denied = deniedCapability(fill.mod, fill.handler);
			if (denied !== undefined) {
				auditHookFillDenial(fill.mod, fill.handler, hookName, denied);
				results.push(undefined);
				continue;
			}
			try {
				results.push(invokeModExport(fill.mod, fill.handler, hookFillArgs(fireOptions?.data)));
			} catch {
				results.push(undefined);
			}
		}
		return results;
	}

	function auditHookFillDenial(mod: string, handler: string, hook: string, capability: string): void {
		const audit = options.audit;
		if (!audit) return;
		const key = JSON.stringify([mod, handler, hook]);
		if (reportedHookFillDenials.has(key)) return;
		reportedHookFillDenials.add(key);
		try {
			audit({ binding: handler, capability, at: Date.now(), decision: "denied", mod, hook });
		} catch {
			// fire-and-forget: a throwing audit sink never breaks hook dispatch
		}
	}

	const sandbox = createSandbox({
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

	function declaredOwner(name: string): string | undefined {
		const owners = exportOwners.get(name);
		if (owners === undefined || owners.length === 0) return undefined;
		if (owners.length > 1) throw new AmbiguousExportError(name, owners);
		return owners[0];
	}

	function deniedCapability(mod: string, name: string): string | undefined {
		const capability = exportCapabilities.get(mod)?.get(name);
		if (capability && !grantedSatisfies(grantedCapabilities, capability)) return capability;
		return undefined;
	}

	function gateModExport(mod: string, name: string): void {
		const capability = deniedCapability(mod, name);
		if (capability !== undefined) {
			throw new CapabilityDeniedError(name, capability);
		}
	}

	function gateExport(name: string): string | undefined {
		const owner = declaredOwner(name);
		if (owner !== undefined) gateModExport(owner, name);
		return owner;
	}

	/**
	 * The effective argument object for a command call, checked where the host asked for
	 * checking. Bound arguments lose to the caller's on a conflicting key: bound values are
	 * overridable defaults, which is what makes parameterized command variants work.
	 */
	function commandArgs(command: ResolvedCommand, callArgs?: Record<string, unknown> | null): Record<string, unknown> {
		const effective = mergeCommandArgs(command.args, callArgs);
		const validate = options.validateInput;
		if (validate && command.input !== undefined) {
			const problems = validate(command.input, effective, command);
			if (Array.isArray(problems) && problems.length > 0) {
				throw new CommandInputError(command.qualifiedId, problems);
			}
		}
		return effective;
	}

	function invokeModExport(mod: string, name: string, args: unknown[], timeoutOverrideMs?: number): unknown {
		gateModExport(mod, name);
		return sandbox.invokeExport(name, args, mod, timeoutOverrideMs);
	}

	/**
	 * The timeout governing calls into a slot's fills: the slot's own
	 * `limits.timeout_ms` where it declares one, otherwise `undefined` to mean
	 * "use the manifest-wide budget".
	 */
	function slotTimeoutMs(slotId: string): number | undefined {
		return slots.find((slot) => slot.id === slotId)?.limits?.timeout_ms;
	}

	/**
	 * The deadline that governs a call into a fill of `slotId`: the slot's own
	 * `limits.timeout_ms` where it declares one, the manifest's otherwise, the
	 * schema default where neither does, clamped by the embedder's ceiling.
	 * Held to `spec/slot-limit-tests.json` by every runtime.
	 */
	function effectiveSlotTimeoutMs(slotId: string): number {
		const base = m.limits?.timeout_ms ?? DEFAULT_TIMEOUT_MS;
		const requested = slotTimeoutMs(slotId) ?? base;
		const hard = options.hardLimits?.timeout_ms;
		return hard === undefined ? requested : Math.min(requested, hard);
	}

	function registerExportCapabilities(modName: string, entry: ModManifest["entry"]): void {
		const own = exportCapabilities.get(modName) ?? new Map<string, string | undefined>();
		exportCapabilities.set(modName, own);
		for (const [exportName, decl] of Object.entries(modEntryExports(entry))) {
			own.set(exportName, decl.capability);
			const owners = exportOwners.get(exportName) ?? [];
			if (!owners.includes(modName)) owners.push(modName);
			exportOwners.set(exportName, owners);
		}
	}

	return {
		manifest: m,
		execute: sandbox.execute,
		executeAsync: sandbox.executeAsync,
		debugExecute: sandbox.debugExecute,
		debugSession: sandbox.debugSession,
		invokeExport(name: string, args: unknown[]): unknown {
			const owner = gateExport(name);
			return sandbox.invokeExport(name, args, owner);
		},
		invokeExportAsync(name: string, args: unknown[]): Promise<unknown> {
			const owner = gateExport(name);
			return sandbox.invokeExportAsync(name, args, owner);
		},
		invokeModExport,
		invokeModExportAsync(mod: string, name: string, args: unknown[]): Promise<unknown> {
			gateModExport(mod, name);
			return sandbox.invokeExportAsync(name, args, mod);
		},
		fireHook: fireHookWithFills,
		emit: sandbox.emit,
		fireFragmentHook: fireFragmentHookFinalized,

		loadMod(modManifest: unknown, modOptions?: ModLoadOptions): ModInstance {
			const { manifest: normalized, hookFills, dataFills, commandFills } = normalizeModFills(modManifest, slots, grantedCapabilities);
			const validated = validateModManifest(normalized);
			const issues = validateModAgainstApp(validated, slots, grantedCapabilities, m.formats ?? null, m.vocabularies ?? null);
			if (issues.length > 0) {
				throw new ModManifestValidationError(issues);
			}
			const sources = modOptions?.fragmentSources || {};
			const mod = createModInstance(validated, sources, { ...fragmentOptions, dataFills, commandFills });

			if (modEntryFormat(validated.entry) === "module") {
				throw new ModuleUnsupportedError(
					"module-format mods require loadModAsync (module evaluation is asynchronous)",
				);
			}

			registerExportCapabilities(validated.name, validated.entry);

			sandbox.setExportOwner(validated.name);
			try {
				for (const entryScript of modEntryScripts(validated.entry)) {
					const code = sources[entryScript];
					if (code) {
						assertNoCommonJS(code);
						sandbox.execute(code);
					}
				}
			} finally {
				sandbox.setExportOwner(null);
			}

			hookFillRegistry.push(...hookFills);
			loadedMods.push(mod);
			return emitFragmentDiagnostics(mod);
		},

		async loadModAsync(modManifest: unknown, modOptions?: ModLoadOptions): Promise<ModInstance> {
			const { manifest: normalized, hookFills, dataFills, commandFills } = normalizeModFills(modManifest, slots, grantedCapabilities);
			const validated = validateModManifest(normalized);
			const issues = validateModAgainstApp(validated, slots, grantedCapabilities, m.formats ?? null, m.vocabularies ?? null);
			if (issues.length > 0) {
				throw new ModManifestValidationError(issues);
			}
			const sources = modOptions?.fragmentSources || {};
			const mod = createModInstance(validated, sources, { ...fragmentOptions, dataFills, commandFills });
			const format = modEntryFormat(validated.entry);

			registerExportCapabilities(validated.name, validated.entry);

			sandbox.setExportOwner(validated.name);
			try {
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
			} finally {
				sandbox.setExportOwner(null);
			}

			hookFillRegistry.push(...hookFills);
			loadedMods.push(mod);
			return emitFragmentDiagnostics(mod);
		},

		resolveSlot(slotId: string): SlotContribution[] {
			return resolveSlotContributions(slotId, loadedMods, slots);
		},

		resolveSlotSingle(slotId: string): SlotContribution | null {
			const ordered = resolveSlotContributions(slotId, loadedMods, slots);
			return ordered.length > 0 ? ordered[0] : null;
		},

		resolveRole(role: string): RoleResolution | null {
			return resolveRoleImpl(role, loadedMods, options.rolePreferences);
		},

		resolveRoleAll(role: string): RoleResolution[] {
			return resolveRoleAllImpl(role, loadedMods);
		},

		resolveCommands(slotId: string): ResolvedCommand[] {
			return resolveCommandsImpl(slotId, loadedMods, slots);
		},

		resolveCommandsAll(slotId: string): ResolvedCommand[] {
			return resolveCommandsAllImpl(slotId, loadedMods);
		},

		resolveCommand(ref: string): ResolvedCommand | null {
			return resolveCommandImpl(ref, loadedMods, slots, options.commandPreferences);
		},

		effectiveSlotTimeoutMs(slotId: string): number {
			return effectiveSlotTimeoutMs(slotId);
		},

		missingBindings,

		invokeCommand(command: ResolvedCommand, callArgs?: Record<string, unknown> | null): unknown {
			return invokeModExport(
				command.mod,
				command.handler,
				[commandArgs(command, callArgs)],
				effectiveSlotTimeoutMs(command.slot),
			);
		},

		invokeCommandAsync(command: ResolvedCommand, callArgs?: Record<string, unknown> | null): Promise<unknown> {
			const effective = commandArgs(command, callArgs);
			gateModExport(command.mod, command.handler);
			return sandbox.invokeExportAsync(
				command.handler,
				[effective],
				command.mod,
				effectiveSlotTimeoutMs(command.slot),
			);
		},

		dispose() {},
	};
}

const syncFileLoader: ManifestLoader = (path: string) => JSON.parse(readFileSync(path, "utf-8"));

export async function createRuntimeFromFile(
	manifestPath: string,
	options: RuntimeOptions,
): Promise<XriptRuntime> {
	const absolutePath = resolve(manifestPath);
	const raw = await readFile(absolutePath, "utf-8");
	const manifest = JSON.parse(raw) as unknown;
	const resolved = resolveExtends(manifest, dirname(absolutePath), syncFileLoader);

	return createRuntime(resolved, options);
}
