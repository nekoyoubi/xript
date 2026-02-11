import { mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { generateProjectFiles, type TemplateOptions, type ProjectFiles } from "./templates.js";

export type { TemplateOptions, ProjectFiles };
export { generateProjectFiles };

export interface InitResult {
	directory: string;
	files: string[];
}

export async function writeProject(directory: string, options: TemplateOptions): Promise<InitResult> {
	const files = generateProjectFiles(options);
	const writtenFiles: string[] = [];

	for (const [relativePath, content] of Object.entries(files)) {
		const fullPath = join(directory, relativePath);
		await mkdir(dirname(fullPath), { recursive: true });
		await writeFile(fullPath, content, "utf-8");
		writtenFiles.push(relativePath);
	}

	return { directory, files: writtenFiles.sort() };
}
