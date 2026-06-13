export class BindingError extends Error {
	public readonly binding: string;

	constructor(binding: string, message: string) {
		super(`${binding}(): ${message}`);
		this.name = "BindingError";
		this.binding = binding;
	}
}

export class CapabilityDeniedError extends Error {
	public readonly capability: string;
	public readonly binding: string;

	constructor(binding: string, capability: string) {
		super(
			`${binding}() requires the "${capability}" capability, which hasn't been granted to this script. Ask the app developer to enable it.`,
		);
		this.name = "CapabilityDeniedError";
		this.capability = capability;
		this.binding = binding;
	}
}

export class ExecutionLimitError extends Error {
	public readonly limit: string;

	constructor(limit: string, message: string) {
		super(message);
		this.name = "ExecutionLimitError";
		this.limit = limit;
	}
}

export class CancellationError extends Error {
	constructor(message = "Script execution was cancelled by the host.") {
		super(message);
		this.name = "CancellationError";
	}
}

export class InvokeError extends Error {
	public readonly export: string;

	constructor(exportName: string, message: string) {
		super(message);
		this.name = "InvokeError";
		this.export = exportName;
	}
}

export class ManifestValidationError extends Error {
	public readonly issues: Array<{ path: string; message: string }>;

	constructor(issues: Array<{ path: string; message: string }>) {
		const summary = issues.map((i) => `  ${i.path}: ${i.message}`).join("\n");
		super(`Invalid xript manifest:\n${summary}`);
		this.name = "ManifestValidationError";
		this.issues = issues;
	}
}

export class ModEntryError extends Error {
	public readonly modName: string;

	constructor(modName: string, message: string) {
		super(message);
		this.name = "ModEntryError";
		this.modName = modName;
	}
}

export class ImportDeniedError extends Error {
	public readonly specifier: string;

	constructor(specifier: string) {
		super(
			`import of "${specifier}" is not permitted; xript mods cannot import external modules (see security guarantee: no sandbox escape)`,
		);
		this.name = "ImportDeniedError";
		this.specifier = specifier;
	}
}

export class CommonJSDetectedError extends Error {
	public readonly artifact: string;

	constructor(artifact: string) {
		super(
			`CommonJS artifacts detected in mod entry (found: ${artifact}). ` +
				`xript mods must be authored as ES modules (entry.format: "module", top-level export) ` +
				`or as classic scripts using xript.exports.register — never CommonJS. ` +
				`Fix your tsconfig to emit ESM (module: "esnext", moduleResolution: "bundler"/"nodenext") ` +
				`or remove the require()/module.exports usage. ` +
				`See https://xript.dev/spec/modules/.`,
		);
		this.name = "CommonJSDetectedError";
		this.artifact = artifact;
	}
}

export class ModuleUnsupportedError extends Error {
	constructor(message = "module-format mods require the async sandbox") {
		super(message);
		this.name = "ModuleUnsupportedError";
	}
}

export class LibraryUnavailableError extends Error {
	public readonly specifier: string;

	constructor(specifier: string) {
		super(
			`library "${specifier}" is declared in the host manifest but no source was registered with the runtime; the host must supply it via the runtime's libraries option`,
		);
		this.name = "LibraryUnavailableError";
		this.specifier = specifier;
	}
}

export class LibraryRegistrationError extends Error {
	public readonly specifier: string;

	constructor(specifier: string, reason: string) {
		super(`library "${specifier}" failed registration: ${reason}`);
		this.name = "LibraryRegistrationError";
		this.specifier = specifier;
	}
}
