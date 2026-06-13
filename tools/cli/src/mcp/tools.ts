import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { validateManifest, validateModManifest, crossValidate, isModManifest, type ValidationResult } from "@xriptjs/validate";
import { generateTypes, generateAmbientTypes } from "@xriptjs/typegen";
import { generateDocs } from "@xriptjs/docgen";
import { sanitizeHTMLDetailed } from "@xriptjs/sanitize";
import { generateProjectFiles } from "@xriptjs/init";
import { loadGuidanceIndex, loadGuidanceTopic } from "../guide.js";
import { runMod } from "../run.js";
import { describeManifest } from "../describe.js";
import { scoreManifests, diffScores, type ScoreResult } from "@xriptjs/validate";
import { lintManifests, resolveProvenance, resolveExtends } from "@xriptjs/validate";
import { scanDirectory, mergeIntoManifest } from "../scan/index.js";
import { createHarnessSession, runSessionStep, type HarnessDescriptor, type HarnessStep } from "../harness.js";
import { addSession, getSession, removeSession, listSessions } from "./sessions.js";
import { isAbsolute, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

interface ToolResult {
	[key: string]: unknown;
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
}

function text(value: string, isError = false): ToolResult {
	return { content: [{ type: "text", text: value }], isError };
}

function json(value: unknown, isError = false): ToolResult {
	return text(JSON.stringify(value, null, 2), isError);
}

function parseManifest(raw: string): { ok: true; value: unknown } | { ok: false; error: string } {
	try {
		return { ok: true, value: JSON.parse(raw) };
	} catch (error) {
		return { ok: false, error: `manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
	}
}

async function resolveClientPath(server: McpServer, p: string): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
	if (isAbsolute(p)) return { ok: true, path: p };
	if (server.server.getClientCapabilities()?.roots) {
		try {
			const { roots } = await server.server.listRoots();
			const fileRoot = roots.find((root) => root.uri.startsWith("file://"));
			if (fileRoot) return { ok: true, path: resolve(fileURLToPath(fileRoot.uri), p) };
		} catch {
			// client advertised roots but did not answer — fall through to the relative-path error
		}
	}
	return {
		ok: false,
		error: `"${p}" is a relative path and the server's working directory is not your project's. Pass an absolute path, or supply a workspace root.`,
	};
}

/**
 * Accepts EITHER the inline manifest JSON or a path to a manifest file (absolute, or
 * relative to the client's workspace root). Passing a path keeps a large manifest out of
 * the tool-call tokens — the server reads it. A value that starts with `{` or `[` is treated
 * as inline JSON; anything else is treated as a path. `extends` is resolved before returning.
 */
async function resolveManifestArg(server: McpServer, value: string): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
	const trimmed = value.trimStart();
	let parsed: { ok: true; value: unknown } | { ok: false; error: string };
	let baseDir: string;
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		parsed = parseManifest(value);
		const root = await resolveClientPath(server, ".");
		baseDir = root.ok ? root.path : process.cwd();
	} else {
		const resolved = await resolveClientPath(server, value);
		if (!resolved.ok) return resolved;
		let raw: string;
		try {
			raw = await readFile(resolved.path, "utf-8");
		} catch (error) {
			return { ok: false, error: `could not read manifest at "${value}": ${error instanceof Error ? error.message : String(error)}` };
		}
		parsed = parseManifest(raw);
		baseDir = dirname(resolved.path);
	}
	if (!parsed.ok) return parsed;
	try {
		return { ok: true, value: await resolveExtends(parsed.value, baseDir) };
	} catch (error) {
		return { ok: false, error: `extends resolution failed: ${error instanceof Error ? error.message : String(error)}` };
	}
}

/**
 * Resolves a host manifest arg without pre-resolving `extends`, and reports the `baseDir`
 * that `extends` paths resolve against: the manifest file's own directory when a path was
 * passed, or the client workspace root (falling back to the server cwd) for inline JSON.
 * Callers that need provenance tracking (score, lint) call this instead of `resolveManifestArg`.
 */
async function resolveHostArg(
	server: McpServer,
	value: string,
): Promise<{ ok: true; value: unknown; baseDir: string } | { ok: false; error: string }> {
	const trimmed = value.trimStart();
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		const parsed = parseManifest(value);
		if (!parsed.ok) return parsed;
		const root = await resolveClientPath(server, ".");
		return { ok: true, value: parsed.value, baseDir: root.ok ? root.path : process.cwd() };
	}
	const resolved = await resolveClientPath(server, value);
	if (!resolved.ok) return resolved;
	let raw: string;
	try {
		raw = await readFile(resolved.path, "utf-8");
	} catch (error) {
		return { ok: false, error: `could not read manifest at "${value}": ${error instanceof Error ? error.message : String(error)}` };
	}
	const parsed = parseManifest(raw);
	if (!parsed.ok) return parsed;
	return { ok: true, value: parsed.value, baseDir: dirname(resolved.path) };
}

function formatValidation(result: ValidationResult): ToolResult {
	const lines: string[] = [result.valid ? "valid ✓" : "invalid ✗"];
	for (const error of result.errors) lines.push(`  error ${error.path}: ${error.message}`);
	for (const warning of result.warnings ?? []) lines.push(`  warning ${warning.path}: ${warning.message}`);
	return text(lines.join("\n"), !result.valid);
}

/** Path-or-inline JSON, without `extends` resolution — for non-manifest payloads like harness descriptors. */
async function resolveJsonArg(server: McpServer, value: string): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
	const trimmed = value.trimStart();
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) return parseManifest(value);
	const resolved = await resolveClientPath(server, value);
	if (!resolved.ok) return resolved;
	try {
		return parseManifest(await readFile(resolved.path, "utf-8"));
	} catch (error) {
		return { ok: false, error: `could not read "${value}": ${error instanceof Error ? error.message : String(error)}` };
	}
}

async function resolveScanDir(server: McpServer, dir: string): Promise<{ ok: true; dir: string } | { ok: false; error: string }> {
	const resolved = await resolveClientPath(server, dir);
	if (!resolved.ok) return resolved;
	return { ok: true, dir: resolved.path };
}

export interface ServerBuildInfo {
	name: string;
	version: string;
	builtAt: string;
}

export function registerTools(server: McpServer, buildInfo: ServerBuildInfo): void {
	server.registerTool(
		"xript_server_info",
		{
			title: "Report this server's build identity",
			description: "Return the running xript MCP server's name, version, and build timestamp. Use it to confirm the server process is current: if `builtAt` predates a change you made in the xript repo, the running server is stale — rebuild and reconnect before trusting its results.",
			inputSchema: {},
		},
		async () => json({ ...buildInfo, runtime: `node ${process.version}` }),
	);

	server.registerTool(
		"xript_validate",
		{
			title: "Validate a manifest",
			description: "Validate an xript app or mod manifest against the spec schema. Auto-detects app vs mod unless kind is set.",
			inputSchema: {
				manifest: z.string().describe("The manifest to validate — a file path (absolute, or relative to the workspace root), or the inline JSON."),
				kind: z.enum(["app", "mod", "auto"]).optional().describe("Manifest kind. Defaults to auto-detect."),
			},
		},
		async ({ manifest, kind }) => {
			const parsed = await resolveManifestArg(server, manifest);
			if (!parsed.ok) return text(parsed.error, true);
			const resolved = kind && kind !== "auto" ? kind : isModManifest(parsed.value) ? "mod" : "app";
			const result = resolved === "mod" ? await validateModManifest(parsed.value) : await validateManifest(parsed.value);
			return formatValidation(result);
		},
	);

	server.registerTool(
		"xript_cross_validate",
		{
			title: "Cross-validate a mod against a host",
			description: "Check that a mod's requested capabilities are grantable, its contributions match the host's declared slots, and each fill's payload conforms to the target slot's payload schema. A fill carrying more than the payload declares still passes unless the slot's payload explicitly closes itself.",
			inputSchema: {
				appManifest: z.string().describe("The host app manifest — a file path (absolute, or relative to the workspace root), or the inline JSON."),
				modManifest: z.string().describe("The mod manifest — a file path (absolute, or relative to the workspace root), or the inline JSON."),
				checkFillPayloads: z.boolean().optional().describe("Validate each fill against the target slot's payload schema. Default true; set false to check only slot existence, accepted formats, and gates."),
			},
		},
		async ({ appManifest, modManifest, checkFillPayloads }) => {
			const app = await resolveManifestArg(server, appManifest);
			if (!app.ok) return text(`app ${app.error}`, true);
			const mod = await resolveManifestArg(server, modManifest);
			if (!mod.ok) return text(`mod ${mod.error}`, true);
			return formatValidation(await crossValidate(app.value, mod.value, checkFillPayloads !== undefined ? { checkFillPayloads } : {}));
		},
	);

	server.registerTool(
		"xript_typegen",
		{
			title: "Generate TypeScript definitions",
			description: "Generate TypeScript definitions from a manifest. Set ambient to emit an ambient .d.ts declaring the xript global for mod authoring.",
			inputSchema: {
				manifest: z.string().describe("The manifest — a file path (absolute, or relative to the workspace root), or the inline JSON."),
				ambient: z.boolean().optional().describe("Emit ambient declarations for the xript global."),
			},
		},
		async ({ manifest, ambient }) => {
			const parsed = await resolveManifestArg(server, manifest);
			if (!parsed.ok) return text(parsed.error, true);
			const out = ambient ? generateAmbientTypes(parsed.value) : generateTypes(parsed.value);
			return text(out);
		},
	);

	server.registerTool(
		"xript_docgen",
		{
			title: "Generate manifest documentation",
			description: "Generate markdown documentation for an xript manifest — keeps a host's mod-facing docs current with its surface.",
			inputSchema: {
				manifest: z.string().describe("The manifest — a file path (absolute, or relative to the workspace root), or the inline JSON."),
			},
		},
		async ({ manifest }) => {
			const parsed = await resolveManifestArg(server, manifest);
			if (!parsed.ok) return text(parsed.error, true);
			const { pages } = generateDocs(parsed.value);
			const body = pages.map((page) => `<!-- ${page.slug} -->\n# ${page.title}\n\n${page.content}`).join("\n\n---\n\n");
			return text(body);
		},
	);

	server.registerTool(
		"xript_sanitize",
		{
			title: "Sanitize an HTML fragment",
			description: "Sanitize an HTML fragment for safe use in a slot, and report what was stripped.",
			inputSchema: {
				html: z.string().describe("The fragment HTML to sanitize."),
			},
		},
		async ({ html }) => json(sanitizeHTMLDetailed(html)),
	);

	server.registerTool(
		"xript_scaffold",
		{
			title: "Scaffold a project",
			description: "Generate the files for a new xript app or mod project. Returns a map of relative path to file content.",
			inputSchema: {
				name: z.string().describe("Project name."),
				type: z.enum(["app", "mod"]).describe("Whether to scaffold an app or a mod."),
				tier: z.union([z.literal(2), z.literal(3), z.literal(4)]).describe("Adoption tier (2, 3, or 4)."),
				language: z.enum(["typescript", "javascript"]).optional().describe("Defaults to typescript."),
			},
		},
		async ({ name, type, tier, language }) => json(generateProjectFiles({ name, type, tier, language: language ?? "typescript" })),
	);

	server.registerTool(
		"xript_scan",
		{
			title: "Scan annotated source into bindings",
			description: "Read @xript annotations from TypeScript source in a directory and produce manifest bindings and capabilities. Optionally merge into an existing manifest. Pass an absolute directory path; a relative path is resolved against the client's workspace root if one is provided.",
			inputSchema: {
				dir: z.string().describe("Directory of TypeScript source to scan. Absolute, or relative to the client's workspace root."),
				manifest: z.string().optional().describe("Existing manifest to merge the scan result into — a file path or the inline JSON."),
			},
		},
		async ({ dir, manifest }) => {
			const resolved = await resolveScanDir(server, dir);
			if (!resolved.ok) return text(resolved.error, true);
			try {
				const scanned = await scanDirectory(resolved.dir);
				if (manifest) {
					const parsed = await resolveManifestArg(server, manifest);
					if (!parsed.ok) return text(parsed.error, true);
					const merged = await mergeIntoManifest(parsed.value, scanned);
					return json(merged);
				}
				return json(scanned);
			} catch (error) {
				return text(error instanceof Error ? error.message : String(error), true);
			}
		},
	);

	server.registerTool(
		"xript_manifest_describe",
		{
			title: "Describe a host's surface",
			description: "Given a host manifest, summarize exactly what it exposes — bindings, hooks, slots, capabilities — so a mod author knows what they can call and contribute into.",
			inputSchema: {
				manifest: z.string().describe("The host app manifest — a file path (absolute, or relative to the workspace root), or the inline JSON."),
			},
		},
		async ({ manifest }) => {
			const parsed = await resolveManifestArg(server, manifest);
			if (!parsed.ok) return text(parsed.error, true);
			const { summary, docs } = describeManifest(parsed.value);
			return text(`## Surface summary\n\n${JSON.stringify(summary, null, 2)}\n\n## Documentation\n\n${docs}`);
		},
	);

	server.registerTool(
		"xript_run",
		{
			title: "Run a mod in the sandbox",
			description: "Load a mod into the QuickJS WASM sandbox and optionally invoke an export. Returns logs, the result, and what the mod loaded.",
			inputSchema: {
				modManifest: z.string().describe("The mod manifest — a file path (absolute, or relative to the workspace root), or the inline JSON."),
				source: z.string().describe("The entry script source."),
				entry: z.string().optional().describe("Entry path key; defaults to the manifest's entry.script or mod.js."),
				appManifest: z.string().optional().describe("Optional host app manifest (a file path or the inline JSON); a minimal host is used if omitted."),
				capabilities: z.array(z.string()).optional().describe("Capabilities granted to the mod."),
				invokeExport: z.string().optional().describe("Name of an export to invoke after loading."),
				invokeArgs: z.string().optional().describe("JSON array of arguments for the invoked export."),
			},
		},
		async ({ modManifest, source, entry, appManifest, capabilities, invokeExport, invokeArgs }) => {
			const mod = await resolveManifestArg(server, modManifest);
			if (!mod.ok) return text(`mod ${mod.error}`, true);
			let app: unknown;
			if (appManifest) {
				const parsedApp = await resolveManifestArg(server, appManifest);
				if (!parsedApp.ok) return text(`app ${parsedApp.error}`, true);
				app = parsedApp.value;
			}
			let args: unknown[] | undefined;
			if (invokeArgs) {
				try {
					const parsedArgs = JSON.parse(invokeArgs);
					if (!Array.isArray(parsedArgs)) return text("invokeArgs must be a JSON array", true);
					args = parsedArgs;
				} catch (error) {
					return text(`invokeArgs is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, true);
				}
			}
			const result = await runMod({
				modManifest: mod.value,
				source,
				entry,
				appManifest: app,
				capabilities,
				invoke: invokeExport ? { export: invokeExport, args } : undefined,
			});
			return json(result, !result.loaded);
		},
	);

	server.registerTool(
		"xript_score",
		{
			title: "Score a host's moddability",
			description: "Report contract integrity and moddability capacity — how much of xript's extension surface (bindings, slots, events, a capability model) the host exposes, against a ceiling of exposing all of it. `extends` is resolved first, so inherited canon surface counts toward capacity and never drags it down. Mod coverage (how much the supplied mods fill) is reported as informational context only — exposing a slot no mod fills is moddability, not waste. Integrity violations are real bugs.",
			inputSchema: {
				host: z.string().describe("The host app manifest — a file path (absolute, or relative to the workspace root), or the inline JSON."),
				mods: z.array(z.string()).optional().describe("Mod manifests to read informational coverage against — each a file path (absolute or workspace-relative) or inline JSON."),
				min: z.number().optional().describe("Gate threshold; the result's gate fails below this headline or on any integrity violation."),
			},
		},
		async ({ host, mods, min }) => {
			const parsedHost = await resolveHostArg(server, host);
			if (!parsedHost.ok) return text(`host ${parsedHost.error}`, true);
			const parsedMods: unknown[] = [];
			for (const [index, raw] of (mods ?? []).entries()) {
				const parsed = await resolveManifestArg(server, raw);
				if (!parsed.ok) return text(`mod[${index}] ${parsed.error}`, true);
				parsedMods.push(parsed.value);
			}
			const { resolved, inheritedSlots, inheritedCapabilities } = await resolveProvenance(parsedHost.value, parsedHost.baseDir);
			const result = await scoreManifests(resolved, parsedMods, { ...(min !== undefined ? { min } : {}), inheritedSlots, inheritedCapabilities });
			return json(result, result.gate ? !result.gate.passed : !result.integrity.passed);
		},
	);

	server.registerTool(
		"xript_score_diff",
		{
			title: "Diff a host's extensibility against a baseline",
			description: "Compute the current extensibility score and diff it against a saved baseline (a prior xript_score result), reporting whether the surface moved toward or away from xript — headline delta, newly-filled/dead slots, newly-used/vestigial capabilities, and introduced/fixed integrity violations.",
			inputSchema: {
				baseline: z.string().describe("A saved score result to compare against — a file path, or the inline JSON of a prior xript_score result."),
				host: z.string().describe("The current host app manifest — a file path (absolute, or relative to the workspace root), or the inline JSON."),
				mods: z.array(z.string()).optional().describe("Current mod manifests — each a file path (absolute or workspace-relative) or inline JSON."),
				minDelta: z.number().optional().describe("Gate: the result's gate fails if the headline fell by more than this, or any new integrity violation appeared."),
			},
		},
		async ({ baseline, host, mods, minDelta }) => {
			const parsedBaseline = await resolveManifestArg(server, baseline);
			if (!parsedBaseline.ok) return text(`baseline ${parsedBaseline.error}`, true);
			const parsedHost = await resolveHostArg(server, host);
			if (!parsedHost.ok) return text(`host ${parsedHost.error}`, true);
			const parsedMods: unknown[] = [];
			for (const [index, raw] of (mods ?? []).entries()) {
				const parsed = await resolveManifestArg(server, raw);
				if (!parsed.ok) return text(`mod[${index}] ${parsed.error}`, true);
				parsedMods.push(parsed.value);
			}
			const { resolved, inheritedSlots, inheritedCapabilities } = await resolveProvenance(parsedHost.value, parsedHost.baseDir);
			const current = await scoreManifests(resolved, parsedMods, { inheritedSlots, inheritedCapabilities });
			const diff = diffScores(parsedBaseline.value as ScoreResult, current, minDelta !== undefined ? { minDelta } : {});
			return json(diff, diff.gate ? !diff.gate.passed : false);
		},
	);

	server.registerTool(
		"xript_lint",
		{
			title: "Lint a host/mod fit",
			description: "Review a host manifest against its mods and emit actionable findings — filled-but-undeclared slots, undeclared and vestigial capabilities, dead and ungated slots, and missing descriptions. The findings complement to xript_score.",
			inputSchema: {
				host: z.string().describe("The host app manifest — a file path (absolute, or relative to the workspace root), or the inline JSON."),
				mods: z.array(z.string()).optional().describe("Mod manifests to lint the host's surface against — each a file path (absolute or workspace-relative) or inline JSON."),
				strict: z.boolean().optional().describe("Treat any warning as a failure, not just errors."),
			},
		},
		async ({ host, mods, strict }) => {
			const parsedHost = await resolveHostArg(server, host);
			if (!parsedHost.ok) return text(`host ${parsedHost.error}`, true);
			const parsedMods: unknown[] = [];
			for (const [index, raw] of (mods ?? []).entries()) {
				const parsed = await resolveManifestArg(server, raw);
				if (!parsed.ok) return text(`mod[${index}] ${parsed.error}`, true);
				parsedMods.push(parsed.value);
			}
			const { resolved, inheritedSlots, inheritedCapabilities, inheritedAbstractTypes } = await resolveProvenance(parsedHost.value, parsedHost.baseDir);
			const result = lintManifests(resolved, parsedMods, { ...(strict !== undefined ? { strict } : {}), inheritedSlots, inheritedCapabilities, inheritedAbstractTypes });
			const failed = result.counts.error > 0 || (strict === true && result.counts.warn > 0);
			return json(result, failed);
		},
	);

	server.registerTool(
		"xript_host_load",
		{
			title: "Load a harnessed host session",
			description: "Create a persistent harnessed host session from a host manifest: declared bindings are stubbed from the harness descriptor (spec/harness.schema.json), every binding call is journaled, and the session survives across tool calls so mods can be loaded, invoked, and sent events interactively. Returns a hostId for xript_host_step / xript_host_journal / xript_host_unload. The same descriptor and step vocabulary run batch-style via `xript run --harness --steps`.",
			inputSchema: {
				manifest: z.string().describe("The host app manifest — a file path (absolute, or relative to the workspace root), or the inline JSON. `extends` is resolved."),
				harness: z.string().optional().describe("Harness descriptor — a file path or inline JSON: binding stubs (returns/throws/sequence/script/record) keyed by binding name, capability grants, and sources for the host's approved libraries (inline `source`, or `path` relative to the harness file). Omitted: every declared binding records and returns undefined."),
				capabilities: z.array(z.string()).optional().describe("Capability grants for the session, overriding the descriptor. Default: every capability scope the host declares, granted in full."),
			},
		},
		async ({ manifest, harness, capabilities }) => {
			const parsed = await resolveManifestArg(server, manifest);
			if (!parsed.ok) return text(`host ${parsed.error}`, true);
			let descriptor: HarnessDescriptor = {};
			let harnessBaseDir: string | undefined;
			if (harness) {
				if (!harness.trimStart().startsWith("{")) {
					const path = await resolveClientPath(server, harness);
					if (path.ok) harnessBaseDir = dirname(path.path);
				}
				const parsedHarness = await resolveJsonArg(server, harness);
				if (!parsedHarness.ok) return text(`harness ${parsedHarness.error}`, true);
				descriptor = parsedHarness.value as HarnessDescriptor;
			}
			if (capabilities) descriptor = { ...descriptor, capabilities };
			try {
				const session = await createHarnessSession({ appManifest: parsed.value, harness: descriptor, baseDir: harnessBaseDir });
				const record = addSession(session);
				return json({ hostId: record.id, summary: session.summary });
			} catch (error) {
				return text(error instanceof Error ? error.message : String(error), true);
			}
		},
	);

	server.registerTool(
		"xript_host_step",
		{
			title: "Run one step against a harnessed host",
			description: "Execute a single step against a session created by xript_host_load — load a mod, invoke an export, emit a host event, fire a hook or event-typed slot, execute code in the sandbox, or resolve a slot/role. The step vocabulary matches spec/harness-steps.schema.json, so an interactive session transcribes directly to a replayable steps file.",
			inputSchema: {
				hostId: z.string().describe("The session id from xript_host_load."),
				action: z.enum(["load-mod", "invoke", "emit", "fire-hook", "execute", "resolve-slot", "resolve-role"]).describe("The step to run."),
				manifest: z.string().optional().describe("load-mod: the mod manifest — a file path or the inline JSON."),
				source: z.string().optional().describe("load-mod: the entry script source text."),
				sourcePath: z.string().optional().describe("load-mod: path to the entry script, read server-side."),
				sources: z.record(z.string(), z.string()).optional().describe("load-mod: additional fragment/script sources the mod's fills reference, keyed by the path the manifest names — each value is INLINE CONTENT (not a path)."),
				entry: z.string().optional().describe("load-mod: entry path key; defaults to the manifest's entry.script."),
				exportName: z.string().optional().describe("invoke: the export to call."),
				args: z.array(z.unknown()).optional().describe("invoke: positional arguments."),
				event: z.string().optional().describe("emit: the host event id."),
				payload: z.unknown().optional().describe("emit: the event payload."),
				hook: z.string().optional().describe("fire-hook: the hook or event-typed slot id."),
				phase: z.string().optional().describe("fire-hook: the hook phase to fire."),
				data: z.unknown().optional().describe("fire-hook: the data passed to hook handlers."),
				code: z.string().optional().describe("execute: script source evaluated in the sandbox."),
				slot: z.string().optional().describe("resolve-slot: the slot id."),
				role: z.string().optional().describe("resolve-role: the provider role."),
			},
		},
		async ({ hostId, action, manifest, source, sourcePath, sources, entry, exportName, args, event, payload, hook, phase, data, code, slot, role }) => {
			const record = getSession(hostId);
			if (!record) return text(`no session "${hostId}" — load a host with xript_host_load first`, true);
			try {
				if (action === "load-mod") {
					if (!manifest) return text("load-mod requires a manifest", true);
					const mod = await resolveManifestArg(server, manifest);
					if (!mod.ok) return text(`mod ${mod.error}`, true);
					let resolvedSource = source;
					if (resolvedSource === undefined && sourcePath) {
						const path = await resolveClientPath(server, sourcePath);
						if (!path.ok) return text(path.error, true);
						resolvedSource = await readFile(path.path, "utf-8");
					}
					if (resolvedSource === undefined) return text("load-mod requires source or sourcePath", true);
					return json(await record.session.loadMod(mod.value, resolvedSource, { entry, sources }));
				}
				const step: HarnessStep = { action, export: exportName, args, event, payload, hook, phase, data, code, slot, role };
				return json(await runSessionStep(record.session, step));
			} catch (error) {
				return text(error instanceof Error ? error.message : String(error), true);
			}
		},
	);

	server.registerTool(
		"xript_host_journal",
		{
			title: "Read a harnessed host's journal",
			description: "Return the session's journal in order: every stubbed binding call (name, arguments, outcome), every capability audit event, and every sandbox console log. This is the assertion surface for a harnessed scenario.",
			inputSchema: {
				hostId: z.string().describe("The session id from xript_host_load."),
				clear: z.boolean().optional().describe("Reset the journal after reading it."),
			},
		},
		async ({ hostId, clear }) => {
			const record = getSession(hostId);
			if (!record) return text(`no session "${hostId}" — load a host with xript_host_load first`, true);
			return json(record.session.journal(clear));
		},
	);

	server.registerTool(
		"xript_host_list",
		{
			title: "List harnessed host sessions",
			description: "List the live harnessed host sessions held by this server process.",
			inputSchema: {},
		},
		async () => json(listSessions()),
	);

	server.registerTool(
		"xript_host_unload",
		{
			title: "Unload a harnessed host session",
			description: "Dispose a session created by xript_host_load and free its sandbox.",
			inputSchema: {
				hostId: z.string().describe("The session id to dispose."),
			},
		},
		async ({ hostId }) => {
			if (!removeSession(hostId)) return text(`no session "${hostId}"`, true);
			return text(`unloaded ${hostId}`);
		},
	);

	server.registerTool(
		"xript_guide",
		{
			title: "Read xript authoring doctrine",
			description: "Get canonical xript guidance on when to use xript, how to choose a surface, mod-zero, authoring, and adoption tiers. Omit topic to list available topics.",
			inputSchema: {
				topic: z.string().optional().describe("Topic id, e.g. when-to-use, surfaces, mod-zero, authoring, tiers."),
			},
		},
		async ({ topic }) => {
			const topics = await loadGuidanceIndex();
			if (!topic) {
				const list = topics.map((entry) => `- ${entry.id} — ${entry.title}: ${entry.summary}`).join("\n");
				return text(`Available topics:\n\n${list}`);
			}
			const loaded = await loadGuidanceTopic(topic);
			if (!loaded) {
				const ids = topics.map((entry) => entry.id).join(", ");
				return text(`Unknown topic "${topic}". Available: ${ids}`, true);
			}
			return text(loaded.body);
		},
	);
}
