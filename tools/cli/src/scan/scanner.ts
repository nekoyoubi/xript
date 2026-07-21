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
		const trimmed = line.replace(/^\s*\/?\*+\s?/, "").replace(/\*\/\s*$/, "").trim();

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
		const trimmed = line.replace(/^\s*\/?\*+\s?/, "").replace(/\*\/\s*$/, "").trim();
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
	const { Project, Node } = await import("ts-morph");
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

	/**
	 * Records a binding from any function-like declaration — a `function` statement or an exported
	 * `const` bound to an arrow function or function expression. The JSDoc lives on the declaration
	 * for a function statement and on the variable statement for an arrow const, so both are passed
	 * in rather than read off the node.
	 */
	const recordBinding = (
		fnNode: { getParameters(): any[]; getReturnTypeNode(): any; isAsync(): boolean },
		jsDocs: Array<{ getFullText(): string }>,
		startLine: number,
		filePath: string,
	) => {
		if (jsDocs.length === 0) return;

		const fullJsdoc = jsDocs.map((d) => d.getFullText()).join("\n");
		const { bindingPath, capabilities, deprecated } = extractXriptTags(fullJsdoc);
		if (!bindingPath) return;

		if (seenPaths.has(bindingPath)) {
			diagnostics.push({ file: filePath, line: startLine, message: `duplicate binding path "${bindingPath}"`, severity: "error" });
			return;
		}
		seenPaths.add(bindingPath);

		const description = extractDescription(fullJsdoc);
		if (!description) {
			diagnostics.push({ file: filePath, line: startLine, message: `binding "${bindingPath}" has no description`, severity: "warning" });
		}

		const jsdocParams = extractParams(fullJsdoc);
		const params = fnNode.getParameters().map((p) => {
			const name = p.getName();
			const type = typeToString(p.getTypeNode());
			const jsdocParam = jsdocParams.find((jp) => jp.name === name);
			const isOptional = p.isOptional() || p.hasInitializer();
			return { name, type, description: jsdocParam?.description, ...(!isOptional ? {} : { required: false }) };
		});

		const returnTypeNode = fnNode.getReturnTypeNode();
		const returnText = returnTypeNode ? typeToString(returnTypeNode) : undefined;
		const isAsync = fnNode.isAsync() || (returnText ? isPromiseType(returnText) : false);
		const returns = returnText ? (isPromiseType(returnText) ? unwrapPromise(returnText) : returnText) : undefined;

		const capability = capabilities.length > 0 ? capabilities[0] : undefined;
		if (capabilities.length > 1) {
			diagnostics.push({ file: filePath, line: startLine, message: `binding "${bindingPath}" declares ${capabilities.length} @xript-cap tags but the manifest schema only supports one; only "${capabilities[0]}" will be written`, severity: "warning" });
		}

		for (const cap of capabilities) {
			if (!allCapabilities.has(cap)) {
				allCapabilities.set(cap, { description: `${cap} capability`, risk: "low", referencedBy: [] });
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
				line: startLine,
			},
		});
	};

	for (const sourceFile of project.getSourceFiles()) {
		const filePath = sourceFile.getFilePath();

		for (const func of sourceFile.getFunctions()) {
			if (!func.isExported()) continue;
			recordBinding(func, func.getJsDocs(), func.getStartLineNumber(), filePath);
		}

		for (const statement of sourceFile.getVariableStatements()) {
			if (!statement.isExported()) continue;
			for (const decl of statement.getDeclarations()) {
				const init = decl.getInitializer();
				if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
					recordBinding(init, statement.getJsDocs(), statement.getStartLineNumber(), filePath);
				}
			}
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
