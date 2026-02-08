export class BindingError extends Error {
	public readonly binding: string;

	constructor(binding: string, message: string) {
		super(`${binding}: ${message}`);
		this.name = "BindingError";
		this.binding = binding;
	}
}

export class CapabilityDeniedError extends Error {
	public readonly capability: string;
	public readonly binding: string;

	constructor(binding: string, capability: string) {
		super(
			`calling "${binding}" requires the "${capability}" capability, which has not been granted to this script.`,
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
