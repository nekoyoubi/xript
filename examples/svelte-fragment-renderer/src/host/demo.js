import { createRuntime, loadModFiles, appState } from "./host.js";
import { makeDispatch } from "./dispatch.js";

console.log("=== Svelte Fragment Renderer Demo (headless) ===\n");
console.log("This harness runs the same host data flow a Svelte app would:");
console.log("updateBindings -> { fragmentId, html, visibility }, fireFragmentHook -> FragmentOp[].");
console.log("In a real app, <Fragment> applies those to the DOM. Here we print them.\n");

const runtime = createRuntime(["ui-mount"]);
const dispatch = makeDispatch(runtime);

const counterMod = await loadModFiles("counter-panel");
const counter = runtime.loadMod(counterMod.manifest, { fragmentSources: counterMod.sources });
console.log(`Loaded ${counter.name} v${counter.version} (${counter.fragments.length} fragment(s))\n`);

function renderFrame(label) {
	console.log(`--- ${label} (value=${appState.counter.value}) ---`);

	const results = counter.updateBindings({ counter: { value: appState.counter.value } });
	for (const result of results) {
		console.log(`  [${result.fragmentId}] html: ${result.html.replace(/\n\t*/g, " ").trim()}`);
		if (Object.keys(result.visibility).length > 0) {
			console.log(`    visibility: ${JSON.stringify(result.visibility)}`);
		}
	}

	const ops = runtime.fireFragmentHook("counter-display", "update", { value: appState.counter.value });
	if (ops.length > 0) {
		console.log(`    ops: ${JSON.stringify(ops)}`);
	}
	console.log("");
}

renderFrame("Initial");

console.log("Simulating a click on .increment-btn (Svelte would call dispatch())...");
for (let i = 0; i < 5; i++) {
	dispatch({ handler: "onIncrement", selector: ".increment-btn", on: "click" });
}
console.log("");

renderFrame("After 5 increments");

console.log("=== Demo complete ===");
runtime.dispose();
