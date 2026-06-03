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
 * @property {Record<string, boolean>} visibility  Keyed by `data-if` expression.
 *
 * @typedef {Object} FragmentOp
 * @property {"toggle"|"addClass"|"removeClass"|"setText"|"setAttr"|"replaceChildren"} op
 * @property {string} selector
 * @property {unknown} [value]
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
 * Apply a single command-buffer op to the DOM. Unknown ops are ignored
 * (forward-compatible with op kinds a newer runtime might emit).
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
				setHidden(el, !op.value);
				break;
			case "addClass":
				el.classList.add(String(op.value));
				break;
			case "removeClass":
				el.classList.remove(String(op.value));
				break;
			case "setText":
				el.textContent = stringifyValue(op.value);
				break;
			case "setAttr":
				if (typeof op.attr === "string") {
					el.setAttribute(op.attr, stringifyValue(op.value));
				}
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
	if (hidden) {
		el.setAttribute("hidden", "");
	} else {
		el.removeAttribute("hidden");
	}
}

function normalizeExpr(expr) {
	return String(expr).replace(/\s+/g, " ").trim();
}

function stringifyValue(value) {
	if (value == null) return "";
	return String(value);
}

function childrenToHtml(value) {
	if (Array.isArray(value)) return value.map(stringifyValue).join("");
	return stringifyValue(value);
}
