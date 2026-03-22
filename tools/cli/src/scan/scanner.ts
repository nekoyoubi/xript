import { resolve } from "node:path";
import type { ScanResult, ScanDiagnostic, ScannedCapability } from "./index.js";

interface ScannedBinding {
	description: string;
	params?: Array<{ name: string; type: string; description?: string; required?: boolean }>;
	returns?: string;
	async?: boolean;
	capability?: string;
	deprecated?: string;
	sourceFile: string;
	line: number;
}

interface FlatBinding {
	path: string;
	binding: ScannedBinding;
}

function extractXriptTags(jsdoc: string): { bindingPath?: string; capabilities: string[]; deprecated?: string } {
	const capabilities: string[] = [];
	let bindingPath: string | undefined;
	let deprecated: string | undefined;

	for (const line of jsdoc.split("\n")) {
		const trimmed = line.replace(/^\s*\*?\s*/, "").trim();

		const xriptMatch = trimmed.match(/^@xript\s+(\S+)/);
		if (xriptMatch) {
			bindingPath = xriptMatch[1];
			continue;
		}

		const capMatch = trimmed.match(/^@xript-cap\s+(\S+)/);
		if (capMatch) {
			capabilities.push(capMatch[1]);
			continue;
		}

		const deprecatedMatch = trimmed.match(/^@deprecated\s+(.*)/);
		if (deprecatedMatch) {
			deprecated = deprecatedMatch[1].trim();
		}
	}

	return { bindingPath, capabilities, deprecated };
}

function extractDescription(jsdoc: string): string {
	const lines: string[] = [];
	for (const line of jsdoc.split("\n")) {
		const trimmed = line.replace(/^\s*\/?\*+\s?/, "").replace(/\*\/\s*$/, "").trim();
		if (trimmed.startsWith("@")) break;
		if (trimmed) lines.push(trimmed);
	}
	return lines.join(" ").trim();
}

function extractParams(jsdoc: string): Array<{ name: string; description?: string }> {
	const params: Array<{ name: string; description?: string }> = [];
	for (const line of jsdoc.split("\n")) {
		const trimmed = line.replace(/^\s*\*?\s*/, "").trim();
		const match = trimmed.match(/^@param\s+(?:\{[^}]*\}\s+)?(\w+)\s*-?\s*(.*)/);
		if (match) {
			params.push({ name: match[1], description: match[2].trim() || undefined });
		}
	}
	return params;
}

function typeToString(typeNode: any): string {
	if (!typeNode) return "unknown";
	return typeNode.getText();
}

function isPromiseType(text: string): boolean {
	return /^Promise\s*</.test(text);
}

function unwrapPromise(text: string): string {
	const match = text.match(/^Promise\s*<(.+)>$/);
	return match ? match[1] : text;
}

export async function scanDirectoryImpl(dir: string): Promise<ScanResult> {
	const { Project } = await import("ts-morph");
	const absoluteDir = resolve(dir);
	const project = new Project({ skipAddingFilesFromTsConfig: true });

	project.addSourceFilesAtPaths([
		`${absoluteDir}/**/*.ts`,
		`!${absoluteDir}/**/node_modules/**`,
		`!${absoluteDir}/**/*.test.ts`,
		`!${absoluteDir}/**/*.spec.ts`,
		`!${absoluteDir}/**/*.d.ts`,
	]);

	const flatBindings: FlatBinding[] = [];
	const diagnostics: ScanDiagnostic[] = [];
	const allCapabilities = new Map<string, ScannedCapability>();
	const seenPaths = new Set<string>();

	for (const sourceFile of project.getSourceFiles()) {
		const filePath = sourceFile.getFilePath();

		for (const func of sourceFile.getFunctions()) {
			if (!func.isExported()) continue;
			const jsDocs = func.getJsDocs();
			if (jsDocs.length === 0) continue;

			const fullJsdoc = jsDocs.map((d) => d.getFullText()).join("\n");
			const { bindingPath, capabilities, deprecated } = extractXriptTags(fullJsdoc);
			if (!bindingPath) continue;

			if (seenPaths.has(bindingPath)) {
				diagnostics.push({
					file: filePath,
					line: func.getStartLineNumber(),
					message: `duplicate binding path "${bindingPath}"`,
					severity: "error",
				});
				continue;
			}
			seenPaths.add(bindingPath);

			const description = extractDescription(fullJsdoc);
			if (!description) {
				diagnostics.push({
					file: filePath,
					line: func.getStartLineNumber(),
					message: `binding "${bindingPath}" has no description`,
					severity: "warning",
				});
			}

			const jsdocParams = extractParams(fullJsdoc);
			const funcParams = func.getParameters();
			const params = funcParams.map((p) => {
				const name = p.getName();
				const type = typeToString(p.getTypeNode());
				const jsdocParam = jsdocParams.find((jp) => jp.name === name);
				const hasDefault = p.hasInitializer();
				const isOptional = p.isOptional() || hasDefault;
				return {
					name,
					type,
					description: jsdocParam?.description,
					...(!isOptional ? {} : { required: false }),
				};
			});

			const returnTypeNode = func.getReturnTypeNode();
			const returnText = returnTypeNode ? typeToString(returnTypeNode) : undefined;
			const isAsync = func.isAsync() || (returnText ? isPromiseType(returnText) : false);
			const returns = returnText
				? (isPromiseType(returnText) ? unwrapPromise(returnText) : returnText)
				: undefined;

			const capability = capabilities.length > 0 ? capabilities[0] : undefined;

			if (capabilities.length > 1) {
				diagnostics.push({
					file: filePath,
					line: func.getStartLineNumber(),
					message: `binding "${bindingPath}" declares ${capabilities.length} @xript-cap tags but the manifest schema only supports one; only "${capabilities[0]}" will be written`,
					severity: "warning",
				});
			}

			for (const cap of capabilities) {
				if (!allCapabilities.has(cap)) {
					allCapabilities.set(cap, {
						description: `${cap} capability`,
						risk: "low",
						referencedBy: [],
					});
				}
				allCapabilities.get(cap)!.referencedBy.push(bindingPath);
			}

			flatBindings.push({
				path: bindingPath,
				binding: {
					description: description || `${bindingPath} binding`,
					...(params.length > 0 ? { params } : {}),
					...(returns && returns !== "void" ? { returns } : {}),
					...(isAsync ? { async: true } : {}),
					...(capability ? { capability } : {}),
					...(deprecated ? { deprecated } : {}),
					sourceFile: filePath,
					line: func.getStartLineNumber(),
				},
			});
		}
	}

	const bindings = nestBindings(flatBindings);

	return {
		bindings,
		capabilities: Object.fromEntries(allCapabilities),
		diagnostics,
	};
}

export async function scanFileImpl(filePath: string): Promise<ScanResult> {
	const { dirname: dirnameFn } = await import("node:path");
	return scanDirectoryImpl(dirnameFn(resolve(filePath)));
}

function nestBindings(flat: FlatBinding[]): Record<string, unknown> {
	const root: Record<string, unknown> = {};

	for (const { path, binding } of flat) {
		const parts = path.split(".");

		if (parts.length === 1) {
			const { sourceFile, line, ...manifestBinding } = binding;
			root[parts[0]] = manifestBinding;
			continue;
		}

		let current = root;
		for (let i = 0; i < parts.length - 1; i++) {
			const part = parts[i];
			if (!current[part]) {
				current[part] = {
					description: `${part} namespace`,
					members: {},
				};
			}
			current = (current[part] as any).members;
		}

		const leafName = parts[parts.length - 1];
		const { sourceFile, line, ...manifestBinding } = binding;
		current[leafName] = manifestBinding;
	}

	return root;
}
