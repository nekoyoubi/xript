import { initXript } from "../../../runtimes/js/dist/index.js";
import { readFile } from "node:fs/promises";

const manifestRaw = await readFile(new URL("../manifest.json", import.meta.url), "utf-8");
const manifest = JSON.parse(manifestRaw);

let nextId = 1;
const taskStore = [];

function createHostBindings() {
	return {
		tasks: {
			list: () => [...taskStore],
			get: (id) => taskStore.find((t) => t.id === id) ?? undefined,
			add: (title, priority = "medium") => {
				const task = {
					id: String(nextId++),
					title,
					done: false,
					priority,
					createdAt: new Date().toISOString(),
				};
				taskStore.push(task);
				return task;
			},
			complete: (id) => {
				const task = taskStore.find((t) => t.id === id);
				if (!task) return false;
				task.done = true;
				return true;
			},
			remove: (id) => {
				const idx = taskStore.findIndex((t) => t.id === id);
				if (idx === -1) return false;
				taskStore.splice(idx, 1);
				return true;
			},
		},
		log: (msg) => console.log(`  [plugin] ${msg}`),
	};
}

const xript = await initXript();

function runPlugin(name, code, capabilities) {
	console.log(`\n--- Plugin: "${name}" (capabilities: [${capabilities.join(", ")}]) ---`);
	const runtime = xript.createRuntime(manifest, {
		hostBindings: createHostBindings(),
		capabilities,
		console: {
			log: (...args) => console.log("  [console]", ...args),
			warn: (...args) => console.warn("  [console]", ...args),
			error: (...args) => console.error("  [console]", ...args),
		},
	});

	for (const line of code.split("\n").filter((l) => l.trim())) {
		const trimmed = line.trim();
		console.log(`  > ${trimmed}`);
		try {
			const result = runtime.execute(trimmed);
			if (result.value !== undefined) {
				console.log(`    => ${JSON.stringify(result.value)}`);
			}
		} catch (e) {
			console.log(`    => ERROR: ${e.message}`);
		}
	}

	runtime.dispose();
}

console.log("=== xript Plugin System Demo (Tier 2) ===");
console.log("This demo runs three plugins with different capability profiles.");

runPlugin(
	"Task Reporter",
	`
		log("Listing all tasks...")
		tasks.list()
		log("Found " + tasks.list().length + " tasks")
	`,
	[],
);

runPlugin(
	"Task Creator",
	`
		tasks.add("Write documentation", "high")
		tasks.add("Fix login bug", "urgent")
		tasks.add("Update dependencies", "low")
		log("Created 3 tasks")
		tasks.list()
		tasks.complete("1")
		log("Completed task 1")
		tasks.list().filter(t => t.done)
	`,
	["manage-tasks"],
);

runPlugin(
	"Read-Only Dashboard",
	`
		log("Dashboard: " + tasks.list().length + " total tasks")
		tasks.list().filter(t => !t.done).length
		tasks.add("Sneaky task", "low")
	`,
	[],
);

runPlugin(
	"Admin Cleanup",
	`
		log("Admin removing completed tasks...")
		tasks.list().filter(t => t.done).length
		tasks.remove("1")
		log("Removed task 1")
		tasks.list()
	`,
	["manage-tasks", "admin"],
);

runPlugin(
	"Privilege Escalation Attempt",
	`
		log("Trying to delete without admin capability...")
		tasks.remove("2")
	`,
	["manage-tasks"],
);

console.log("\n=== Demo complete ===");
