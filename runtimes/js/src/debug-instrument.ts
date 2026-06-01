const STATEMENT_START = /^[\s]*(?:const |let |var |return\b|if\s*\(|for\s*\(|while\s*\(|switch\s*\(|throw\b|break\b|continue\b|do\b|[A-Za-z_$][\w$.]*\s*[=(]|[A-Za-z_$][\w$]*\+\+|[A-Za-z_$][\w$]*--)/;

const DECLARATION = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g;

function lineStartsStatement(line: string): boolean {
	const trimmed = line.trim();
	if (trimmed.length === 0) return false;
	if (trimmed.startsWith("//")) return false;
	if (trimmed.startsWith("*") || trimmed.startsWith("/*")) return false;
	if (trimmed.startsWith("}") || trimmed.startsWith("{")) return false;
	if (trimmed.startsWith(")") || trimmed.startsWith("]")) return false;
	if (trimmed.startsWith("function") || trimmed.startsWith("class")) return false;
	if (trimmed.startsWith("case ") || trimmed.startsWith("default:")) return false;
	if (trimmed.startsWith("else")) return false;
	return STATEMENT_START.test(line);
}

function leadingColumn(line: string): number {
	let i = 0;
	while (i < line.length && (line[i] === " " || line[i] === "\t")) i++;
	return i + 1;
}

function declaredNames(line: string): string[] {
	const names: string[] = [];
	let match: RegExpExecArray | null;
	DECLARATION.lastIndex = 0;
	while ((match = DECLARATION.exec(line)) !== null) {
		names.push(match[1]);
	}
	return names;
}

function localsSnapshot(names: string[]): string {
	if (names.length === 0) return "{}";
	const parts = names.map((n) => `${n}: (typeof ${n} === "undefined" ? undefined : ${n})`);
	return `{ ${parts.join(", ")} }`;
}

export interface ProbeNames {
	shouldStop: string;
	pause: string;
}

export interface InstrumentResult {
	code: string;
	breakableLines: Set<number>;
}

export function instrumentSource(source: string, probes: ProbeNames): InstrumentResult {
	const lines = source.split("\n");
	const breakableLines = new Set<number>();
	const out: string[] = [];
	const inScope: string[] = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const lineNumber = i + 1;
		if (lineStartsStatement(line)) {
			breakableLines.add(lineNumber);
			const col = leadingColumn(line);
			const snapshot = localsSnapshot(inScope);
			const guard = `if (${probes.shouldStop}(${lineNumber})) { await ${probes.pause}(${lineNumber}, ${col}, ${snapshot}); }`;
			const indent = line.slice(0, col - 1);
			out.push(`${indent}${guard}${line.slice(col - 1)}`);
		} else {
			out.push(line);
		}
		for (const name of declaredNames(line)) {
			if (!inScope.includes(name)) inScope.push(name);
		}
	}

	return { code: out.join("\n"), breakableLines };
}
