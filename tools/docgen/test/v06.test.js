import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateDocs } from "../dist/index.js";

function findPage(result, slug) {
	return result.pages.find((p) => p.slug === slug);
}

describe("top-level events catalog docs", () => {
	it("renders an Events section listing id, payload, and description", () => {
		const result = generateDocs({
			xript: "0.6",
			name: "host",
			types: { TabPayload: { description: "Tab payload.", fields: { id: { type: "string" } } } },
			events: [
				{ id: "tab.opened", description: "Fired when a tab opens.", payload: "TabPayload" },
				{ id: "app.ready", description: "Fired once the app finishes booting." },
			],
		});
		const index = findPage(result, "index");
		assert.match(index.content, /## Events/);
		assert.match(index.content, /\| Event \| Payload \| Description \|/);
		assert.match(index.content, /\| `tab\.opened` \| `TabPayload` \| Fired when a tab opens\. \|/);
		assert.match(index.content, /\| `app\.ready` \| — \| Fired once the app finishes booting\. \|/);
	});

	it("draws the line between events, event-typed slots, and fragment handlers", () => {
		const result = generateDocs({
			xript: "0.6",
			name: "host",
			events: [{ id: "tick", description: "Heartbeat." }],
		});
		const index = findPage(result, "index");
		assert.match(index.content, /discovery declaration/);
		assert.match(index.content, /no consumer presupposed/);
		assert.match(index.content, /what you can call/);
		assert.match(index.content, /what the host emits/);
		assert.match(index.content, /application\/x-xript-hook/);
	});

	it("omits the Events section when no events are declared", () => {
		const result = generateDocs({ xript: "0.6", name: "host" });
		const index = findPage(result, "index");
		assert.ok(!index.content.includes("## Events"));
	});
});

describe("fragment handlers docs", () => {
	it("renders a Fragment Handlers section with selector, event, and handler columns", () => {
		const result = generateDocs({
			xript: "0.6",
			name: "mod",
			fills: {
				"sidebar.left": [
					{
						format: "text/html",
						source: "panel.html",
						handlers: [{ selector: "[data-action='heal']", on: "click", handler: "onHealClicked" }],
					},
				],
			},
		});
		const index = findPage(result, "index");
		assert.match(index.content, /## Fragment Handlers/);
		assert.match(index.content, /### `sidebar\.left`/);
		assert.match(index.content, /\| Selector \| Event \| Handler \|/);
		assert.match(index.content, /\| `\[data-action='heal'\]` \| `click` \| `onHealClicked` \|/);
	});

	it("labels a fill with its id when present", () => {
		const result = generateDocs({
			xript: "0.6",
			name: "mod",
			fills: {
				"header.status": [
					{
						id: "clock",
						format: "text/html",
						source: "clock.html",
						handlers: [{ selector: ".clock", on: "click", handler: "onClockClick" }],
					},
				],
			},
		});
		const index = findPage(result, "index");
		assert.match(index.content, /### `header\.status` \(`clock`\)/);
	});

	it("accepts the deprecated events alias and flags it with a migration note", () => {
		const result = generateDocs({
			xript: "0.6",
			name: "mod",
			fills: {
				"sidebar.left": [
					{
						format: "text/html",
						source: "panel.html",
						events: [{ selector: ".btn", on: "click", handler: "onClick" }],
					},
				],
			},
		});
		const index = findPage(result, "index");
		assert.match(index.content, /## Fragment Handlers/);
		assert.match(index.content, /\*\*Deprecated:\*\*/);
		assert.match(index.content, /deprecated alias for `handlers`/);
		assert.match(index.content, /\| `\.btn` \| `click` \| `onClick` \|/);
	});

	it("prefers handlers over events when both are present and emits no deprecation note", () => {
		const result = generateDocs({
			xript: "0.6",
			name: "mod",
			fills: {
				"sidebar.left": [
					{
						format: "text/html",
						source: "panel.html",
						handlers: [{ selector: ".new", on: "click", handler: "newHandler" }],
						events: [{ selector: ".old", on: "click", handler: "oldHandler" }],
					},
				],
			},
		});
		const index = findPage(result, "index");
		assert.match(index.content, /\| `\.new` \| `click` \| `newHandler` \|/);
		assert.ok(!index.content.includes("oldHandler"));
		assert.ok(!index.content.includes("**Deprecated:**"));
	});

	it("omits the Fragment Handlers section when no fill declares handlers", () => {
		const result = generateDocs({
			xript: "0.6",
			name: "mod",
			fills: { "sidebar.left": [{ format: "text/html", source: "panel.html" }] },
		});
		const index = findPage(result, "index");
		assert.ok(!index.content.includes("## Fragment Handlers"));
	});
});
