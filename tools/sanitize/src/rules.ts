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
	"details", "summary",
	"section", "article", "aside", "nav",
	"header", "footer", "main",
	"a", "abbr", "mark", "time", "wbr",
	"style",
	"input", "textarea", "select", "option", "label",
]);

export const STRIPPED_ELEMENTS = new Set([
	"script", "iframe", "object", "embed", "form",
	"base", "link", "meta", "title",
	"noscript", "applet", "frame", "frameset",
	"param",
]);

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
	"type", "value", "placeholder", "name", "for",
	"checked", "disabled", "readonly", "required",
	"rows", "cols", "maxlength", "minlength",
	"min", "max", "step", "pattern",
]);

export const DANGEROUS_URI_SCHEMES = /^\s*(javascript|vbscript)\s*:/i;

export const SAFE_DATA_IMAGE_PATTERN = /^data:image\/(png|jpeg|gif|svg\+xml)[;,]/i;

export const DANGEROUS_STYLE_PATTERNS = [
	/url\s*\([^)]*\)/gi,
	/expression\s*\([^)]*\)/gi,
	/-moz-binding\s*:[^;}"']*/gi,
	/behavior\s*:[^;}"']*/gi,
];

export function isAllowedAttribute(_tag: string, name: string): boolean {
	if (name.startsWith("data-")) return true;
	if (name.startsWith("aria-")) return true;
	if (name.startsWith("on")) return false;

	return ALLOWED_ATTRIBUTES.has(name);
}

export function sanitizeUri(value: string, attrName: string): string | null {
	const trimmed = value.trim();

	if (DANGEROUS_URI_SCHEMES.test(trimmed)) return null;

	if (trimmed.startsWith("data:")) {
		if (attrName === "src" && SAFE_DATA_IMAGE_PATTERN.test(trimmed)) {
			return value;
		}
		return null;
	}

	return value;
}

export function sanitizeStyleValue(value: string): string {
	let cleaned = value;
	for (const pattern of DANGEROUS_STYLE_PATTERNS) {
		cleaned = cleaned.replace(pattern, "");
	}
	return cleaned.trim();
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
