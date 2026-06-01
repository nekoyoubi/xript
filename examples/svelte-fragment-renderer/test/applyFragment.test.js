import { test } from "node:test";
import assert from "node:assert/strict";
import { applyVisibility, applyOp, applyOps, wireEvents } from "../src/lib/applyFragment.js";
import { makeRoot, FakeEvent } from "./dom-shim.js";

test("applyVisibility hides regions whose data-if flag is false", () => {
	const root = makeRoot(
		'<div class="a" data-if="x < 50">low</div><div class="b" data-if="x < 20">crit</div>',
	);
	applyVisibility(root, { "x < 50": true, "x < 20": false });
	assert.equal(root.querySelector(".a").hasAttribute("hidden"), false);
	assert.equal(root.querySelector(".b").hasAttribute("hidden"), true);
});

test("applyVisibility re-shows a region when its flag flips back to true", () => {
	const root = makeRoot('<div class="warn" data-if="x < 50" hidden>low</div>');
	applyVisibility(root, { "x < 50": true });
	assert.equal(root.querySelector(".warn").hasAttribute("hidden"), false);
});

test("applyVisibility ignores expressions the runtime did not report", () => {
	const root = makeRoot('<div class="warn" data-if="x < 50" hidden>low</div>');
	applyVisibility(root, { "y > 0": true });
	assert.equal(root.querySelector(".warn").hasAttribute("hidden"), true);
});

test("applyOp setText sets element text", () => {
	const root = makeRoot('<span class="v">old</span>');
	applyOp(root, { op: "setText", selector: ".v", value: 42 });
	assert.equal(root.querySelector(".v").textContent, "42");
});

test("applyOp setAttr sets the named attribute", () => {
	const root = makeRoot('<div class="bar">x</div>');
	applyOp(root, { op: "setAttr", selector: ".bar", attr: "data-color", value: "red" });
	assert.equal(root.querySelector(".bar").getAttribute("data-color"), "red");
});

test("applyOp toggle hides on falsy and shows on truthy", () => {
	const root = makeRoot('<div class="c">x</div>');
	applyOp(root, { op: "toggle", selector: ".c", value: false });
	assert.equal(root.querySelector(".c").hasAttribute("hidden"), true);
	applyOp(root, { op: "toggle", selector: ".c", value: true });
	assert.equal(root.querySelector(".c").hasAttribute("hidden"), false);
});

test("applyOp addClass and removeClass mutate classList", () => {
	const root = makeRoot('<div class="p">x</div>');
	applyOp(root, { op: "addClass", selector: ".p", value: "celebrate" });
	assert.equal(root.querySelector(".p").classList.contains("celebrate"), true);
	applyOp(root, { op: "removeClass", selector: ".p", value: "celebrate" });
	assert.equal(root.querySelector(".p").classList.contains("celebrate"), false);
});

test("applyOp replaceChildren joins an array of html strings", () => {
	const root = makeRoot('<ul class="list"></ul>');
	applyOp(root, { op: "replaceChildren", selector: ".list", value: ["<li>a</li>", "<li>b</li>"] });
	const items = root.querySelectorAll("li");
	assert.equal(items.length, 2);
	assert.equal(items[0].textContent, "a");
	assert.equal(items[1].textContent, "b");
});

test("applyOp ignores an unknown op kind without throwing", () => {
	const root = makeRoot('<div class="c">x</div>');
	assert.doesNotThrow(() => applyOp(root, { op: "futureOp", selector: ".c", value: 1 }));
});

test("applyOps applies the buffer in order", () => {
	const root = makeRoot('<div class="c">x</div>');
	applyOps(root, [
		{ op: "setText", selector: ".c", value: "first" },
		{ op: "setText", selector: ".c", value: "second" },
	]);
	assert.equal(root.querySelector(".c").textContent, "second");
});

test("wireEvents dispatches declared events out to the host callback", () => {
	const root = makeRoot('<button class="increment-btn" type="button">+1</button>');
	const dispatched = [];
	wireEvents(
		root,
		[{ selector: ".increment-btn", on: "click", handler: "onIncrement" }],
		(detail) => dispatched.push(detail),
	);
	root.querySelector(".increment-btn").dispatchEvent(new FakeEvent("click"));
	assert.equal(dispatched.length, 1);
	assert.equal(dispatched[0].handler, "onIncrement");
	assert.equal(dispatched[0].on, "click");
});

test("wireEvents teardown removes the listeners", () => {
	const root = makeRoot('<button class="increment-btn" type="button">+1</button>');
	const dispatched = [];
	const teardown = wireEvents(
		root,
		[{ selector: ".increment-btn", on: "click", handler: "onIncrement" }],
		(detail) => dispatched.push(detail),
	);
	teardown();
	root.querySelector(".increment-btn").dispatchEvent(new FakeEvent("click"));
	assert.equal(dispatched.length, 0);
});

test("renderer never executes fragment markup: html is injected as inert text", () => {
	const root = makeRoot();
	root.innerHTML = '<div class="counter-value">7</div>';
	applyVisibility(root, {});
	applyOps(root, []);
	assert.equal(root.querySelector(".counter-value").textContent, "7");
});
