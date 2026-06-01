import type {
	Breakpoint,
	DebugFidelity,
	DebugOptions,
	DebugSession,
	Scope,
	SourceBreakpoint,
	StackFrame,
	Variable,
} from "./debug-types.js";
import type { StoppedReason } from "./debug-types.js";
import { DebugCore } from "./debug-core.js";
import type { ProbeNames } from "./debug-instrument.js";

interface Gate {
	wait(): Promise<void>;
	release(): void;
}

function createGate(): Gate {
	let resolver: (() => void) | null = null;
	return {
		wait(): Promise<void> {
			return new Promise<void>((resolve) => {
				resolver = resolve;
			});
		},
		release(): void {
			const r = resolver;
			resolver = null;
			if (r) r();
		},
	};
}

export interface DebugController {
	readonly session: DebugSession;
	readonly probeNames: ProbeNames;
	makeShouldStop(): (line: number) => boolean;
	makePause(): (line: number, column: number, locals?: Record<string, unknown>) => Promise<void>;
	setBreakableLines(source: string, lines: Set<number>): void;
}

export function createDebugController(
	options: DebugOptions,
	fidelity: DebugFidelity,
	probeNames: ProbeNames = { shouldStop: "__xript_dbg_should", pause: "__xript_dbg_pause" },
): DebugController {
	const core = new DebugCore(options);
	const gate = createGate();
	let pendingReason: StoppedReason | null = null;
	let pendingLine = 0;

	function shouldStop(line: number): boolean {
		const reason = core.shouldStop({ line, column: 1, locals: {}, frameName: "<script>" });
		if (reason) {
			pendingReason = reason;
			pendingLine = line;
			return true;
		}
		return false;
	}

	async function pause(line: number, column: number, locals?: Record<string, unknown>): Promise<void> {
		const reason = pendingReason ?? "step";
		pendingReason = null;
		core.enterPause(reason, { line, column, locals: locals ?? {}, frameName: "<script>" });
		await gate.wait();
	}

	const session: DebugSession = {
		fidelity,
		setBreakpoints(source: string, breakpoints: SourceBreakpoint[]): Breakpoint[] {
			return core.setBreakpoints(source, breakpoints);
		},
		clearBreakpoints(source: string): void {
			core.clearBreakpoints(source);
		},
		pause(): void {
			core.pause();
		},
		continue(): void {
			core.resume();
			gate.release();
		},
		resume(): void {
			core.resume();
			gate.release();
		},
		stepIn(): void {
			core.step("in");
			gate.release();
		},
		stepOver(): void {
			core.step("over");
			gate.release();
		},
		stepOut(): void {
			core.step("out");
			gate.release();
		},
		stackTrace(): StackFrame[] {
			return core.stackTrace();
		},
		scopes(frameId: number): Scope[] {
			return core.scopes(frameId);
		},
		variables(variablesReference: number): Variable[] {
			return core.variables(variablesReference);
		},
		evaluate(expression: string, frameId?: number): Variable {
			return core.evaluate(expression, frameId);
		},
	};

	return {
		session,
		probeNames,
		makeShouldStop: () => shouldStop,
		makePause: () => pause,
		setBreakableLines(source: string, lines: Set<number>): void {
			core.setBreakableLines(source, lines);
		},
	};
}
