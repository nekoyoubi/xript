export const ALLOWED_ELEMENTS = new Set([
	"div", "span", "p",
	"h1", "h2", "h3", "h4", "h5", "h6",
	"ul", "ol", "li", "dl", "dt", "dd",
	"table", "thead", "tbody", "tfoot", "tr", "td", "th",
	"caption", "col", "colgroup",
	"figure", "figcaption", "blockquote", "pre", "code",
	"em", "strong", "b", "i", "u", "s", "small", "sub", "sup",
	"br", "hr",
	"img", "picture", "source", "audio", "video", "track",
	"details", "summary", "dialog",
	"canvas", "kbd", "slot",
	"section", "article", "aside", "nav",
	"header", "footer", "main",
	"a", "abbr", "mark", "time", "wbr",
	"style",
	"input", "textarea", "select", "option", "label",
	"button", "progress", "meter", "output", "fieldset", "legend",
	"svg", "g", "defs", "symbol", "use",
	"circle", "ellipse", "path", "rect", "line", "polygon", "polyline",
	"text", "tspan",
]);

export const STRIPPED_ELEMENTS = new Set([
	"script", "iframe", "object", "embed", "form",
	"base", "link", "meta", "title",
	"noscript", "applet", "frame", "frameset",
	"param",
	"foreignobject", "animate", "set",
]);

/**
 * SVG's text-content metadata elements. `title` is stripped as HTML's document
 * title, but inside an SVG it is the accessible name and tooltip primitive, and
 * `desc` is its longer description. Both are admitted only under an `<svg>`,
 * hold text alone, and carry only `SVG_TEXT_ATTRIBUTES`.
 */
export const SVG_TEXT_ELEMENTS = new Set(["title", "desc"]);

/** The attributes an SVG `title`/`desc` keeps, beyond the inert `data-*` and `aria-*`. */
export const SVG_TEXT_ATTRIBUTES = new Set(["id", "class", "lang", "dir"]);

export const UNWRAPPED_ELEMENTS = new Set([
	"html", "head", "body",
]);

export const VOID_ELEMENTS = new Set([
	"area", "base", "br", "col", "embed", "hr", "img", "input",
	"link", "meta", "param", "source", "track", "wbr",
]);

export const ALLOWED_ATTRIBUTES = new Set([
	"class", "id", "style",
	"role", "tabindex", "hidden",
	"src", "alt", "width", "height",
	"href", "target", "rel",
	"colspan", "rowspan", "scope", "headers",
	"lang", "dir", "title",
	"part", "slot", "spellcheck", "inputmode", "autocomplete",
	"abbr", "align", "label", "loading", "decoding",
	"popover", "popovertarget",
	"type", "value", "placeholder", "name", "for",
	"checked", "disabled", "readonly", "required",
	"rows", "cols", "maxlength", "minlength",
	"min", "max", "step", "pattern",
	"open", "low", "high", "optimum",
	"cx", "cy", "r", "x", "y", "x1", "y1", "x2", "y2", "points", "d",
	"fill", "stroke", "stroke-width", "opacity", "transform",
	"rx", "ry", "dy", "dx", "focusable", "shape-rendering", "text-anchor",
	"stroke-linecap", "stroke-linejoin", "vector-effect",
	"viewbox", "preserveaspectratio", "xmlns",
]);

/**
 * Schemes no host may allow-list. A host that names one of these is declaring an
 * XSS sink, so the declaration is refused rather than quietly dropped from its set.
 */
export const PROHIBITED_URI_SCHEMES: ReadonlySet<string> = new Set(["javascript", "vbscript"]);

/**
 * The scheme set a fragment format gets when it declares none. A host widens or
 * narrows it by declaring `schemes`, which replaces this list wholesale.
 */
export const DEFAULT_URI_SCHEMES: readonly string[] = Object.freeze([
	"http",
	"https",
	"mailto",
	"data",
]);

export const DEFAULT_URI_SCHEME_SET: ReadonlySet<string> = new Set(DEFAULT_URI_SCHEMES);

/**
 * A leading scheme. Whitespace before the colon is tolerated so a value cannot dodge
 * the allow-list by padding a scheme a browser would still resolve; a value that
 * matches nothing here carries no scheme at all and is relative.
 */
const URI_SCHEME_PATTERN = /^([a-z][a-z0-9+.-]*)\s*:/;

/** A well-formed scheme name: lowercase, no colon. */
export const URI_SCHEME_NAME_PATTERN = /^[a-z][a-z0-9+.-]*$/;

export const SAFE_DATA_IMAGE_PATTERN = /^data:image\/(png|jpeg|gif|svg\+xml)[;,]/i;

export const DANGEROUS_STYLE_PATTERNS = [
	/url\s*\([^)]*\)/gi,
	/expression\s*\([^)]*\)/gi,
	/-moz-binding\s*:[^;}"']*/gi,
	/behavior\s*:[^;}"']*/gi,
];

/**
 * A well-formed attribute/prop name: a letter followed by letters, digits, or the
 * `_ . : -` name characters. Rejects any name carrying an attribute-list delimiter
 * (`"`, `'`, `<`, `>`, `=`, whitespace), which would let a crafted JSON key break out
 * of the attribute list when serialized. The HTML tokenizer can never emit such a name,
 * but a JSON-keyed source (jsml) can, so the check guards that path.
 */
export const ATTRIBUTE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]*$/;

export function isValidAttributeName(name: string): boolean {
	return ATTRIBUTE_NAME_PATTERN.test(name);
}

export function isAllowedAttribute(_tag: string, name: string): boolean {
	if (name.startsWith("data-")) return true;
	if (name.startsWith("aria-")) return true;
	if (name.startsWith("on")) return false;

	return ALLOWED_ATTRIBUTES.has(name);
}

/**
 * Returns the value to keep, or `null` when the URI must be dropped entirely.
 *
 * The value is normalized the way a browser normalizes a URL before resolving its
 * scheme: ASCII tab, LF, and CR are removed from anywhere in the string, then leading
 * and trailing C0-control-or-space (U+0000 through U+0020) is trimmed. Matching the
 * raw value instead would let `java&#9;script:` reassemble into a live scheme after
 * the tokenizer decodes the entity. The normalized form is what is returned, so the
 * value that ships is the one the browser will resolve, and it is also the value the
 * scheme is read from — reading the scheme from anything less normalized would put
 * the allow-list behind the same smuggling trick the normalization exists to defeat.
 *
 * Nothing outside that range is trimmed. A URL parser percent-encodes Unicode
 * whitespace and the byte-order mark into the path rather than stripping them, so
 * trimming them here would ship a different URL than the one that was authored.
 *
 * A value carrying no scheme is relative and is never subject to the allow-list:
 * `about.html`, `/abs/path`, `//host/path`, `#anchor`, and `?q=1` all survive
 * whatever the set says.
 *
 * @param schemes - the format's effective scheme set; the default safe set when omitted
 */
export function sanitizeUri(
	value: string,
	attrName: string,
	schemes: ReadonlySet<string> = DEFAULT_URI_SCHEME_SET,
): string | null {
	const trimmed = value
		.replace(/[\t\n\r]/g, "")
		.replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, "");
	const lowered = trimmed.toLowerCase();

	const match = URI_SCHEME_PATTERN.exec(lowered);
	if (!match) return trimmed;

	const scheme = match[1];
	if (PROHIBITED_URI_SCHEMES.has(scheme)) return null;
	if (!schemes.has(scheme)) return null;

	if (scheme === "data") {
		if (attrName === "src" && SAFE_DATA_IMAGE_PATTERN.test(lowered)) {
			return trimmed;
		}
		return null;
	}

	return trimmed;
}

export function sanitizeStyleValue(value: string): string {
	let cleaned = value;
	for (const pattern of DANGEROUS_STYLE_PATTERNS) {
		cleaned = cleaned.replace(pattern, "");
	}
	return cleaned.trim();
}

export const CASE_SENSITIVE_ATTRIBUTES = new Map<string, string>([
	["viewbox", "viewBox"],
	["preserveaspectratio", "preserveAspectRatio"],
]);

export function canonicalAttributeName(lowerName: string): string {
	return CASE_SENSITIVE_ATTRIBUTES.get(lowerName) ?? lowerName;
}

export function sanitizeStyleBlock(css: string): string {
	let cleaned = css;
	for (const pattern of DANGEROUS_STYLE_PATTERNS) {
		cleaned = cleaned.replace(pattern, "");
	}

	cleaned = cleaned.replace(/\{([^}]*)\}/g, (_match, block: string) => {
		const declarations = block
			.split(";")
			.map((decl: string) => decl.trim())
			.filter((decl: string) => {
				if (!decl) return false;
				const colonIdx = decl.indexOf(":");
				if (colonIdx === -1) return false;
				const value = decl.slice(colonIdx + 1).trim();
				return value.length > 0;
			});

		if (declarations.length === 0) return "{}";
		return "{ " + declarations.join("; ") + "; }";
	});

	return cleaned;
}
