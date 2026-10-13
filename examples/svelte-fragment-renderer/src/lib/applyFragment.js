/**
 * Framework-agnostic core of the Svelte fragment renderer.
 *
 * These functions take the runtime's already-resolved, already-sanitized
 * fragment output and apply it to a DOM root. They contain zero Svelte
 * specifics so they can be unit-tested against any DOM-like root and reused
 * by the `<Fragment>` component, a vanilla host, or any other view layer.
 *
 * The fragment stays inert throughout: this module reads plain data
 * (`{ html, visibility }` and `FragmentOp[]`) and mutates the DOM. It never
 * evaluates fragment-authored code.
 *
 * @typedef {Object} FragmentResult
 * @property {string} fragmentId
 * @property {string} html        Runtime-sanitized markup.
 * @property {Record<string, boolean>} visibility  Keyed by `data-if` expression. Deprecated.
 * @property {{ path: number[], expression: string, visible: boolean }[]} [conditions]  Keyed by tree position.
 *
 * @typedef {Object} FragmentOp
 * @property {"toggle"|"addClass"|"removeClass"|"setText"|"setProp"|"setAttr"|"removeAttr"|"replaceChildren"} op
 * @property {string} selector
 * @property {unknown} [value]
 * @property {string} [prop]
 * @property {string} [attr]
 *
 * @typedef {Object} FragmentHandlerDeclaration
 * @property {string} selector
 * @property {string} on
 * @property {string} handler
 */

/**
 * Apply `data-if` visibility flags to the rendered DOM.
 *
 * The runtime reports visibility keyed by the original `data-if` expression,
 * and the elements keep that expression in their `data-if` attribute. We match
 * element to flag by attribute value (whitespace-normalized to be robust to
 * formatting) and hide non-visible regions with `hidden`.
 *
 * @param {Element} root
 * @param {Record<string, boolean>} visibility
 */
export function applyVisibility(root, visibility) {
	if (!root || !visibility) return;
	const flags = {};
	for (const key of Object.keys(visibility)) {
		flags[normalizeExpr(key)] = visibility[key];
	}
	const conditional = root.querySelectorAll("[data-if]");
	for (const el of conditional) {
		const expr = el.getAttribute("data-if");
		if (expr == null) continue;
		const visible = flags[normalizeExpr(expr)];
		if (visible === undefined) continue;
		setHidden(el, !visible);
	}
}

/**
 * Apply `data-if` results by tree position, the successor to `applyVisibility`.
 *
 * Expression-keyed visibility cannot tell two nodes with the same `data-if`
 * apart, and every copy of a `data-each` template carries the same expression
 * with a different answer. `conditions` addresses each node by its child-index
 * path, which this walks against the mounted `html`'s child nodes. That holds
 * for markup an HTML parser does not restructure; a `table` without `tbody`
 * is the known exception, and a host rendering tables builds its DOM from
 * `tree` instead.
 *
 * @param {Element} root
 * @param {{ path: number[], visible: boolean }[]} conditions
 */
export function applyConditions(root, conditions) {
	if (!root || !Array.isArray(conditions)) return;
	for (const condition of conditions) {
		let node = root;
		for (const index of condition.path) {
			node = node?.childNodes?.[index];
		}
		if (node && typeof node.setAttribute === "function") setHidden(node, !condition.visible);
	}
}

/**
 * Apply whichever visibility report the result carries: path-keyed
 * `conditions` when present, the deprecated `visibility` map otherwise.
 *
 * @param {Element} root
 * @param {FragmentResult} fragment
 */
export function applyFragmentVisibility(root, fragment) {
	if (Array.isArray(fragment?.conditions)) applyConditions(root, fragment.conditions);
	else applyVisibility(root, fragment?.visibility ?? {});
}

/**
 * Apply a single command-buffer op to the DOM. Unknown ops are ignored
 * (forward-compatible with op kinds a newer runtime might emit).
 *
 * Every write reads first: setting a value an element already holds still
 * fires mutation observers and restarts transitions, so an op that would not
 * change anything does not touch the DOM. `toggle` is a set, not a flip; it
 * reads `op.value` and never the element's current state.
 *
 * @param {Element} root
 * @param {FragmentOp} op
 */
export function applyOp(root, op) {
	if (!root || !op || typeof op.selector !== "string") return;
	const targets = root.querySelectorAll(op.selector);
	for (const el of targets) {
		switch (op.op) {
			case "toggle":
				if (typeof op.value === "boolean") setHidden(el, !op.value);
				break;
			case "addClass":
				if (!el.classList.contains(String(op.value))) el.classList.add(String(op.value));
				break;
			case "removeClass":
				if (el.classList.contains(String(op.value))) el.classList.remove(String(op.value));
				break;
			case "setText": {
				const text = stringifyValue(op.value);
				if (el.textContent !== text) el.textContent = text;
				break;
			}
			case "setProp":
			case "setAttr":
				setAttribute(el, attributeName(op), op.value);
				break;
			case "removeAttr":
				setAttribute(el, attributeName(op), null);
				break;
			case "replaceChildren":
				el.innerHTML = childrenToHtml(op.value);
				break;
			default:
				break;
		}
	}
}

/**
 * Apply the full command buffer in order. Later ops see the DOM left by
 * earlier ops, matching how the runtime emits a sequenced buffer.
 *
 * @param {Element} root
 * @param {FragmentOp[]} ops
 */
export function applyOps(root, ops) {
	if (!Array.isArray(ops)) return;
	for (const op of ops) {
		applyOp(root, op);
	}
}

/**
 * Wire declared fragment handlers to a host dispatch callback and return a
 * teardown function. The renderer attaches the listeners; the *behavior* runs
 * in the sandbox — `dispatch` is expected to route into
 * `runtime.fireFragmentHook` / `runtime.invokeExport`, never to execute
 * fragment-authored code in the page.
 *
 * @param {Element} root
 * @param {FragmentHandlerDeclaration[]} handlers
 * @param {(detail: { handler: string, selector: string, on: string, event: Event }) => void} dispatch
 * @returns {() => void} teardown
 */
export function wireHandlers(root, handlers, dispatch) {
	if (!root || !Array.isArray(handlers) || typeof dispatch !== "function") {
		return () => {};
	}
	const bound = [];
	for (const decl of handlers) {
		if (!decl || typeof decl.selector !== "string" || typeof decl.on !== "string") continue;
		const targets = root.querySelectorAll(decl.selector);
		for (const el of targets) {
			const listener = (event) => {
				dispatch({ handler: decl.handler, selector: decl.selector, on: decl.on, event });
			};
			el.addEventListener(decl.on, listener);
			bound.push({ el, type: decl.on, listener });
		}
	}
	return () => {
		for (const b of bound) {
			b.el.removeEventListener(b.type, b.listener);
		}
	};
}

function setHidden(el, hidden) {
	if (hidden && !el.hasAttribute("hidden")) {
		el.setAttribute("hidden", "");
	} else if (!hidden && el.hasAttribute("hidden")) {
		el.removeAttribute("hidden");
	}
}

/** `setAttr` is the deprecated alias of `setProp` and emits `prop` alongside `attr`, so read either. */
function attributeName(op) {
	return typeof op.prop === "string" ? op.prop : op.attr;
}

/**
 * An attribute has no `false`: HTML reads presence, so `false`, `null`, and a
 * missing value remove it rather than writing the string "false". Event-handler
 * attributes are refused here too, since a host can hand this applier ops the
 * runtime never filtered.
 */
function setAttribute(el, name, value) {
	if (typeof name !== "string" || /^on/i.test(name)) return;
	if (value === false || value === null || value === undefined) {
		if (el.hasAttribute(name)) el.removeAttribute(name);
		return;
	}
	const text = String(value);
	if (el.getAttribute(name) !== text) el.setAttribute(name, text);
}

function normalizeExpr(expr) {
	return String(expr).replace(/\s+/g, " ").trim();
}

function stringifyValue(value) {
	if (value == null) return "";
	return String(value);
}

/**
 * `replaceChildren` carries markup, a list of markup strings (concatenated in
 * order), or a J5ML node list. The runtime already sanitized all three; a node
 * list still has to be serialized with its text and attribute values escaped.
 */
function childrenToHtml(value) {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return "";
	if (value.every((item) => typeof item === "string")) return value.join("");
	return value.map(jsmlToHtml).join("");
}

function jsmlToHtml(node) {
	if (typeof node === "string") return escapeText(node);
	if (!Array.isArray(node) || typeof node[0] !== "string") return "";
	const [name, ...rest] = node;
	const hasAttrs = rest.length > 0 && rest[0] !== null && typeof rest[0] === "object" && !Array.isArray(rest[0]);
	const attrs = Object.entries(hasAttrs ? rest[0] : {})
		.filter(([, value]) => value !== false && value !== null && value !== undefined)
		.map(([key, value]) => ` ${key}="${escapeAttr(value === true ? "" : String(value))}"`)
		.join("");
	const children = (hasAttrs ? rest.slice(1) : rest).map(jsmlToHtml).join("");
	return `<${name}${attrs}>${children}</${name}>`;
}

function escapeText(text) {
	return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(text) {
	return escapeText(text).replace(/"/g, "&quot;");
}
