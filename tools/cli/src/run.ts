import { initXriptAsync, type LogSeverity } from "@xriptjs/runtime";

export interface RunModInput {
	modManifest: unknown;
	source: string;
	entry?: string;
	appManifest?: unknown;
	capabilities?: string[];
	invoke?: { export: string; args?: unknown[] };
}

export interface RunModResult {
	loaded: boolean;
	logs: Array<{ severity: string; message: string }>;
	declaredExports: string[];
	fragments: string[];
	provides: string[];
	result?: unknown;
	error?: string;
}

const DEFAULT_APP_MANIFEST = { xript: "0.3", name: "mcp-run-host" };

function entryPath(modManifest: unknown, entry?: string): string {
	if (entry) return entry;
	const mod = modManifest as { entry?: { script?: string } } | null;
	return mod?.entry?.script ?? "mod.js";
}

function declaredExports(modManifest: unknown): string[] {
	const mod = modManifest as { entry?: { exports?: Record<string, unknown> } } | null;
	return Object.keys(mod?.entry?.exports ?? {});
}

export async function runMod(input: RunModInput): Promise<RunModResult> {
	const logs: Array<{ severity: string; message: string }> = [];
	const factory = await initXriptAsync();
	const runtime = await factory.createRuntime(input.appManifest ?? DEFAULT_APP_MANIFEST, {
		hostBindings: {},
		capabilities: input.capabilities ?? [],
		console: {
			onLog: (severity: LogSeverity, ...args: unknown[]) => {
				logs.push({ severity: String(severity), message: args.map(stringify).join(" ") });
			},
		},
	});

	try {
		const instance = await runtime.loadModAsync(input.modManifest, {
			fragmentSources: { [entryPath(input.modManifest, input.entry)]: input.source },
		});
		const fragments = instance.fragments.map((fragment) => fragment.id);
		const provides = instance.provides.map((role) => role.role);
		const exports = declaredExports(input.modManifest);

		if (input.invoke) {
			const result = await runtime.invokeExportAsync(input.invoke.export, input.invoke.args ?? []);
			return { loaded: true, logs, declaredExports: exports, fragments, provides, result };
		}

		return { loaded: true, logs, declaredExports: exports, fragments, provides };
	} catch (error) {
		return { loaded: false, logs, declaredExports: [], fragments: [], provides: [], error: error instanceof Error ? error.message : String(error) };
	} finally {
		runtime.dispose();
	}
}

function stringify(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}
