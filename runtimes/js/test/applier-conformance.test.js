import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	FRAGMENT_APPLIER_CASES,
	createConformanceDom,
	runFragmentApplierConformance,
} from "../dist/index.js";

const spec = JSON.parse(
	readFileSync(fileURLToPath(new URL("../../../spec/fragment-applier-tests.json", import.meta.url)), "utf8"),
);

const OP_NAMES = ["toggle", "setText", "replaceChildren", "setProp", "setAttr", "removeAttr", "addClass", "removeClass"];

function escapeText(text) {
	return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function jsmlToHtml(node) {
	if (typeof node === "string") return escapeText(node);
	const [name, ...rest] = node;
	const hasAttrs = rest.length > 0 && typeof rest[0] === "object" && !Array.isArray(rest[0]);
	const attrs = hasAttrs ? rest[0] : {};
	const children = hasAttrs ? rest.slice(1) : rest;
	const rendered = Object.entries(attrs)
		.filter(([, value]) => value !== false && value !== null)
		.map(([key, value]) => ` ${key}="${escapeText(value === true ? "" : value).replace(/"/g, "&quot;")}"`)
		.join("");
	return `<${name}${rendered}>${children.map(jsmlToHtml).join("")}</${name}>`;
}

function childrenMarkup(value) {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return "";
	if (value.every((item) => typeof item === "string")) return value.join("");
	return value.map(jsmlToHtml).join("");
}

function setAttribute(element, name, value) {
	if (/^on/i.test(name)) return;
	if (value === false || value === null || value === undefined) {
		if (element.hasAttribute(name)) element.removeAttribute(name);
		return;
	}
	const text = String(value);
	if (element.getAttribute(name) !== text) element.setAttribute(name, text);
}

function referenceApplier(root, ops) {
	for (const op of ops) {
		if (!op || typeof op.selector !== "string") continue;
		for (const element of root.querySelectorAll(op.selector)) {
			switch (op.op) {
				case "toggle":
					if (typeof op.value !== "boolean") break;
					setAttribute(element, "hidden", op.value ? null : "");
					break;
				case "setProp":
				case "setAttr":
					setAttribute(element, op.prop ?? op.attr, op.value);
					break;
				case "removeAttr":
					setAttribute(element, op.prop ?? op.attr, null);
					break;
				case "addClass":
					if (!element.classList.contains(op.value)) element.classList.add(op.value);
					break;
				case "removeClass":
					if (element.classList.contains(op.value)) element.classList.remove(op.value);
					break;
				case "setText": {
					const text = op.value == null ? "" : String(op.value);
					if (element.textContent !== text) element.textContent = text;
					break;
				}
				case "replaceChildren":
					element.innerHTML = childrenMarkup(op.value);
					break;
			}
		}
	}
}

function naiveApplier(root, ops) {
	for (const op of ops) {
		for (const element of root.querySelectorAll(op.selector)) {
			switch (op.op) {
				case "toggle":
					if (op.value) element.removeAttribute("hidden");
					else element.setAttribute("hidden", "");
					break;
				case "setAttr":
				case "setProp":
					element.setAttribute(op.prop ?? op.attr, op.value == null ? "" : String(op.value));
					break;
				case "addClass":
					element.classList.add(op.value);
					break;
				case "removeClass":
					element.classList.remove(op.value);
					break;
				case "setText":
					element.textContent = String(op.value);
					break;
				case "replaceChildren":
					if (op.value && op.value.length) element.innerHTML = Array.isArray(op.value) ? op.value.join("") : op.value;
					break;
			}
		}
	}
}

function flippingApplier(root, ops) {
	referenceApplier(root, ops.filter((op) => op.op !== "toggle"));
	for (const op of ops) {
		if (op.op !== "toggle") continue;
		for (const element of root.querySelectorAll(op.selector)) {
			element.toggleAttribute("hidden");
		}
	}
}

const failedCases = (report) => report.failures.map((failure) => failure.description);

describe("fragment applier conformance table", () => {
	it("ships the spec table verbatim", () => {
		assert.deepEqual(FRAGMENT_APPLIER_CASES, spec.cases);
	});

	it("gives every case a because and an integer write count", () => {
		for (const testCase of spec.cases) {
			assert.ok(typeof testCase.because === "string" && testCase.because.length > 0, testCase.description);
			assert.ok(Number.isInteger(testCase.expected.writes), testCase.description);
		}
	});

	it("covers every op name", () => {
		const covered = new Set(spec.cases.flatMap((testCase) => testCase.ops.map((op) => op.op)));
		for (const name of OP_NAMES) assert.ok(covered.has(name), `no case for ${name}`);
	});

	it("repeats every same-condition toggle run an even number of times", () => {
		for (const testCase of spec.cases) {
			const toggles = testCase.ops.filter((op) => op.op === "toggle");
			if (toggles.length < 2 || !toggles.every((op) => op.value === toggles[0].value)) continue;
			assert.equal(toggles.length % 2, 0, testCase.description);
		}
	});

	it("passes the reference DOM applier on every case", () => {
		const report = runFragmentApplierConformance(referenceApplier);
		assert.deepEqual(report.failures, []);
		assert.equal(report.passed, spec.cases.length);
	});

	it("catches an applier that stringifies false, skips an empty clear, and re-writes identical values", () => {
		const failed = failedCases(runFragmentApplierConformance(naiveApplier));
		assert.ok(failed.includes("setAttr false does not leave a present attribute"));
		assert.ok(failed.includes("replaceChildren with an empty list clears"));
		assert.ok(failed.includes("setAttr repeated with the same value writes once"));
		assert.ok(failed.includes("removeAttr removes a present attribute"));
		assert.ok(failed.includes("addClass on a class already present does not write"));
	});

	it("catches an applier that flips on toggle instead of setting the condition", () => {
		const failed = failedCases(runFragmentApplierConformance(flippingApplier));
		assert.ok(failed.includes("toggle false repeated twice hides"));
		assert.ok(failed.includes("toggle true repeated twice on a hidden node shows it"));
	});

	it("reports a throwing applier as failures rather than throwing", () => {
		const report = runFragmentApplierConformance(() => {
			throw new Error("boom");
		});
		assert.equal(report.passed, 0);
		assert.match(report.failures[0].reason, /boom/);
	});

	it("drives a non-DOM applier through an adapter", () => {
		const report = runFragmentApplierConformance(
			{
				mount: (dom) => createConformanceDom(dom),
				apply: referenceApplier,
				snapshot: (root) => JSON.parse(JSON.stringify(createSnapshot(root))),
				writes: (root) => root.ownerDocument.writes,
			},
			{ cases: spec.cases.slice(0, 3) },
		);
		assert.equal(report.total, 3);
		assert.deepEqual(report.failures, []);
	});
});

describe("conformance DOM", () => {
	it("counts writes to connected nodes only, never building", () => {
		const root = createConformanceDom([["div", { id: "a", class: "x" }, "hi"]]);
		assert.equal(root.ownerDocument.writes, 0);
		const detached = root.ownerDocument.createElement("p");
		detached.setAttribute("title", "t");
		assert.equal(root.ownerDocument.writes, 0);
		root.querySelector("#a").appendChild(detached);
		assert.equal(root.ownerDocument.writes, 1);
		root.querySelector("#a").removeAttribute("missing");
		assert.equal(root.ownerDocument.writes, 1);
	});

	it("resolves compound, attribute, and descendant selectors", () => {
		const root = createConformanceDom([
			["ul", { class: "list" }, ["li", { "data-k": "1" }, "a"], ["li", "b"]],
			["li", "outside"],
		]);
		assert.equal(root.querySelectorAll(".list li").length, 2);
		assert.equal(root.querySelectorAll("ul > li[data-k='1']").length, 1);
		assert.equal(root.querySelectorAll("li").length, 3);
	});

	it("parses innerHTML into nodes and serializes text escaped", () => {
		const root = createConformanceDom([["div", { id: "a" }]]);
		root.querySelector("#a").innerHTML = "<b class=\"k\">x &amp; y</b>";
		assert.equal(root.querySelector("#a b").textContent, "x & y");
		assert.equal(root.querySelector("#a").innerHTML, "<b class=\"k\">x &amp; y</b>");
	});
});

function createSnapshot(root) {
	return root.childNodes.map(function toJsml(node) {
		if (node.nodeType === 3) return node.data;
		const attrs = {};
		for (const name of node.getAttributeNames()) attrs[name] = node.getAttribute(name);
		return [node.localName, attrs, ...node.childNodes.map(toJsml)];
	});
}
