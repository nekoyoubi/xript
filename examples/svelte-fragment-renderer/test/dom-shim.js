/**
 * Tiny dependency-free DOM shim for testing the framework-agnostic renderer
 * core. Supports just enough of the Element surface that `applyFragment.js`
 * touches: class/attribute/tag selectors, classList, attributes, textContent,
 * innerHTML (re-parsed), and addEventListener/dispatchEvent.
 *
 * It is intentionally minimal and only used by tests; a real Svelte component
 * hands `applyFragment` a genuine `HTMLElement`.
 */

const VOID_TAGS = new Set(["br", "hr", "img", "input", "meta", "link"]);

class ClassList {
	constructor(el) {
		this.el = el;
	}
	_set() {
		return new Set((this.el.attributes.class || "").split(/\s+/).filter(Boolean));
	}
	add(name) {
		const s = this._set();
		s.add(name);
		this.el.attributes.class = [...s].join(" ");
	}
	remove(name) {
		const s = this._set();
		s.delete(name);
		this.el.attributes.class = [...s].join(" ");
	}
	contains(name) {
		return this._set().has(name);
	}
	get value() {
		return this.el.attributes.class || "";
	}
}

class TextNode {
	constructor(text) {
		this.isText = true;
		this.text = text;
	}
	get textContent() {
		return this.text;
	}
	get outerHTML() {
		return this.text;
	}
}

class FakeElement {
	constructor(tag) {
		this.isText = false;
		this.tag = tag.toLowerCase();
		this.attributes = {};
		this.childNodes = [];
		this._listeners = {};
		this.classList = new ClassList(this);
	}

	setAttribute(name, value) {
		this.attributes[name] = String(value);
	}
	getAttribute(name) {
		return name in this.attributes ? this.attributes[name] : null;
	}
	removeAttribute(name) {
		delete this.attributes[name];
	}
	hasAttribute(name) {
		return name in this.attributes;
	}

	get textContent() {
		return this.childNodes.map((c) => c.textContent).join("");
	}
	set textContent(value) {
		this.childNodes = [new TextNode(String(value))];
	}

	get innerHTML() {
		return this.childNodes.map((c) => c.outerHTML).join("");
	}
	set innerHTML(html) {
		this.childNodes = parseHtml(String(html));
	}

	get outerHTML() {
		const attrs = Object.entries(this.attributes)
			.map(([k, v]) => ` ${k}="${v}"`)
			.join("");
		return `<${this.tag}${attrs}>${this.innerHTML}</${this.tag}>`;
	}

	addEventListener(type, fn) {
		(this._listeners[type] ||= []).push(fn);
	}
	removeEventListener(type, fn) {
		this._listeners[type] = (this._listeners[type] || []).filter((f) => f !== fn);
	}
	dispatchEvent(event) {
		for (const fn of this._listeners[event.type] || []) fn(event);
	}

	_elementDescendants(acc) {
		for (const c of this.childNodes) {
			if (c.isText) continue;
			acc.push(c);
			c._elementDescendants(acc);
		}
		return acc;
	}

	querySelectorAll(selector) {
		const matchers = selector.split(",").map((s) => makeMatcher(s.trim()));
		return this._elementDescendants([]).filter((el) => matchers.some((m) => m(el)));
	}
	querySelector(selector) {
		return this.querySelectorAll(selector)[0] || null;
	}
}

function makeMatcher(selector) {
	if (selector.startsWith(".")) {
		const cls = selector.slice(1);
		return (el) => el.classList.contains(cls);
	}
	if (selector.startsWith("[") && selector.endsWith("]")) {
		const attr = selector.slice(1, -1);
		return (el) => el.hasAttribute(attr);
	}
	return (el) => el.tag === selector.toLowerCase();
}

function parseHtml(html) {
	const root = new FakeElement("#root");
	let current = root;
	const stack = [];
	let i = 0;
	const n = html.length;

	while (i < n) {
		const lt = html.indexOf("<", i);
		if (lt === -1) {
			appendText(current, html.slice(i));
			break;
		}
		if (lt > i) {
			appendText(current, html.slice(i, lt));
		}
		const gt = findTagEnd(html, lt);
		if (gt === -1) {
			appendText(current, html.slice(lt));
			break;
		}
		const tagContent = html.slice(lt + 1, gt).trim();
		i = gt + 1;

		if (tagContent.startsWith("/")) {
			const name = tagContent.slice(1).trim().toLowerCase();
			if (current.tag === name && stack.length > 0) {
				current = stack.pop();
			}
			continue;
		}

		const selfClose = tagContent.endsWith("/");
		const inner = selfClose ? tagContent.slice(0, -1).trim() : tagContent;
		const spaceIdx = firstWhitespace(inner);
		const name = (spaceIdx === -1 ? inner : inner.slice(0, spaceIdx)).toLowerCase();
		const attrStr = spaceIdx === -1 ? "" : inner.slice(spaceIdx + 1);

		const el = new FakeElement(name);
		parseAttrs(attrStr, el);
		current.childNodes.push(el);

		if (!selfClose && !VOID_TAGS.has(name)) {
			stack.push(current);
			current = el;
		}
	}

	return root.childNodes;
}

function findTagEnd(html, lt) {
	let inQuote = false;
	for (let j = lt + 1; j < html.length; j++) {
		const ch = html[j];
		if (ch === '"') inQuote = !inQuote;
		else if (ch === ">" && !inQuote) return j;
	}
	return -1;
}

function firstWhitespace(str) {
	const m = /\s/.exec(str);
	return m ? m.index : -1;
}

function decodeEntities(str) {
	return str
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&")
		.replace(/&quot;/g, '"');
}

function appendText(parent, text) {
	if (text.length === 0) return;
	parent.childNodes.push(new TextNode(decodeEntities(text)));
}

function parseAttrs(attrStr, el) {
	if (!attrStr) return;
	const re = /([\w:-]+)\s*=\s*"([^"]*)"|([\w:-]+)/g;
	let m;
	while ((m = re.exec(attrStr)) !== null) {
		if (m[1] !== undefined) {
			el.attributes[m[1]] = decodeEntities(m[2]);
		} else if (m[3] !== undefined) {
			el.attributes[m[3]] = "";
		}
	}
}

export function makeRoot(html = "") {
	const root = new FakeElement("div");
	if (html) root.innerHTML = html;
	return root;
}

export class FakeEvent {
	constructor(type) {
		this.type = type;
	}
}
