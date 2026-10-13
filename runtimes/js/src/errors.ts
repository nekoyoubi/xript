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

/**
 * Why a call to a script callback did not return a value: the script function threw, the
 * binding call that received it already returned, it returned a promise, or the calling
 * script ran out of its execution budget.
 */
export type CallbackFailure = "threw" | "expired" | "promise" | "limit";

/**
 * Thrown on the host when a callback a script passed to a binding cannot produce a value.
 * For `"threw"`, `message` is the script error's own message and `scriptError` carries its
 * name; letting this error escape the binding rethrows the original error into the script.
 */
export class CallbackError extends Error {
	public readonly binding: string;
	public readonly reason: CallbackFailure;
	public readonly scriptError?: { name?: string; message?: string };

	constructor(binding: string, reason: CallbackFailure, scriptError?: { name?: string; message?: string }) {
		super(callbackFailureMessage(binding, reason, scriptError));
		this.name = "CallbackError";
		this.binding = binding;
		this.reason = reason;
		this.scriptError = scriptError;
	}
}

function callbackFailureMessage(
	binding: string,
	reason: CallbackFailure,
	scriptError?: { name?: string; message?: string },
): string {
	switch (reason) {
		case "threw":
			return scriptError?.message ?? "callback threw";
		case "expired":
			return `${binding}(): callback expired; a callback passed to a binding can only be called while that binding call is running`;
		case "promise":
			return `${binding}(): callback returned a promise; callbacks passed to a binding are synchronous and must return a settled value`;
		case "limit":
			return `${binding}(): callback stopped by the calling script's execution limit`;
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

/**
 * Thrown when a bare export name is invoked but more than one loaded mod owns
 * that name. Mods each get their own export namespace, so the runtime refuses
 * to guess: call `invokeModExport(mod, name, args)` to name the owner.
 */
export class AmbiguousExportError extends Error {
	public readonly export: string;
	public readonly mods: string[];

	constructor(exportName: string, mods: string[]) {
		super(
			`export "${exportName}" is provided by more than one mod (${mods.map((m) => `"${m}"`).join(", ")}); ` +
			`call invokeModExport(mod, "${exportName}", args) to name the owner`,
		);
		this.name = "AmbiguousExportError";
		this.export = exportName;
		this.mods = mods;
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

/**
 * A mod's `entry` names a script the host did not supply. Loading such a mod used to
 * succeed and run nothing, so a typo in a script name looked exactly like a healthy mod
 * with an empty body.
 */
export class MissingEntryScriptError extends ModEntryError {
	public readonly script: string;

	constructor(modName: string, script: string) {
		super(
			modName,
			`mod "${modName}" names entry script "${script}", which was not supplied in fragmentSources`,
		);
		this.name = "MissingEntryScriptError";
		this.script = script;
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

/**
 * Thrown when a host-supplied validator rejects a command's effective arguments. The
 * runtimes ship no JSON Schema validator of their own — a host that wants full `input`
 * checking at invoke passes one in.
 */
export class CommandInputError extends Error {
	public readonly command: string;
	public readonly errors: string[];

	constructor(qualifiedId: string, errors: string[]) {
		super(`command "${qualifiedId}" was called with invalid arguments:\n${errors.map((e) => `  ${e}`).join("\n")}`);
		this.name = "CommandInputError";
		this.command = qualifiedId;
		this.errors = errors;
	}
}

/**
 * Raised at runtime construction under `strictBindings` when the manifest declares bindings the
 * host did not supply. The manifest is the contract a mod author reads; a binding that is
 * documented and absent is a promise the host has not kept, and this is the host finding out
 * rather than a user hitting it.
 */
export class MissingBindingsError extends Error {
	public readonly missing: string[];

	constructor(missing: string[]) {
		super(
			`the manifest declares ${missing.length} binding${missing.length === 1 ? "" : "s"} the host did not supply: ${missing.join(", ")}. ` +
				"Supply them, remove them from the manifest, or construct the runtime without `strictBindings` to install them as stubs that throw when called.",
		);
		this.name = "MissingBindingsError";
		this.missing = missing;
	}
}
