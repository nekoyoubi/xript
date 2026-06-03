import { test } from "node:test";
import assert from "node:assert/strict";
import { createRuntime, loadModFiles, appState } from "../src/host/host.js";
import { makeDispatch } from "../src/host/dispatch.js";
import { applyVisibility, applyOps, wireHandlers } from "../src/lib/applyFragment.js";
import { makeRoot, FakeEvent } from "./dom-shim.js";

test("end-to-end: runtime output flows through the renderer core into the DOM", async () => {
	const runtime = createRuntime(["ui-mount"]);
	const dispatch = makeDispatch(runtime);
	const counterMod = await loadModFiles("counter-panel");
	const counter = runtime.loadMod(counterMod.manifest, { fragmentSources: counterMod.sources });

	appState.counter.value = 0;
	const handlers = counterMod.manifest.fragments[0].handlers;

	function frame(root) {
		const result = counter.updateBindings({ counter: { value: appState.counter.value } })[0];
		root.innerHTML = result.html;
		applyVisibility(root, result.visibility);
		const ops = runtime.fireFragmentHook("counter-display", "update", { value: appState.counter.value });
		applyOps(root, ops);
		return { result, ops };
	}

	const root = makeRoot();
	frame(root);
	assert.equal(root.querySelector(".counter-value").textContent, "0");
	assert.equal(root.querySelector(".milestone").hasAttribute("hidden"), true);

	const teardown = wireHandlers(root, handlers, dispatch);
	for (let i = 0; i < 5; i++) {
		root.querySelector(".increment-btn").dispatchEvent(new FakeEvent("click"));
	}
	teardown();

	assert.equal(appState.counter.value, 5);

	frame(root);
	assert.equal(root.querySelector(".counter-value").textContent, "5");
	assert.equal(root.querySelector(".milestone").hasAttribute("hidden"), false);
	assert.equal(root.querySelector(".counter-panel").classList.contains("celebrate"), true);

	runtime.dispose();
});

test("declared fragment handler invokes the named export through the host", async () => {
	const runtime = createRuntime(["ui-mount"]);
	const dispatch = makeDispatch(runtime);
	const counterMod = await loadModFiles("counter-panel");
	runtime.loadMod(counterMod.manifest, { fragmentSources: counterMod.sources });

	appState.counter.value = 0;
	const returned = dispatch({ handler: "onIncrement", selector: ".increment-btn", on: "click" });
	assert.equal(returned, 1);
	assert.equal(appState.counter.value, 1);

	runtime.dispose();
});
