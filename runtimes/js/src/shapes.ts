export type RequestedScope = "one-run" | "session" | "persistent";

export type PromptState = "first-time" | "previously-denied" | "requesting-elevation";

export type CapabilityRisk = "low" | "medium" | "high";

export interface CapabilityPromptMod {
	name: string;
	version: string;
	title?: string;
}

export interface CapabilityPrompt {
	capability: string;
	description: string;
	risk: CapabilityRisk;
	mod: CapabilityPromptMod;
	requestedScope: RequestedScope;
	state: PromptState;
	reason?: string;
}

export type InstallSourceType = "file" | "url" | "registry";

export interface InstallSource {
	type: InstallSourceType;
	location: string;
}

export interface InstallDescriptor {
	name: string;
	version: string;
	title?: string;
	source: InstallSource;
	integrity?: string;
	signature?: string;
	capabilities?: string[];
	manifest?: Record<string, unknown>;
}

export interface DiscoveredMod {
	name: string;
	version: string;
	title?: string;
	location: string;
	enabled: boolean;
	capabilities: string[];
	provides: string[];
}

export interface DiscoveryResult {
	mods: DiscoveredMod[];
	scannedAt: number;
}
