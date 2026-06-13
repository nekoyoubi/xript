import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { initXriptAsync, type LogSeverity } from "@xriptjs/runtime";

export interface BindingStub {
	mode?: "record";
	returns?: unknown;
	throws?: string;
	sequence?: Array<{ returns?: unknown; throws?: string }>;
	script?: string;
}

export interface HarnessDescriptor {
	capabilities?: string[];
	bindings?: Record<string, BindingStub>;
	libraries?: Record<string, LibrarySource>;
}

export interface LibrarySource {
	source?: string;
	path?: string;
}

export interface JournalEntry {
	seq: number;
	kind: "binding" | "audit" | "log";
	binding?: string;
	args?: unknown[];
	returned?: unknown;
	threw?: string;
	capability?: string | null;
	severity?: string;
	message?: string;
}

export interface HarnessSummary {
	host: string;
	bindings: Array<{ name: string; stub: string }>;
	capabilities: string[];
	events: string[];
	slots: string[];
	hooks: string[];
	libraries: Array<{ specifier: string; registered: boolean }>;
}

export interface ModLoadSummary {
	name: string;
	fragments: string[];
	provides: string[];
	declaredExports: string[];
}

export interface StepResult {
	action: string;
	ok: boolean;
	result?: unknown;
	error?: string;
}

export interface HarnessStep {
	action: "load-mod" | "invoke" | "emit" | "fire-hook" | "execute" | "resolve-slot" | "resolve-role" | "journal";
	manifest?: unknown;
	source?: string;
	sourceText?: string;
	sources?: Record<string, string>;
	entry?: string;
	export?: string;
	args?: unknown[];
	event?: string;
	payload?: unknown;
	hook?: string;
	phase?: string;
	data?: unknown;
	code?: string;
	slot?: string;
	role?: string;
	clear?: boolean;
}

export interface HarnessSession {
	readonly summary: HarnessSummary;
	loadMod(modManifest: unknown, source: string, options?: { entry?: string; sources?: Record<string, string> }): Promise<ModLoadSummary>;
	invoke(name: string, args?: unknown[]): Promise<unknown>;
	emit(eventId: string, payload?: unknown): unknown[];
	fireHook(hookName: string, options?: { phase?: string; data?: unknown }): unknown[];
	execute(code: string): Promise<unknown>;
	resolveSlot(slotId: string): unknown;
	resolveRole(role: string): unknown;
	journal(clear?: boolean): JournalEntry[];
	dispose(): void;
}

interface ManifestShape {
	name?: string;
	bindings?: Record<string, BindingDecl>;
	hooks?: Record<string, unknown>;
	slots?: Array<{ id: string; accepts?: string[] }>;
	capabilities?: Record<string, unknown>;
	events?: Array<{ id: string }>;
	libraries?: Record<string, unknown>;
}

interface BindingDecl {
	members?: Record<string, BindingDecl>;
}

function flattenBindingNames(bindings: Record<string, BindingDecl> | undefined, prefix = ""): string[] {
	const names: string[] = [];
	for (const [key, decl] of Object.entries(bindings ?? {})) {
		const full = prefix ? `${prefix}.${key}` : key;
		if (decl && typeof decl === "object" && "members" in decl && decl.members) {
			names.push(...flattenBindingNames(decl.members, full));
		} else {
			names.push(full);
		}
	}
	return names;
}

function stubKind(stub: BindingStub): string {
	if (stub.script !== undefined) return "script";
	if (stub.sequence !== undefined) return "sequence";
	if (stub.throws !== undefined) return "throws";
	if (stub.returns !== undefined) return "returns";
	return "record";
}

type ScriptFn = (args: unknown[], calls: number) => unknown;

function compileStubScript(name: string, body: string): ScriptFn {
	try {
		return new Function("args", "calls", body) as ScriptFn;
	} catch (error) {
		throw new Error(`harness stub script for "${name}" failed to compile: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function makeStubFn(name: string, stub: BindingStub, journal: JournalEntry[], nextSeq: () => number): (...args: unknown[]) => unknown {
	let calls = 0;
	const scriptFn = stub.script !== undefined ? compileStubScript(name, stub.script) : null;
	return (...args: unknown[]) => {
		const callIndex = calls++;
		try {
			let value: unknown;
			if (scriptFn) {
				value = scriptFn(args, callIndex);
			} else if (stub.sequence) {
				const entry = stub.sequence[Math.min(callIndex, stub.sequence.length - 1)];
				if (entry?.throws !== undefined) throw new Error(entry.throws);
				value = entry?.returns;
			} else if (stub.throws !== undefined) {
				throw new Error(stub.throws);
			} else {
				value = stub.returns;
			}
			journal.push({ seq: nextSeq(), kind: "binding", binding: name, args, returned: value });
			return value;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			journal.push({ seq: nextSeq(), kind: "binding", binding: name, args, threw: message });
			throw error;
		}
	};
}

interface HostNamespaceShape {
	[key: string]: ((...args: unknown[]) => unknown) | HostNamespaceShape;
}

function buildStubBindings(
	declared: Record<string, BindingDecl> | undefined,
	harness: HarnessDescriptor,
	journal: JournalEntry[],
	nextSeq: () => number,
	prefix = "",
): Record<string, ((...args: unknown[]) => unknown) | HostNamespaceShape> {
	const out: Record<string, ((...args: unknown[]) => unknown) | HostNamespaceShape> = {};
	for (const [key, decl] of Object.entries(declared ?? {})) {
		const full = prefix ? `${prefix}.${key}` : key;
		if (decl && typeof decl === "object" && "members" in decl && decl.members) {
			out[key] = buildStubBindings(decl.members, harness, journal, nextSeq, full) as HostNamespaceShape;
		} else {
			const stub = harness.bindings?.[full] ?? harness.bindings?.["*"] ?? {};
			out[key] = makeStubFn(full, stub, journal, nextSeq);
		}
	}
	return out;
}

function entryPath(modManifest: unknown, entry?: string): string {
	if (entry) return entry;
	const mod = modManifest as { entry?: { script?: string } } | null;
	return mod?.entry?.script ?? "mod.js";
}

function declaredExports(modManifest: unknown): string[] {
	const mod = modManifest as { entry?: { exports?: Record<string, unknown> } } | null;
	return Object.keys(mod?.entry?.exports ?? {});
}

async function resolveLibrarySources(
	libraries: Record<string, LibrarySource> | undefined,
	baseDir?: string,
): Promise<Record<string, string> | undefined> {
	if (!libraries) return undefined;
	const resolved: Record<string, string> = {};
	for (const [specifier, entry] of Object.entries(libraries)) {
		if (entry.source !== undefined) {
			resolved[specifier] = entry.source;
		} else if (entry.path !== undefined) {
			resolved[specifier] = await readFile(resolveAgainst(entry.path, baseDir), "utf-8");
		} else {
			throw new Error(`harness library "${specifier}" must declare source or path`);
		}
	}
	return resolved;
}

export async function createHarnessSession(input: { appManifest: unknown; harness?: HarnessDescriptor; baseDir?: string }): Promise<HarnessSession> {
	const harness = input.harness ?? {};
	const manifest = input.appManifest as ManifestShape;
	const journal: JournalEntry[] = [];
	let seq = 0;
	const nextSeq = () => seq++;

	const grantedCapabilities = harness.capabilities ?? Object.keys(manifest.capabilities ?? {});
	const hostBindings = buildStubBindings(manifest.bindings, harness, journal, nextSeq);
	const libraries = await resolveLibrarySources(harness.libraries, input.baseDir);

	const factory = await initXriptAsync();
	const runtime = await factory.createRuntime(input.appManifest, {
		hostBindings: hostBindings as never,
		capabilities: grantedCapabilities,
		libraries,
		console: {
			onLog: (severity: LogSeverity, ...args: unknown[]) => {
				journal.push({ seq: nextSeq(), kind: "log", severity: String(severity), message: args.map(stringify).join(" ") });
			},
		},
		audit: (event) => {
			journal.push({ seq: nextSeq(), kind: "audit", binding: event.binding, capability: event.capability });
		},
	});

	const bindingNames = flattenBindingNames(manifest.bindings);
	const summary: HarnessSummary = {
		host: manifest.name ?? "unnamed-host",
		bindings: bindingNames.map((name) => ({ name, stub: stubKind(harness.bindings?.[name] ?? harness.bindings?.["*"] ?? {}) })),
		capabilities: grantedCapabilities,
		events: (manifest.events ?? []).map((event) => event.id),
		slots: (manifest.slots ?? []).map((slot) => slot.id),
		hooks: Object.keys(manifest.hooks ?? {}),
		libraries: Object.keys(manifest.libraries ?? {}).map((specifier) => ({
			specifier,
			registered: libraries?.[specifier] !== undefined,
		})),
	};

	return {
		summary,
		async loadMod(modManifest, source, options) {
			const instance = await runtime.loadModAsync(modManifest, {
				fragmentSources: { ...options?.sources, [entryPath(modManifest, options?.entry)]: source },
			});
			const mod = modManifest as { name?: string } | null;
			return {
				name: mod?.name ?? "unnamed-mod",
				fragments: instance.fragments.map((fragment) => fragment.id),
				provides: instance.provides.map((role) => role.role),
				declaredExports: declaredExports(modManifest),
			};
		},
		invoke(name, args) {
			return runtime.invokeExportAsync(name, args ?? []);
		},
		emit(eventId, payload) {
			return runtime.emit(eventId, payload);
		},
		fireHook(hookName, options) {
			return runtime.fireHook(hookName, options);
		},
		async execute(code) {
			const result = await runtime.executeAsync(code);
			return result.value;
		},
		resolveSlot(slotId) {
			return runtime.resolveSlot(slotId);
		},
		resolveRole(role) {
			return runtime.resolveRoleAll(role);
		},
		journal(clear) {
			const entries = [...journal];
			if (clear) journal.length = 0;
			return entries;
		},
		dispose() {
			runtime.dispose();
		},
	};
}

export async function runSteps(session: HarnessSession, steps: HarnessStep[], options: { baseDir?: string } = {}): Promise<StepResult[]> {
	const results: StepResult[] = [];
	for (const step of steps) {
		try {
			results.push({ action: step.action, ok: true, result: await runSessionStep(session, step, options.baseDir) });
		} catch (error) {
			results.push({ action: step.action, ok: false, error: error instanceof Error ? error.message : String(error) });
		}
	}
	return results;
}

export async function runSessionStep(session: HarnessSession, step: HarnessStep, baseDir?: string): Promise<unknown> {
	switch (step.action) {
		case "load-mod": {
			const manifest = typeof step.manifest === "string" ? JSON.parse(await readFile(resolveAgainst(step.manifest, baseDir), "utf-8")) : step.manifest;
			if (manifest === undefined) throw new Error("load-mod requires a manifest");
			const source = step.sourceText ?? (step.source ? await readFile(resolveAgainst(step.source, baseDir), "utf-8") : undefined);
			if (source === undefined) throw new Error("load-mod requires source or sourceText");
			const sources: Record<string, string> = {};
			for (const [key, path] of Object.entries(step.sources ?? {})) {
				sources[key] = await readFile(resolveAgainst(path, baseDir), "utf-8");
			}
			return session.loadMod(manifest, source, { entry: step.entry, sources });
		}
		case "invoke":
			if (!step.export) throw new Error("invoke requires an export name");
			return session.invoke(step.export, step.args);
		case "emit":
			if (!step.event) throw new Error("emit requires an event id");
			return session.emit(step.event, step.payload);
		case "fire-hook":
			if (!step.hook) throw new Error("fire-hook requires a hook id");
			return session.fireHook(step.hook, step.phase !== undefined || step.data !== undefined ? { phase: step.phase, data: step.data } : undefined);
		case "execute":
			if (step.code === undefined) throw new Error("execute requires code");
			return session.execute(step.code);
		case "resolve-slot":
			if (!step.slot) throw new Error("resolve-slot requires a slot id");
			return session.resolveSlot(step.slot);
		case "resolve-role":
			if (!step.role) throw new Error("resolve-role requires a role");
			return session.resolveRole(step.role);
		case "journal":
			return session.journal(step.clear);
		default:
			throw new Error(`unknown step action "${(step as { action: string }).action}"`);
	}
}

function resolveAgainst(path: string, baseDir?: string): string {
	return baseDir ? resolve(baseDir, path) : resolve(path);
}

export async function loadStepsFile(path: string): Promise<{ steps: HarnessStep[]; baseDir: string }> {
	const absolute = resolve(path);
	const parsed = JSON.parse(await readFile(absolute, "utf-8")) as { steps?: HarnessStep[] };
	if (!Array.isArray(parsed.steps)) throw new Error(`steps file "${path}" must contain a "steps" array`);
	return { steps: parsed.steps, baseDir: dirname(absolute) };
}

function stringify(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}
