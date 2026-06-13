export interface ProjectFiles {
	[relativePath: string]: string;
}

export interface TemplateOptions {
	name: string;
	tier: 2 | 3 | 4;
	language: "typescript" | "javascript";
	type?: "app" | "mod";
}

export function generateProjectFiles(options: TemplateOptions): ProjectFiles {
	if (options.type === "mod") {
		return generateModProjectFiles(options);
	}

	const files: ProjectFiles = {};

	files["manifest.json"] = generateManifest(options);
	files["package.json"] = generatePackageJson(options);

	const ext = options.language === "typescript" ? "ts" : "js";

	if (options.tier === 2) {
		files[`src/host.${ext}`] = generateTier2Host(options);
		files[`src/demo.${ext}`] = generateTier2Demo(options);
	} else if (options.tier === 3) {
		files[`src/host.${ext}`] = generateTier3Host(options);
		files[`src/demo.${ext}`] = generateTier3Demo(options);
	} else {
		files[`src/host.${ext}`] = generateTier3Host(options);
		files[`src/demo.${ext}`] = generateTier4Demo(options);
		files["mod-manifest.json"] = generateTier4ModManifest(options);
		files["fragments/panel.html"] = generateModFragmentHtml();
	}

	if (options.language === "typescript") {
		files["tsconfig.json"] = generateTsConfig();
	}

	return files;
}

export function generateModProjectFiles(options: TemplateOptions): ProjectFiles {
	const files: ProjectFiles = {};
	const ext = options.language === "typescript" ? "ts" : "js";

	files["mod-manifest.json"] = generateModManifest(options);
	files["package.json"] = generateModPackageJson(options);
	files[`src/mod.${ext}`] = generateModEntryScript(options);
	files["fragments/panel.html"] = generateModFragmentHtml();
	files["demo/host-manifest.json"] = generateModDemoHostManifest(options);
	files["demo/steps.json"] = generateModDemoSteps(options);

	if (options.language === "typescript") {
		files["tsconfig.json"] = generateModTsConfig();
		files["src/xript-env.d.ts"] = generateModAmbientTypes(options);
	}

	return files;
}

function generateManifest(options: TemplateOptions): string {
	const manifest: Record<string, unknown> = {
		$schema: "https://xript.dev/schema/manifest/v0.7.json",
		xript: "0.7",
		name: options.name,
		version: "0.1.0",
		title: titleCase(options.name),
		description: `A xript-powered application.`,
	};

	manifest.bindings = {
		log: {
			description: "Writes a message to the console.",
			params: [{ name: "message", type: "string", description: "The message to log." }],
		},
		greet: {
			description: "Returns a greeting for the given name.",
			params: [{ name: "name", type: "string", description: "The name to greet." }],
			returns: "string",
		},
	};

	if (options.tier >= 3) {
		manifest.bindings = {
			...manifest.bindings as Record<string, unknown>,
			counter: {
				description: "A simple counter.",
				members: {
					get: { description: "Returns the current count.", returns: "number" },
					increment: {
						description: "Increments the counter by the given amount.",
						params: [{ name: "amount", type: "number", default: 1 }],
						returns: "number",
						capability: "modify-state",
					},
					reset: {
						description: "Resets the counter to zero.",
						returns: "number",
						capability: "modify-state",
					},
				},
			},
		};

		manifest.slots = [
			{
				id: "onStart",
				accepts: ["application/x-xript-hook"],
				description: "Fired when a script begins execution.",
			},
		];

		manifest.capabilities = {
			"modify-state": {
				description: "Modify application state.",
				risk: "medium",
			},
		};
	}

	if (options.tier === 4) {
		manifest.slots = [
			...(manifest.slots as unknown[]),
			{
				id: "sidebar.left",
				accepts: ["text/html"],
				multiple: true,
				capability: "ui-mount",
				description: "Left sidebar panel for mod-contributed UI.",
			},
		];

		manifest.capabilities = {
			...manifest.capabilities as Record<string, unknown>,
			"ui-mount": {
				description: "Mount a UI fragment into a declared slot.",
				risk: "low",
			},
		};
	}

	manifest.limits = {
		timeout_ms: 1000,
		memory_mb: 16,
		max_stack_depth: 128,
	};

	return JSON.stringify(manifest, null, "\t") + "\n";
}

function generatePackageJson(options: TemplateOptions): string {
	const pkg: Record<string, unknown> = {
		name: options.name,
		version: "0.1.0",
		private: true,
		type: "module",
		description: `A xript-powered application.`,
	};

	const ext = options.language === "typescript" ? "ts" : "js";
	const runPrefix = options.language === "typescript" ? "npx tsx " : "node ";

	pkg.scripts = {
		demo: `${runPrefix}src/demo.${ext}`,
	};

	pkg.dependencies = {
		"@xriptjs/runtime": "^0.7.0",
	};

	if (options.language === "typescript") {
		pkg.devDependencies = {
			tsx: "^4.0.0",
			typescript: "^5.0.0",
		};
	}

	return JSON.stringify(pkg, null, "\t") + "\n";
}

function generateTsConfig(): string {
	return JSON.stringify(
		{
			compilerOptions: {
				target: "ES2022",
				module: "Node16",
				moduleResolution: "Node16",
				outDir: "./dist",
				rootDir: "./src",
				strict: true,
				esModuleInterop: true,
				skipLibCheck: true,
				forceConsistentCasingInFileNames: true,
				resolveJsonModule: true,
			},
			include: ["src/**/*"],
		},
		null,
		"\t",
	) + "\n";
}

function generateModTsConfig(): string {
	return JSON.stringify(
		{
			compilerOptions: {
				target: "ES2022",
				module: "ESNext",
				moduleResolution: "Bundler",
				outDir: "./dist",
				rootDir: "./src",
				strict: true,
				skipLibCheck: true,
				forceConsistentCasingInFileNames: true,
				types: [],
			},
			include: ["src/**/*"],
		},
		null,
		"\t",
	) + "\n";
}

function generateModAmbientTypes(options: TemplateOptions): string {
	const exportName = exampleExportName(options.name);
	return [
		"// Hand-authored stub mirroring `npx xript typegen --ambient`.",
		"// Regenerate from the real host + mod manifests with:",
		"//   npx xript typegen --ambient mod-manifest.json -o src/xript-env.d.ts",
		"// Declares the in-sandbox surface a mod author sees. Do not edit manually.",
		"",
		"declare global {",
		"\t/**",
		"\t * Writes a message to the host console.",
		"\t */",
		"\tfunction log(message: string): void;",
		"",
		"\t/**",
		"\t * Hook registration functions.",
		"\t */",
		"\tnamespace hooks {",
		"\t\t/**",
		"\t\t * Fragment lifecycle hook registration.",
		"\t\t */",
		"\t\tnamespace fragment {",
		"\t\t\tfunction update(fragmentId: string, handler: (bindings: Record<string, unknown>) => void): void;",
		"\t\t}",
		"\t}",
		"",
		"\t/**",
		"\t * Catalog of the named events the host emits, mapping event id to payload type.",
		"\t * Replace these placeholders with the host's real `events` catalog.",
		"\t */",
		"\tinterface XriptEvents {",
		"\t\t/** Fired when the host's status changes. */",
		"\t\t\"app.status-changed\": string;",
		"\t}",
		"",
		"\t/**",
		"\t * An event id the host emits.",
		"\t */",
		"\ttype XriptEventId = keyof XriptEvents;",
		"",
		"\t/**",
		"\t * The in-sandbox `events` global. Subscribe to a declared host event by id;",
		"\t * the handler receives that event's declared payload.",
		"\t */",
		"\tnamespace events {",
		"\t\tfunction on<K extends XriptEventId>(id: K, handler: (payload: XriptEvents[K]) => void): void;",
		"\t\tfunction subscribe<K extends XriptEventId>(id: K, handler: (payload: XriptEvents[K]) => void): void;",
		"\t}",
		"",
		"\t/**",
		"\t * A capability scope declared by the host. Scope-only — no `read:`/`write:` mode prefix.",
		"\t */",
		"\ttype Capability = \"modify-state\";",
		"",
		"\t/**",
		"\t * A capability reference: a declared scope, optionally carrying a `read:`/`write:` mode prefix.",
		"\t * A bare scope means `write:` (the top of the mode lattice).",
		"\t */",
		"\ttype CapabilityRef = (\"modify-state\" | \"read:modify-state\" | \"write:modify-state\") | (string & {});",
		"",
		"\t/**",
		"\t * The in-sandbox xript global. Exposes the imperative export-registration surface.",
		"\t */",
		"\tconst xript: {",
		"\t\texports: {",
		"\t\t\tregister(name: string, fn: (...args: any[]) => unknown): void;",
		"\t\t};",
		"\t};",
		"}",
		"",
		"/**",
		" * Host-invokable exports declared by this mod.",
		" */",
		"export interface Exports {",
		`\t${exportName}(status: string): string;`,
		"}",
		"",
		"export {};",
		"",
	].join("\n");
}

function generateTier2Host(options: TemplateOptions): string {
	const ts = options.language === "typescript";
	const lines: string[] = [];

	lines.push(`import { initXript } from "@xriptjs/runtime";`);
	lines.push(`import { readFile } from "node:fs/promises";`);
	lines.push(``);
	lines.push(`const manifestRaw = await readFile(new URL("../manifest.json", import.meta.url), "utf-8");`);
	lines.push(`const manifest = JSON.parse(manifestRaw);`);
	lines.push(``);
	lines.push(`const hostBindings = {`);
	lines.push(`\tlog: (message${ts ? ": string" : ""}) => console.log(\`[script] \${message}\`),`);
	lines.push(`\tgreet: (name${ts ? ": string" : ""}) => \`Hello, \${name}!\`,`);
	lines.push(`};`);
	lines.push(``);
	lines.push(`const xript = await initXript();`);
	lines.push(``);
	lines.push(`export function createRuntime(capabilities${ts ? ": string[] = []" : " = []"}) {`);
	lines.push(`\treturn xript.createRuntime(manifest, {`);
	lines.push(`\t\thostBindings,`);
	lines.push(`\t\tcapabilities,`);
	lines.push(`\t\tconsole: { log: console.log, warn: console.warn, error: console.error },`);
	lines.push(`\t});`);
	lines.push(`}`);
	lines.push(``);

	return lines.join("\n");
}

function generateTier2Demo(options: TemplateOptions): string {
	const lines: string[] = [];

	lines.push(`import { createRuntime } from "./host.${options.language === "typescript" ? "ts" : "js"}";`);
	lines.push(``);
	lines.push(`const runtime = createRuntime();`);
	lines.push(``);
	lines.push(`console.log("=== ${titleCase(options.name)} Demo ===\\n");`);
	lines.push(``);
	lines.push(`const scripts = [`);
	lines.push(`\t'log("xript is running!")',`);
	lines.push(`\t'greet("world")',`);
	lines.push(`\t'greet("xript")',`);
	lines.push(`\t'log("Result: " + greet("developer"))',`);
	lines.push(`];`);
	lines.push(``);
	lines.push(`for (const script of scripts) {`);
	lines.push(`\ttry {`);
	lines.push(`\t\tconst result = runtime.execute(script);`);
	lines.push(`\t\tif (result.value !== undefined) {`);
	lines.push(`\t\t\tconsole.log(\`  \${script}  =>  \${JSON.stringify(result.value)}\`);`);
	lines.push(`\t\t}`);
	lines.push(`\t} catch (e) {`);
	lines.push(`\t\tconsole.log(\`  \${script}  =>  ERROR: \${e.message}\`);`);
	lines.push(`\t}`);
	lines.push(`}`);
	lines.push(``);
	lines.push(`console.log("\\n=== Demo complete ===");`);
	lines.push(``);
	lines.push(`runtime.dispose();`);
	lines.push(``);

	return lines.join("\n");
}

function generateTier3Host(options: TemplateOptions): string {
	const ts = options.language === "typescript";
	const lines: string[] = [];

	lines.push(`import { initXript } from "@xriptjs/runtime";`);
	lines.push(`import { readFile } from "node:fs/promises";`);
	lines.push(``);
	lines.push(`const manifestRaw = await readFile(new URL("../manifest.json", import.meta.url), "utf-8");`);
	lines.push(`const manifest = JSON.parse(manifestRaw);`);
	lines.push(``);
	lines.push(`let count = 0;`);
	lines.push(``);
	lines.push(`const hostBindings = {`);
	lines.push(`\tlog: (message${ts ? ": string" : ""}) => console.log(\`[script] \${message}\`),`);
	lines.push(`\tgreet: (name${ts ? ": string" : ""}) => \`Hello, \${name}!\`,`);
	lines.push(`\tcounter: {`);
	lines.push(`\t\tget: () => count,`);
	lines.push(`\t\tincrement: (amount${ts ? ": number" : ""} = 1) => { count += amount; return count; },`);
	lines.push(`\t\treset: () => { count = 0; return count; },`);
	lines.push(`\t},`);
	lines.push(`};`);
	lines.push(``);
	lines.push(`const xript = await initXript();`);
	lines.push(``);
	lines.push(`export function createRuntime(capabilities${ts ? ": string[] = []" : " = []"}) {`);
	lines.push(`\tconst runtime = xript.createRuntime(manifest, {`);
	lines.push(`\t\thostBindings,`);
	lines.push(`\t\tcapabilities,`);
	lines.push(`\t\tconsole: { log: console.log, warn: console.warn, error: console.error },`);
	lines.push(`\t});`);
	lines.push(``);
	lines.push(`\truntime.fireHook("onStart");`);
	lines.push(``);
	lines.push(`\treturn runtime;`);
	lines.push(`}`);
	lines.push(``);

	return lines.join("\n");
}

function generateTier3Demo(options: TemplateOptions): string {
	const lines: string[] = [];

	lines.push(`import { createRuntime } from "./host.${options.language === "typescript" ? "ts" : "js"}";`);
	lines.push(``);
	lines.push(`console.log("=== ${titleCase(options.name)} Demo ===\\n");`);
	lines.push(``);
	lines.push(`const runtime = createRuntime(["modify-state"]);`);
	lines.push(``);
	lines.push(`const script = \``);
	lines.push(`hooks.onStart(() => {`);
	lines.push(`\tlog("Script loaded!");`);
	lines.push(`});`);
	lines.push(``);
	lines.push(`log("Greeting: " + greet("developer"));`);
	lines.push(``);
	lines.push(`counter.increment();`);
	lines.push(`counter.increment(5);`);
	lines.push(`log("Counter: " + counter.get());`);
	lines.push(``);
	lines.push(`counter.reset();`);
	lines.push(`log("Counter after reset: " + counter.get());`);
	lines.push(`\`;`);
	lines.push(``);
	lines.push(`try {`);
	lines.push(`\truntime.execute(script);`);
	lines.push(`} catch (e) {`);
	lines.push(`\tconsole.error(\`Script error: \${e.message}\`);`);
	lines.push(`}`);
	lines.push(``);
	lines.push(`console.log("\\n=== Demo complete ===");`);
	lines.push(``);
	lines.push(`runtime.dispose();`);
	lines.push(``);

	return lines.join("\n");
}

function generateTier4Demo(options: TemplateOptions): string {
	const lines: string[] = [];

	lines.push(`import { createRuntime } from "./host.${options.language === "typescript" ? "ts" : "js"}";`);
	lines.push(`import { readFile } from "node:fs/promises";`);
	lines.push(``);
	lines.push(`console.log("=== ${titleCase(options.name)} Demo ===\\n");`);
	lines.push(``);
	lines.push(`const runtime = createRuntime(["modify-state", "ui-mount"]);`);
	lines.push(``);
	lines.push(`const modManifestRaw = await readFile(new URL("../mod-manifest.json", import.meta.url), "utf-8");`);
	lines.push(`const modManifest = JSON.parse(modManifestRaw);`);
	lines.push(``);
	lines.push(`const fragmentHtml = await readFile(new URL("../fragments/panel.html", import.meta.url), "utf-8");`);
	lines.push(``);
	lines.push(`const mod = runtime.loadMod(modManifest, {`);
	lines.push(`\tfragmentSources: { "fragments/panel.html": fragmentHtml },`);
	lines.push(`});`);
	lines.push(`console.log(\`Loaded \${mod.name} (\${mod.fragments.length} fragment(s) filling sidebar.left)\\n\`);`);
	lines.push(``);
	lines.push(`for (const result of mod.updateBindings({ app: { status: "online" } })) {`);
	lines.push(`\tconsole.log(\`[\${result.fragmentId}] HTML:\\n\` + result.html.trim());`);
	lines.push(`}`);
	lines.push(``);
	lines.push(`console.log("\\n=== Demo complete ===");`);
	lines.push(``);
	lines.push(`runtime.dispose();`);
	lines.push(``);

	return lines.join("\n");
}

function generateTier4ModManifest(options: TemplateOptions): string {
	const manifest: Record<string, unknown> = {
		$schema: "https://xript.dev/schema/mod-manifest/v0.7.json",
		xript: "0.7",
		name: `${options.name}-panel`,
		version: "0.1.0",
		title: `${titleCase(options.name)} Panel`,
		description: `A UI mod for ${titleCase(options.name)}.`,
		capabilities: ["ui-mount"],
		fills: {
			"sidebar.left": [
				{
					id: "info-panel",
					format: "text/html",
					source: "fragments/panel.html",
					bindings: [
						{ name: "status", path: "app.status" },
					],
				},
			],
		},
	};

	return JSON.stringify(manifest, null, "\t") + "\n";
}

function familyFromName(name: string): string | undefined {
	const prefix = name.split("-")[0];
	return prefix && prefix !== name ? prefix : undefined;
}

function exampleExportName(name: string): string {
	const camel = name
		.split(/[-_]/)
		.filter(Boolean)
		.map((seg, i) => (i === 0 ? seg : seg.charAt(0).toUpperCase() + seg.slice(1)))
		.join("");
	return `${camel}Status`;
}

function generateModManifest(options: TemplateOptions): string {
	const family = familyFromName(options.name);
	const ext = options.language === "typescript" ? "ts" : "js";
	const exportName = exampleExportName(options.name);
	const manifest: Record<string, unknown> = {
		$schema: "https://xript.dev/schema/mod-manifest/v0.7.json",
		xript: "0.7",
		name: options.name,
		version: "0.1.0",
		title: titleCase(options.name),
		description: "A xript mod.",
		...(family ? { family } : {}),
		capabilities: ["modify-state"],
		entry: {
			script: `src/mod.${ext}`,
			format: "module",
			exports: {
				[exportName]: {
					description: "Returns a status line for the given status value.",
					params: [{ name: "status", type: "string" }],
					returns: "string",
				},
			},
		},
		fills: {
			"sidebar.left": [
				{
					id: "info-panel",
					format: "text/html",
					source: "fragments/panel.html",
					bindings: [
						{ name: "status", path: "app.status" },
					],
				},
			],
		},
	};

	return JSON.stringify(manifest, null, "\t") + "\n";
}

function generateModPackageJson(options: TemplateOptions): string {
	const pkg: Record<string, unknown> = {
		name: options.name,
		version: "0.1.0",
		private: true,
		type: "module",
		description: "A xript mod.",
	};

	if (options.language === "typescript") {
		pkg.scripts = {
			build: "tsc",
			demo: "npm run build && xript run --app demo/host-manifest.json --steps demo/steps.json",
		};
		pkg.devDependencies = {
			"@xriptjs/cli": "^0.7.0",
			typescript: "^5.0.0",
		};
	} else {
		pkg.scripts = {
			demo: "xript run --app demo/host-manifest.json --steps demo/steps.json",
		};
		pkg.devDependencies = {
			"@xriptjs/cli": "^0.7.0",
		};
	}

	return JSON.stringify(pkg, null, "\t") + "\n";
}

function generateModDemoHostManifest(options: TemplateOptions): string {
	const manifest = {
		$schema: "https://xript.dev/schema/manifest/v0.7.json",
		xript: "0.7",
		name: `${options.name}-demo-host`,
		version: "0.1.0",
		description: "A synthetic host for exercising this mod without a real application. Its bindings are stubbed by the harness; replace it with your target host's real manifest when you have one.",
		bindings: {
			log: {
				description: "Writes a message to the host console.",
				params: [{ name: "message", type: "string" }],
			},
		},
		capabilities: {
			"modify-state": {
				description: "Modify application state.",
				risk: "medium",
			},
		},
		slots: [
			{
				id: "sidebar.left",
				accepts: ["text/html"],
				multiple: true,
				description: "Left sidebar panel for mod-contributed UI.",
			},
		],
		events: [
			{
				id: "app.status-changed",
				description: "Fired when the host's status changes.",
				payload: "string",
			},
		],
	};

	return JSON.stringify(manifest, null, "\t") + "\n";
}

function generateModDemoSteps(options: TemplateOptions): string {
	const entry = options.language === "typescript" ? "../dist/mod.js" : "../src/mod.js";
	const exportName = exampleExportName(options.name);
	const steps = {
		$schema: "https://xript.dev/schema/harness-steps/v0.7.json",
		steps: [
			{
				action: "load-mod",
				manifest: "../mod-manifest.json",
				source: entry,
				sources: { "fragments/panel.html": "../fragments/panel.html" },
			},
			{ action: "invoke", export: exportName, args: ["online"] },
			{ action: "emit", event: "app.status-changed", payload: "ready" },
			{ action: "journal" },
		],
	};

	return JSON.stringify(steps, null, "\t") + "\n";
}

function generateModEntryScript(options: TemplateOptions): string {
	const ts = options.language === "typescript";
	const exportName = exampleExportName(options.name);
	const lines: string[] = [];

	if (ts) {
		lines.push(`/// <reference path="./xript-env.d.ts" />`);
		lines.push(``);
	}
	lines.push(`export function ${exportName}(status${ts ? ": string" : ""})${ts ? ": string" : ""} {`);
	lines.push(`\treturn "${titleCase(options.name)}: " + status;`);
	lines.push(`}`);
	lines.push(``);
	lines.push(`hooks.fragment.update("info-panel", ${ts ? "(data: Record<string, unknown>)" : "(data)"} => {`);
	lines.push(`\tlog("Fragment updated with: " + JSON.stringify(data));`);
	lines.push(`});`);
	lines.push(``);
	lines.push(`events.on("app.status-changed", ${ts ? "(status: string)" : "(status)"} => {`);
	lines.push(`\tlog("Host status is now: " + status);`);
	lines.push(`});`);
	lines.push(``);
	lines.push(`log("${titleCase(options.name)} mod loaded!");`);
	lines.push(``);

	return lines.join("\n");
}

function generateModFragmentHtml(): string {
	const lines: string[] = [];

	lines.push(`<div class="xript-panel">`);
	lines.push(`\t<h3>Mod Panel</h3>`);
	lines.push(`\t<p data-bind="status">Loading...</p>`);
	lines.push(`\t<p data-if="status">Status is available</p>`);
	lines.push(`</div>`);
	lines.push(``);

	return lines.join("\n");
}

function titleCase(name: string): string {
	return name
		.replace(/[-_]/g, " ")
		.replace(/\b\w/g, (c) => c.toUpperCase());
}
