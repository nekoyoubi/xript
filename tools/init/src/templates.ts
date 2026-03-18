export interface ProjectFiles {
	[relativePath: string]: string;
}

export interface TemplateOptions {
	name: string;
	tier: 2 | 3;
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
	} else {
		files[`src/host.${ext}`] = generateTier3Host(options);
		files[`src/demo.${ext}`] = generateTier3Demo(options);
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

	if (options.language === "typescript") {
		files["tsconfig.json"] = generateTsConfig();
	}

	return files;
}

function generateManifest(options: TemplateOptions): string {
	const manifest: Record<string, unknown> = {
		$schema: "https://xript.dev/schema/manifest/v0.1.json",
		xript: "0.1",
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

	if (options.tier === 3) {
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

		manifest.hooks = {
			onStart: {
				description: "Called when a script begins execution.",
			},
		};

		manifest.capabilities = {
			"modify-state": {
				description: "Modify application state.",
				risk: "medium",
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
		"@xriptjs/runtime": "^0.2.0",
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

function generateModManifest(options: TemplateOptions): string {
	const manifest: Record<string, unknown> = {
		$schema: "https://xript.dev/schema/mod-manifest/v0.3.json",
		xript: "0.3",
		name: options.name,
		version: "0.1.0",
		title: titleCase(options.name),
		description: "A xript mod.",
		capabilities: ["modify-state"],
		entry: `src/mod.${options.language === "typescript" ? "ts" : "js"}`,
		fragments: [
			{
				id: "info-panel",
				slot: "sidebar.left",
				format: "text/html",
				source: "fragments/panel.html",
				bindings: [
					{ name: "status", path: "app.status" },
				],
			},
		],
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
		pkg.devDependencies = {
			typescript: "^5.0.0",
		};
	}

	return JSON.stringify(pkg, null, "\t") + "\n";
}

function generateModEntryScript(options: TemplateOptions): string {
	const ts = options.language === "typescript";
	const lines: string[] = [];

	lines.push(`hooks.fragment.update(${ts ? "(data: Record<string, unknown>)" : "(data)"} => {`);
	lines.push(`\tlog("Fragment updated with: " + JSON.stringify(data));`);
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
