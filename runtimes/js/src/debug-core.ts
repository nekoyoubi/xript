import type {
	Breakpoint,
	DebugOptions,
	Scope,
	SourceBreakpoint,
	StackFrame,
	StoppedEvent,
	StoppedReason,
	Variable,
} from "./debug-types.js";
import { DEBUG_THREAD_ID, unsupportedVariable } from "./debug-types.js";

type StepMode = "none" | "in" | "over" | "out";

interface ProbeContext {
	line: number;
	column: number;
	locals: Record<string, unknown>;
	frameName: string;
}

let breakpointIdCounter = 0;

export class DebugCore {
	private readonly options: DebugOptions;
	private readonly breakpoints = new Map<string, Breakpoint[]>();
	private breakableLines = new Set<number>();
	private primarySource = "xript-script.js";

	private stepMode: StepMode = "none";
	private pauseRequested = false;
	private paused = false;

	private currentFrames: StackFrame[] = [];
	private variableRegistry = new Map<number, Variable[]>();
	private variableRefCounter = 0;
	private lastStopped: StoppedEvent | null = null;

	constructor(options: DebugOptions) {
		this.options = options;
	}

	setBreakableLines(source: string, lines: Set<number>): void {
		this.primarySource = source;
		this.breakableLines = lines;
		this.rebindBreakpoints(source);
	}

	private rebindBreakpoints(source: string): void {
		const existing = this.breakpoints.get(source);
		if (!existing) return;
		for (const bp of existing) {
			const verified = this.breakableLines.has(bp.line);
			if (bp.verified !== verified) {
				bp.verified = verified;
				this.options.onBreakpointChanged?.({ ...bp });
			}
		}
	}

	setBreakpoints(source: string, requested: SourceBreakpoint[]): Breakpoint[] {
		const bound: Breakpoint[] = requested.map((sb) => ({
			id: ++breakpointIdCounter,
			verified: source === this.primarySource ? this.breakableLines.has(sb.line) : false,
			line: sb.line,
			column: sb.column,
			source,
		}));
		this.breakpoints.set(source, bound);
		return bound.map((b) => ({ ...b }));
	}

	clearBreakpoints(source: string): void {
		this.breakpoints.delete(source);
	}

	pause(): void {
		this.pauseRequested = true;
	}

	resume(): void {
		this.stepMode = "none";
		this.paused = false;
		this.pauseRequested = false;
		this.options.onContinued?.(DEBUG_THREAD_ID);
	}

	step(mode: Exclude<StepMode, "none">): void {
		this.stepMode = mode;
		this.paused = false;
		this.options.onContinued?.(DEBUG_THREAD_ID);
	}

	terminate(): void {
		this.options.onTerminated?.();
	}

	private breakpointsAt(line: number): Breakpoint[] {
		const list = this.breakpoints.get(this.primarySource) ?? [];
		return list.filter((b) => b.verified && b.line === line);
	}

	shouldStop(ctx: ProbeContext): StoppedReason | null {
		if (this.pauseRequested) {
			this.pauseRequested = false;
			return "pause";
		}
		if (this.stepMode !== "none") {
			return "step";
		}
		const hits = this.breakpointsAt(ctx.line);
		if (hits.length > 0) return "breakpoint";
		return null;
	}

	enterPause(reason: StoppedReason, ctx: ProbeContext): StoppedEvent {
		this.paused = true;
		this.variableRegistry.clear();
		this.variableRefCounter = 0;

		const localsRef = this.registerScopeVariables(ctx.locals);
		this.currentFrames = [
			{ id: 1, name: ctx.frameName, line: ctx.line, column: ctx.column, source: this.primarySource },
		];
		this.frameScopes.set(1, localsRef);

		const hitIds = reason === "breakpoint" ? this.breakpointsAt(ctx.line).map((b) => b.id) : undefined;
		const event: StoppedEvent = {
			reason,
			threadId: DEBUG_THREAD_ID,
			...(hitIds && hitIds.length > 0 ? { hitBreakpointIds: hitIds } : {}),
		};
		this.lastStopped = event;
		this.options.onStopped?.(event);
		return event;
	}

	private frameScopes = new Map<number, number>();

	private registerScopeVariables(locals: Record<string, unknown>): number {
		const ref = ++this.variableRefCounter;
		const vars: Variable[] = Object.entries(locals).map(([name, value]) => this.toVariable(name, value));
		this.variableRegistry.set(ref, vars);
		return ref;
	}

	private toVariable(name: string, value: unknown): Variable {
		const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
		if (value !== null && typeof value === "object") {
			const ref = ++this.variableRefCounter;
			const children: Variable[] = Object.entries(value as Record<string, unknown>).map(([k, v]) =>
				this.toVariable(k, v),
			);
			this.variableRegistry.set(ref, children);
			return { name, value: this.displayString(value), type, variablesReference: ref };
		}
		return { name, value: this.displayString(value), type, variablesReference: 0 };
	}

	private displayString(value: unknown): string {
		if (typeof value === "string") return value;
		if (value === undefined) return "undefined";
		if (value === null) return "null";
		try {
			return JSON.stringify(value);
		} catch {
			return String(value);
		}
	}

	isPaused(): boolean {
		return this.paused;
	}

	stackTrace(): StackFrame[] {
		return this.currentFrames.map((f) => ({ ...f }));
	}

	scopes(frameId: number): Scope[] {
		const ref = this.frameScopes.get(frameId);
		if (ref === undefined) return [];
		return [{ name: "Local", variablesReference: ref, expensive: false }];
	}

	variables(variablesReference: number): Variable[] {
		const vars = this.variableRegistry.get(variablesReference);
		return vars ? vars.map((v) => ({ ...v })) : [];
	}

	evaluate(_expression: string, _frameId?: number): Variable {
		return unsupportedVariable("evaluate is not supported by this runtime's debug session");
	}
}
