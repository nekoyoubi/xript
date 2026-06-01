export const DEBUG_THREAD_ID = 1;

export type StoppedReason = "breakpoint" | "step" | "pause" | "entry" | "exception";

export type ScopeName = "Local" | "Closure" | "Global";

export type DebugFidelity = "native" | "instrumented";

export interface SourceBreakpoint {
	line: number;
	column?: number;
	condition?: string;
}

export interface Breakpoint {
	id: number;
	verified: boolean;
	line: number;
	column?: number;
	source: string;
}

export interface StackFrame {
	id: number;
	name: string;
	line: number;
	column: number;
	source: string;
}

export interface Scope {
	name: ScopeName;
	variablesReference: number;
	expensive: boolean;
}

export interface Variable {
	name: string;
	value: string;
	type?: string;
	variablesReference: number;
}

export interface StoppedEvent {
	reason: StoppedReason;
	threadId: number;
	hitBreakpointIds?: number[];
	description?: string;
}

export interface DebugOptions {
	onStopped?: (event: StoppedEvent) => void;
	onContinued?: (threadId: number) => void;
	onTerminated?: () => void;
	onBreakpointChanged?: (breakpoint: Breakpoint) => void;
}

export interface DebugSession {
	readonly fidelity: DebugFidelity;
	setBreakpoints(source: string, breakpoints: SourceBreakpoint[]): Breakpoint[];
	clearBreakpoints(source: string): void;
	pause(): void;
	continue(): void;
	resume(): void;
	stepIn(): void;
	stepOver(): void;
	stepOut(): void;
	stackTrace(): StackFrame[];
	scopes(frameId: number): Scope[];
	variables(variablesReference: number): Variable[];
	evaluate(expression: string, frameId?: number): Variable;
}

export class DebugUnsupportedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DebugUnsupportedError";
	}
}

export function unsupportedVariable(message: string): Variable {
	return { name: "<unsupported>", value: message, type: "unsupported", variablesReference: 0 };
}
