#!/usr/bin/env node

import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const worktreeRoot = join(root, ".claude", "worktrees");

const SKIP_DIRS = new Set(["node_modules", "dist", "target", ".git"]);

function git(args, opts = {}) {
	return execFileSync("git", args, { cwd: root, encoding: "utf8", ...opts }).trim();
}

function gitQuiet(args, opts = {}) {
	try {
		return { ok: true, out: git(args, opts) };
	} catch (err) {
		return { ok: false, out: (err.stdout ?? "") + (err.stderr ?? "") };
	}
}

function dirSize(dir) {
	let total = 0;
	const walk = (d) => {
		let entries;
		try {
			entries = readdirSync(d, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const p = join(d, e.name);
			if (e.isDirectory()) walk(p);
			else if (e.isFile()) {
				try {
					total += statSync(p).size;
				} catch {}
			}
		}
	};
	walk(dir);
	return total;
}

function humanSize(bytes) {
	const units = ["B", "KB", "MB", "GB"];
	let n = bytes;
	let i = 0;
	while (n >= 1024 && i < units.length - 1) {
		n /= 1024;
		i++;
	}
	return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

function sourceFiles(dir) {
	const out = [];
	const walk = (d) => {
		let entries;
		try {
			entries = readdirSync(d, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (SKIP_DIRS.has(e.name)) continue;
			const p = join(d, e.name);
			if (e.isDirectory()) walk(p);
			else if (e.isFile()) out.push(p);
		}
	};
	walk(dir);
	return out;
}

/**
 * A worktree is reclaimable when every one of its source files already exists
 * as a blob in this repo's object store. That means the content is reachable
 * from the repo regardless of whether the worktree is still registered, whether
 * its branch was merged, or whether it still has a `.git` at all.
 */
function isReclaimable(dir) {
	const files = sourceFiles(dir);
	if (files.length === 0) return { reclaimable: true, checked: 0, unique: [] };

	const unique = [];
	for (const f of files) {
		const hashed = gitQuiet(["hash-object", "--", f]);
		if (!hashed.ok) {
			unique.push(relative(dir, f));
			continue;
		}
		const exists = gitQuiet(["cat-file", "-e", hashed.out]);
		if (!exists.ok) unique.push(relative(dir, f));
	}
	return { reclaimable: unique.length === 0, checked: files.length, unique };
}

function registeredWorktrees() {
	const out = gitQuiet(["worktree", "list", "--porcelain"]);
	if (!out.ok) return new Map();
	const map = new Map();
	let current = null;
	for (const line of out.out.split("\n")) {
		if (line.startsWith("worktree ")) current = resolve(line.slice(9).trim());
		else if (line.startsWith("branch ") && current) map.set(current, line.slice(7).trim());
	}
	return map;
}

function isDirty(dir) {
	const res = gitQuiet(["status", "--porcelain"], { cwd: dir });
	if (!res.ok) return false;
	return res.out.length > 0;
}

export function sweepWorktrees({ dryRun = false, force = false, quiet = false } = {}) {
	const log = (...a) => {
		if (!quiet) console.log(...a);
	};

	if (!existsSync(worktreeRoot)) return { removed: [], kept: [], bytes: 0 };

	const dirs = readdirSync(worktreeRoot, { withFileTypes: true })
		.filter((e) => e.isDirectory())
		.map((e) => join(worktreeRoot, e.name));

	if (dirs.length === 0) return { removed: [], kept: [], bytes: 0 };

	const registered = registeredWorktrees();
	const removed = [];
	const kept = [];
	let bytes = 0;

	for (const dir of dirs) {
		const name = relative(worktreeRoot, dir);
		const size = dirSize(dir);
		const branch = registered.get(resolve(dir));

		if (!force) {
			if (branch && isDirty(dir)) {
				kept.push({ name, reason: "uncommitted changes" });
				log(`  keep  ${name} — uncommitted changes`);
				continue;
			}
			const { reclaimable, unique } = isReclaimable(dir);
			if (!reclaimable) {
				kept.push({ name, reason: `${unique.length} file(s) not in object store` });
				log(`  keep  ${name} — ${unique.length} file(s) not in object store`);
				for (const u of unique.slice(0, 3)) log(`          ${u}`);
				continue;
			}
		}

		if (dryRun) {
			log(`  would remove ${name} (${humanSize(size)})`);
			removed.push({ name, size });
			bytes += size;
			continue;
		}

		if (branch) gitQuiet(["worktree", "remove", "--force", dir]);
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch (err) {
			kept.push({ name, reason: `remove failed: ${err.message}` });
			log(`  keep  ${name} — remove failed: ${err.message}`);
			continue;
		}
		removed.push({ name, size });
		bytes += size;
		log(`  removed ${name} (${humanSize(size)})`);
	}

	if (!dryRun && removed.length > 0) gitQuiet(["worktree", "prune"]);

	if (removed.length > 0) {
		log(`${dryRun ? "Would reclaim" : "Reclaimed"} ${humanSize(bytes)} across ${removed.length} worktree(s).`);
	} else if (dirs.length > 0) {
		log(`Nothing to sweep (${dirs.length} worktree(s) still in use).`);
	}

	return { removed, kept, bytes };
}

export function worktreeReport() {
	if (!existsSync(worktreeRoot)) return { count: 0, bytes: 0 };
	const dirs = readdirSync(worktreeRoot, { withFileTypes: true }).filter((e) => e.isDirectory());
	let bytes = 0;
	for (const e of dirs) bytes += dirSize(join(worktreeRoot, e.name));
	return { count: dirs.length, bytes, human: humanSize(bytes) };
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename);

if (invokedDirectly) {
	const args = process.argv.slice(2);
	const dryRun = args.includes("--dry-run") || args.includes("-n");
	const force = args.includes("--force");
	sweepWorktrees({ dryRun, force });
}
