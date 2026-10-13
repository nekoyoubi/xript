import { htmlToTree, type FragmentNode, type JsmlNode } from "@xriptjs/sanitize";
import { FRAGMENT_APPLIER_CASES } from "./applier-cases.js";
import type { FragmentOp } from "./sandbox.js";

/** One row of `spec/fragment-applier-tests.json`. */
export interface FragmentApplierCase {
	description: string;
	/** The applier defect this case exists to catch. */
	because: string;
	/** The container's children before the ops run, as J5ML. */
	dom: JsmlNode[];
	ops: FragmentOp[];
	expected: { dom: JsmlNode[]; writes: number };
}

/**
 * How the runner drives an applier that does not work against a DOM: it mounts the
 * case's starting children, applies the ops, reads the children back as J5ML, and
 * reports how many mutating writes the applier performed.
 */
export interface FragmentApplierAdapter<Root> {
	mount(dom: JsmlNode[]): Root;
	apply(root: Root, ops: FragmentOp[]): void;
	snapshot(root: Root): JsmlNode[];
	writes(root: Root): number;
}

/** An applier that works against a DOM element; the runner hands it a {@link ConformanceElement}. */
export type FragmentDomApplier = (root: ConformanceElement, ops: FragmentOp[]) => void;

export interface FragmentApplierFailure {
	description: string;
	because: string;
	reason: string;
	expected: { dom: JsmlNode[]; writes: number };
	actual?: { dom: JsmlNode[]; writes: number };
}

export interface FragmentApplierReport {
	total: number;
	passed: number;
	failures: FragmentApplierFailure[];
}

export interface FragmentApplierConformanceOptions {
	/** Replaces the shipped table, e.g. to run a host's own extra cases. */
	cases?: FragmentApplierCase[];
}

/**
 * Runs the fragment applier conformance table against a host's applier.
 *
 * Pass a function to have it applied to a minimal, write-counting DOM
 * ({@link createConformanceDom}) that implements the element surface an applier
 * normally touches. Pass a {@link FragmentApplierAdapter} to drive an applier over
 * anything else, a virtual DOM or a native widget tree, with the host doing the
 * mounting, reading back, and write counting.
 *
 * Never throws for a failing applier; every failure is reported with the case's
 * `because`, so a host can assert `report.failures` is empty in its own tests.
 */
export function runFragmentApplierConformance(
	applier: FragmentDomApplier | FragmentApplierAdapter<unknown>,
	options: FragmentApplierConformanceOptions = {},
): FragmentApplierReport {
	const adapter: FragmentApplierAdapter<unknown> = typeof applier === "function"
		? domAdapter(applier) as FragmentApplierAdapter<unknown>
		: applier;
	const cases = options.cases ?? FRAGMENT_APPLIER_CASES;
	const failures: FragmentApplierFailure[] = [];

	for (const testCase of cases) {
		const base = { description: testCase.description, because: testCase.because, expected: testCase.expected };
		let actual: { dom: JsmlNode[]; writes: number };
		try {
			const root = adapter.mount(structuredClone(testCase.dom));
			const writesBefore = adapter.writes(root);
			adapter.apply(root, structuredClone(testCase.ops));
			actual = { dom: adapter.snapshot(root), writes: adapter.writes(root) - writesBefore };
		} catch (error) {
			failures.push({ ...base, reason: `applier threw: ${error instanceof Error ? error.message : String(error)}` });
			continue;
		}

		const expectedDom = JSON.stringify(normalizeJsml(testCase.expected.dom));
		const actualDom = JSON.stringify(normalizeJsml(actual.dom));
		if (expectedDom !== actualDom) {
			failures.push({ ...base, actual, reason: `dom: expected ${expectedDom}, got ${actualDom}` });
		} else if (actual.writes !== testCase.expected.writes) {
			failures.push({ ...base, actual, reason: `writes: expected ${testCase.expected.writes}, got ${actual.writes}` });
		}
	}

	return { total: cases.length, passed: cases.length - failures.length, failures };
}

function domAdapter(apply: FragmentDomApplier): FragmentApplierAdapter<ConformanceElement> {
	return {
		mount: createConformanceDom,
		apply,
		snapshot: (root) => root.childNodes.map(nodeToJsml),
		writes: (root) => root.ownerDocument.writes,
	};
}

/**
 * The comparison the table is defined under: attributes as a set, `class` as a set of
 * tokens with an empty one dropped, `hidden` by presence, adjacent text merged and empty
 * text dropped.
 */
export function normalizeJsml(nodes: JsmlNode[]): JsmlNode[] {
	const out: JsmlNode[] = [];
	for (const node of nodes) {
		if (typeof node === "string") {
			if (node === "") continue;
			const last = out[out.length - 1];
			if (typeof last === "string") out[out.length - 1] = last + node;
			else out.push(node);
			continue;
		}
		const [name, ...rest] = node;
		const hasAttrs = rest.length > 0 && isAttrs(rest[0]);
		const attrs = hasAttrs ? (rest[0] as Record<string, unknown>) : {};
		const children = (hasAttrs ? rest.slice(1) : rest) as JsmlNode[];
		const normalized: Record<string, string> = {};
		for (const key of Object.keys(attrs).sort()) {
			let value = attrs[key] === true ? "" : String(attrs[key]);
			if (key === "class") {
				value = [...new Set(value.split(/\s+/).filter(Boolean))].sort().join(" ");
				if (value === "") continue;
			}
			if (key === "hidden") value = "";
			normalized[key] = value;
		}
		const element: JsmlNode = [name.toLowerCase()];
		if (Object.keys(normalized).length > 0) element.push(normalized);
		element.push(...normalizeJsml(children));
		out.push(element);
	}
	return out;
}

function isAttrs(value: unknown): boolean {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The document a conformance DOM's nodes belong to. Counts writes to connected nodes. */
export class ConformanceDocument {
	writes = 0;
	readonly container: ConformanceElement;

	constructor() {
		this.container = new ConformanceElement(this, "div");
	}

	createElement(name: string): ConformanceElement {
		return new ConformanceElement(this, name);
	}

	createTextNode(data: string): ConformanceText {
		return new ConformanceText(this, String(data));
	}

	/** @internal */
	recordWrite(node: ConformanceNode): void {
		if (node.isConnected) this.writes += 1;
	}
}

/** A node in a conformance DOM. */
export abstract class ConformanceNode {
	parentNode: ConformanceElement | null = null;

	constructor(readonly ownerDocument: ConformanceDocument) {}

	abstract get textContent(): string;
	abstract set textContent(value: string);

	get isConnected(): boolean {
		let node: ConformanceNode | null = this;
		while (node) {
			if (node === this.ownerDocument.container) return true;
			node = node.parentNode;
		}
		return false;
	}
}

/** A text node in a conformance DOM. */
export class ConformanceText extends ConformanceNode {
	readonly nodeType = 3;

	constructor(ownerDocument: ConformanceDocument, public data: string) {
		super(ownerDocument);
	}

	get textContent(): string {
		return this.data;
	}

	set textContent(value: string) {
		this.data = String(value);
		this.ownerDocument.recordWrite(this);
	}

	get nodeValue(): string {
		return this.data;
	}
}

/** The `classList` of a {@link ConformanceElement}. Every add and remove call is a write. */
export class ConformanceClassList {
	constructor(private readonly element: ConformanceElement) {}

	private tokens(): string[] {
		return (this.element.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
	}

	contains(token: string): boolean {
		return this.tokens().includes(token);
	}

	add(...tokens: string[]): void {
		const next = this.tokens();
		for (const token of tokens) if (!next.includes(token)) next.push(token);
		this.element.setAttribute("class", next.join(" "));
	}

	remove(...tokens: string[]): void {
		this.element.setAttribute("class", this.tokens().filter((token) => !tokens.includes(token)).join(" "));
	}

	toggle(token: string, force?: boolean): boolean {
		const present = this.contains(token);
		const want = force ?? !present;
		if (want) this.add(token);
		else this.remove(token);
		return want;
	}

	get length(): number {
		return this.tokens().length;
	}

	get value(): string {
		return this.tokens().join(" ");
	}
}

/**
 * A minimal, write-counting element: the surface a fragment applier normally touches
 * (`querySelectorAll`, attributes, `classList`, `hidden`, `textContent`, `innerHTML`,
 * `replaceChildren`, `appendChild`), and nothing it does not.
 */
export class ConformanceElement extends ConformanceNode {
	readonly nodeType = 1;
	readonly localName: string;
	readonly classList: ConformanceClassList;
	childNodes: ConformanceNode[] = [];
	private readonly attrs = new Map<string, string>();

	constructor(ownerDocument: ConformanceDocument, name: string) {
		super(ownerDocument);
		this.localName = name.toLowerCase();
		this.classList = new ConformanceClassList(this);
	}

	get tagName(): string {
		return this.localName.toUpperCase();
	}

	get id(): string {
		return this.getAttribute("id") ?? "";
	}

	get children(): ConformanceElement[] {
		return this.childNodes.filter((node): node is ConformanceElement => node instanceof ConformanceElement);
	}

	get attributeNames(): string[] {
		return [...this.attrs.keys()];
	}

	getAttributeNames(): string[] {
		return this.attributeNames;
	}

	getAttribute(name: string): string | null {
		return this.attrs.get(name.toLowerCase()) ?? null;
	}

	hasAttribute(name: string): boolean {
		return this.attrs.has(name.toLowerCase());
	}

	setAttribute(name: string, value: unknown): void {
		this.attrs.set(name.toLowerCase(), String(value));
		this.ownerDocument.recordWrite(this);
	}

	removeAttribute(name: string): void {
		if (!this.attrs.delete(name.toLowerCase())) return;
		this.ownerDocument.recordWrite(this);
	}

	toggleAttribute(name: string, force?: boolean): boolean {
		const want = force ?? !this.hasAttribute(name);
		if (want && !this.hasAttribute(name)) this.setAttribute(name, "");
		if (!want) this.removeAttribute(name);
		return want;
	}

	get hidden(): boolean {
		return this.hasAttribute("hidden");
	}

	set hidden(value: boolean) {
		if (value) this.setAttribute("hidden", "");
		else this.removeAttribute("hidden");
	}

	get textContent(): string {
		return this.childNodes.map((node) => node.textContent).join("");
	}

	set textContent(value: string) {
		this.setChildren(value === "" ? [] : [this.ownerDocument.createTextNode(String(value))]);
		this.ownerDocument.recordWrite(this);
	}

	get innerHTML(): string {
		return this.childNodes.map(nodeToHtml).join("");
	}

	set innerHTML(markup: string) {
		this.setChildren(htmlToTree(String(markup)).map((node) => treeNodeToDom(this.ownerDocument, node)));
		this.ownerDocument.recordWrite(this);
	}

	replaceChildren(...nodes: (ConformanceNode | string)[]): void {
		this.setChildren(nodes.map((node) => typeof node === "string" ? this.ownerDocument.createTextNode(node) : node));
		this.ownerDocument.recordWrite(this);
	}

	appendChild<T extends ConformanceNode>(node: T): T {
		this.adopt(node);
		this.childNodes.push(node);
		this.ownerDocument.recordWrite(this);
		return node;
	}

	append(...nodes: (ConformanceNode | string)[]): void {
		for (const node of nodes) {
			this.appendChild(typeof node === "string" ? this.ownerDocument.createTextNode(node) : node);
		}
	}

	querySelectorAll(selector: string): ConformanceElement[] {
		const groups = selector.split(",").map((group) => parseSelector(group.trim()));
		const matches: ConformanceElement[] = [];
		const walk = (element: ConformanceElement) => {
			for (const child of element.children) {
				if (groups.some((group) => matchesChain(child, group, this))) matches.push(child);
				walk(child);
			}
		};
		walk(this);
		return matches;
	}

	querySelector(selector: string): ConformanceElement | null {
		return this.querySelectorAll(selector)[0] ?? null;
	}

	getElementById(id: string): ConformanceElement | null {
		return this.querySelectorAll("*").find((element) => element.id === id) ?? null;
	}

	matches(selector: string): boolean {
		return selector.split(",").some((group) => matchesChain(this, parseSelector(group.trim()), null));
	}

	private setChildren(nodes: ConformanceNode[]): void {
		for (const node of this.childNodes) node.parentNode = null;
		this.childNodes = [];
		for (const node of nodes) {
			this.adopt(node);
			this.childNodes.push(node);
		}
	}

	private adopt(node: ConformanceNode): void {
		if (node.parentNode) {
			node.parentNode.childNodes = node.parentNode.childNodes.filter((child) => child !== node);
		}
		node.parentNode = this;
	}

	/** @internal Builds an attribute without counting it as a write. */
	initAttribute(name: string, value: string): void {
		this.attrs.set(name.toLowerCase(), value);
	}

	/** @internal Builds a child without counting it as a write. */
	initChild(node: ConformanceNode): void {
		this.adopt(node);
		this.childNodes.push(node);
	}
}

/**
 * Builds a conformance DOM whose container holds `dom`, given as J5ML. Building it is
 * not counted; every mutation afterwards is.
 */
export function createConformanceDom(dom: JsmlNode[]): ConformanceElement {
	const document = new ConformanceDocument();
	for (const node of dom) document.container.initChild(jsmlToDom(document, node));
	return document.container;
}

function jsmlToDom(document: ConformanceDocument, node: JsmlNode): ConformanceNode {
	if (typeof node === "string") return document.createTextNode(node);
	const [name, ...rest] = node;
	const element = document.createElement(name);
	let children = rest;
	if (rest.length > 0 && isAttrs(rest[0])) {
		for (const [key, value] of Object.entries(rest[0] as Record<string, unknown>)) {
			element.initAttribute(key, value === true ? "" : String(value));
		}
		children = rest.slice(1);
	}
	for (const child of children as JsmlNode[]) element.initChild(jsmlToDom(document, child));
	return element;
}

function treeNodeToDom(document: ConformanceDocument, node: FragmentNode): ConformanceNode {
	if (node.kind === "text") return document.createTextNode(node.value);
	const element = document.createElement(node.name);
	for (const [key, value] of Object.entries(node.props)) {
		if (value === false || value === null) continue;
		element.initAttribute(key, value === true ? "" : String(value));
	}
	for (const child of node.children) element.initChild(treeNodeToDom(document, child));
	return element;
}

function nodeToJsml(node: ConformanceNode): JsmlNode {
	if (node instanceof ConformanceText) return node.data;
	const element = node as ConformanceElement;
	const out: JsmlNode = [element.localName];
	if (element.attributeNames.length > 0) {
		const attrs: Record<string, string> = {};
		for (const name of element.attributeNames) attrs[name] = element.getAttribute(name) as string;
		out.push(attrs);
	}
	for (const child of element.childNodes) out.push(nodeToJsml(child));
	return out;
}

function escapeText(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function nodeToHtml(node: ConformanceNode): string {
	if (node instanceof ConformanceText) return escapeText(node.data);
	const element = node as ConformanceElement;
	const attrs = element.attributeNames
		.map((name) => ` ${name}="${escapeText(element.getAttribute(name) as string).replace(/"/g, "&quot;")}"`)
		.join("");
	return `<${element.localName}${attrs}>${element.childNodes.map(nodeToHtml).join("")}</${element.localName}>`;
}

interface Compound {
	tag?: string;
	ids: string[];
	classes: string[];
	attrs: { name: string; value?: string }[];
}

interface ChainLink {
	compound: Compound;
	combinator: " " | ">";
}

const COMPOUND_PART = /^(\*|[A-Za-z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[\s*([\w:-]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+))\s*)?\]/y;

function parseSelector(selector: string): ChainLink[] {
	const tokens = selector.replace(/\s*>\s*/g, " > ").split(/\s+/).filter(Boolean);
	const chain: ChainLink[] = [];
	let combinator: " " | ">" = " ";
	for (const token of tokens) {
		if (token === ">") {
			combinator = ">";
			continue;
		}
		chain.push({ compound: parseCompound(token), combinator });
		combinator = " ";
	}
	if (chain.length === 0) throw new Error(`conformance DOM cannot parse selector "${selector}"`);
	return chain;
}

function parseCompound(token: string): Compound {
	const compound: Compound = { ids: [], classes: [], attrs: [] };
	let index = 0;
	let first = true;
	while (index < token.length) {
		COMPOUND_PART.lastIndex = index;
		const match = COMPOUND_PART.exec(token);
		if (!match || match[0].length === 0 || (match[1] !== undefined && !first)) {
			throw new Error(`conformance DOM does not support selector "${token}"`);
		}
		if (match[1] !== undefined && match[1] !== "*") compound.tag = match[1].toLowerCase();
		if (match[2] !== undefined) compound.ids.push(match[2]);
		if (match[3] !== undefined) compound.classes.push(match[3]);
		if (match[4] !== undefined) compound.attrs.push({ name: match[4].toLowerCase(), value: match[5] ?? match[6] ?? match[7] });
		index += match[0].length;
		first = false;
	}
	return compound;
}

function matchesCompound(element: ConformanceElement, compound: Compound): boolean {
	if (compound.tag && element.localName !== compound.tag) return false;
	if (compound.ids.some((id) => element.id !== id)) return false;
	if (compound.classes.some((name) => !element.classList.contains(name))) return false;
	return compound.attrs.every((attr) => attr.value === undefined
		? element.hasAttribute(attr.name)
		: element.getAttribute(attr.name) === attr.value);
}

function matchesChain(element: ConformanceElement, chain: ChainLink[], scope: ConformanceElement | null): boolean {
	const last = chain.length - 1;
	if (!matchesCompound(element, chain[last].compound)) return false;
	if (last === 0) return true;
	const rest = chain.slice(0, last);
	const combinator = chain[last].combinator;
	let ancestor = element.parentNode;
	while (ancestor && ancestor !== scope) {
		if (matchesChain(ancestor, rest, scope)) return true;
		if (combinator === ">") return false;
		ancestor = ancestor.parentNode;
	}
	return false;
}
