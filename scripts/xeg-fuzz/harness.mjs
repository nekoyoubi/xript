/**
 * The three XEG implementations behind one interface: TypeScript in-process, Rust and C#
 * as line servers (one JSON case in, one JSON result out, in order).
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const root = resolve(here, "..", "..");

const exe = process.platform === "win32" ? ".exe" : "";
const RUST_CRATE = join(root, "crates", "xript-expr");
const RUST_BIN = join(RUST_CRATE, "target", "release", "examples", `xeg_fuzz${exe}`);
const CSHARP_PROJECT = join(here, "csharp", "XegFuzz.csproj");
const CSHARP_OUT = join(here, "csharp", "bin", "fuzz");
const CSHARP_DLL = join(CSHARP_OUT, "XegFuzz.dll");
const TS_ENTRY = join(root, "tools", "sanitize", "dist", "index.js");

function run(command, args, cwd, shell = false) {
	const result = spawnSync(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", shell });
	if (result.status !== 0) {
		throw new Error(`${command} ${args.join(" ")} failed:\n${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
	}
}

/** Builds whatever the selected implementations need. */
export function build(impls) {
	if (impls.includes("ts")) {
		if (process.platform === "win32") run("npm run build --workspace=tools/sanitize", [], root, true);
		else run("npm", ["run", "build", "--workspace=tools/sanitize"], root);
	}
	if (impls.includes("rust")) run("cargo", ["build", "--release", "--quiet", "--example", "xeg_fuzz"], RUST_CRATE);
	if (impls.includes("cs")) run("dotnet", ["build", CSHARP_PROJECT, "-c", "Release", "-o", CSHARP_OUT, "--nologo", "-v", "q"], root);
}

/** Tags what JSON cannot carry, so a non-finite number is a visible divergence rather than `null`. */
function encode(value) {
	if (typeof value === "number") return Number.isFinite(value) ? value : { $nonfinite: String(value) };
	if (value === undefined) return { $foreign: "undefined" };
	if (Array.isArray(value)) return value.map(encode);
	if (value !== null && typeof value === "object") {
		const out = {};
		for (const key of Object.keys(value)) {
			Object.defineProperty(out, key, { value: encode(value[key]), enumerable: true, writable: true, configurable: true });
		}
		return out;
	}
	return value;
}

export async function loadTypeScript() {
	if (!existsSync(TS_ENTRY)) throw new Error("tools/sanitize is not built; run without --no-build");
	const xeg = await import(pathToFileURL(TS_ENTRY).href);

	const evalCase = ({ src, b }) => {
		const parsed = xeg.tryParseExpression(src);
		const value = xeg.evaluateExpression(src, b);
		return {
			parse: parsed.ok
				? { kind: parsed.expression.kind, names: parsed.expression.names, nodes: parsed.expression.nodeCount }
				: null,
			value: encode(value),
			render: xeg.renderValue(value),
			truthy: xeg.evaluateCondition(src, b),
		};
	};

	const segmentCase = ({ text, b }) => {
		const result = xeg.segmentText(text);
		const segments = result.segments?.map((s) => (s.kind === "literal" ? ["literal", s.value] : ["expr", s.source])) ?? null;
		const resolved = result.segments
			? result.segments.map((s) => (s.kind === "literal" ? s.value : xeg.renderValue(xeg.evaluateExpression(s.source, b)))).join("")
			: null;
		return { segments, issues: result.issues.length, resolved };
	};

	const repeatCase = ({ src, b }) => {
		const result = xeg.parseRepeatHeader(src);
		if (!result.ok) return { ok: false };
		const { item, index, source } = result.header;
		return { ok: true, item, index, source, items: encode(xeg.evaluateRepeatItems(result.header, b)) };
	};

	return {
		name: "ts",
		xeg,
		async evaluate(testCase) {
			try {
				if (testCase.k === "e") return evalCase(testCase);
				if (testCase.k === "s") return segmentCase(testCase);
				return repeatCase(testCase);
			} catch (error) {
				return { crash: `${error?.name}: ${error?.message}` };
			}
		},
		close() {},
	};
}

/** A child process that answers one JSON line per request line, restarted if it dies. */
class LineServer {
	constructor(name, command, args, cwd) {
		Object.assign(this, { name, command, args, cwd });
		this.pending = [];
		this.start();
	}

	start() {
		const child = spawn(this.command, this.args, { cwd: this.cwd, stdio: ["pipe", "pipe", "pipe"] });
		this.child = child;
		this.stderr = "";
		child.stderr.on("data", (chunk) => {
			this.stderr = (this.stderr + chunk).slice(-2000);
		});
		child.stdin.on("error", () => {});
		// Split on "\n" only: readline also breaks at U+2028 and U+2029, which a JSON string may carry raw.
		let buffered = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			buffered += chunk;
			let newline;
			while ((newline = buffered.indexOf("\n")) !== -1) {
				const line = buffered.slice(0, newline).replace(/\r$/, "");
				buffered = buffered.slice(newline + 1);
				const next = this.pending.shift();
				if (!next) continue;
				try {
					next.resolve(JSON.parse(line));
				} catch {
					next.resolve({ harnessError: `unparseable output: ${line.slice(0, 200)}` });
				}
			}
		});
		child.on("exit", (code, signal) => {
			if (this.child !== child || this.closing) return;
			const [culprit, ...rest] = this.pending;
			this.pending = [];
			culprit?.resolve({ crash: `process exited (${signal ?? code}) ${this.stderr.trim().split("\n").slice(-3).join(" | ")}` });
			this.start();
			for (const entry of rest) this.send(entry);
		});
	}

	send(entry) {
		this.pending.push(entry);
		this.child.stdin.write(`${entry.line}\n`);
	}

	evaluate(testCase) {
		return new Promise((resolvePromise) => this.send({ line: JSON.stringify(testCase), resolve: resolvePromise }));
	}

	close() {
		this.closing = true;
		this.child.stdin.end();
		this.child.kill();
	}
}

export function loadRust() {
	if (!existsSync(RUST_BIN)) throw new Error("the Rust harness is not built; run without --no-build");
	return new LineServer("rust", RUST_BIN, [], root);
}

export function loadCSharp() {
	if (!existsSync(CSHARP_DLL)) throw new Error("the C# harness is not built; run without --no-build");
	return new LineServer("cs", "dotnet", [CSHARP_DLL], root);
}
