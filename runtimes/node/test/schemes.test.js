import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	createRuntime,
	FragmentFormatError,
	sanitizeSource,
	resolveExtends,
	DEFAULT_URI_SCHEMES,
	DEFAULT_URI_SCHEME_SET,
	PROHIBITED_URI_SCHEMES,
	URI_SCHEME_NAME_PATTERN,
} from "../dist/index.js";
import { applySink, routePropValue, resolveFragmentProfile } from "../dist/fragment.js";
import { finalizeOps } from "../dist/index.js";

const HTML_FORMAT = "application/x-schemed+html";
const NODE_FORMAT = "application/x-schemed+json";

function htmlFormats(schemes) {
	const declaration = { syntax: "html", vocabularies: ["html"] };
	if (schemes !== undefined) declaration.schemes = schemes;
	return { [HTML_FORMAT]: declaration };
}

function nodeFormats(schemes) {
	const declaration = {
		syntax: "jsml",
		nodes: {
			Link: {
				props: { href: { type: "string", sink: "uri" }, label: { type: "string" } },
				children: "none",
				bindTo: "href",
			},
			Image: {
				props: { src: { type: "string", sink: "image-uri" } },
				children: "none",
				bindTo: "src",
			},
		},
	};
	if (schemes !== undefined) declaration.schemes = schemes;
	return { [NODE_FORMAT]: declaration };
}

function hrefOf(schemes, value) {
	const html = sanitizeSource(`<a href="${value}">x</a>`, HTML_FORMAT, { formats: htmlFormats(schemes) });
	return html.tree[0].props.href ?? null;
}

function srcOf(schemes, value) {
	const html = sanitizeSource(`<img src="${value}">`, HTML_FORMAT, { formats: htmlFormats(schemes) });
	return html.tree[0].props.src ?? null;
}

function profileFor(schemes) {
	return resolveFragmentProfile(NODE_FORMAT, "f", nodeFormats(schemes), null);
}

describe("uri scheme allow-list — the default set", () => {
	it("exports the pinned default set in order", () => {
		assert.deepEqual([...DEFAULT_URI_SCHEMES], ["http", "https", "mailto", "data"]);
		assert.deepEqual([...DEFAULT_URI_SCHEME_SET].sort(), ["data", "http", "https", "mailto"]);
	});

	it("admits the default schemes when the host declares nothing", () => {
		assert.equal(hrefOf(undefined, "https://example.com/a"), "https://example.com/a");
		assert.equal(hrefOf(undefined, "http://example.com/a"), "http://example.com/a");
		assert.equal(hrefOf(undefined, "mailto:a@example.com"), "mailto:a@example.com");
	});

	it("refuses the escalation schemes that a deny-list would have passed", () => {
		for (const value of [
			"file:///etc/passwd",
			"blob:https://example.com/abc",
			"filesystem:https://example.com/t/a",
			"view-source:https://example.com",
			"chrome://settings",
			"tauri://localhost/secret",
			"jar:https://example.com/a.jar!/b",
			"about:blank",
		]) {
			assert.equal(hrefOf(undefined, value), null, `expected ${value} to be refused`);
		}
	});
});

describe("uri scheme allow-list — the hard floor", () => {
	it("pins the prohibited set", () => {
		assert.deepEqual([...PROHIBITED_URI_SCHEMES].sort(), ["javascript", "vbscript"]);
	});

	it("refuses javascript: and vbscript: under the default set", () => {
		assert.equal(hrefOf(undefined, "javascript:alert(1)"), null);
		assert.equal(hrefOf(undefined, "vbscript:msgbox(1)"), null);
	});

	it("refuses a format that declares a prohibited scheme rather than silently dropping it", () => {
		for (const declared of [["javascript"], ["vbscript"], ["https", "javascript"], ["JavaScript"]]) {
			assert.throws(
				() => hrefOf(declared, "https://example.com/a"),
				FragmentFormatError,
				`expected ${JSON.stringify(declared)} to be refused at resolve time`,
			);
		}
	});

	it("refuses a malformed scheme declaration", () => {
		for (const declared of ["https", [7], ["http:"], ["ht tp"], ["1http"]]) {
			assert.throws(() => hrefOf(declared, "https://example.com/a"), FragmentFormatError);
		}
	});

	it("pins the scheme-name grammar", () => {
		assert.ok(URI_SCHEME_NAME_PATTERN.test("tauri"));
		assert.ok(URI_SCHEME_NAME_PATTERN.test("x-custom+v1.0"));
		assert.ok(!URI_SCHEME_NAME_PATTERN.test("1http"));
		assert.ok(!URI_SCHEME_NAME_PATTERN.test("http:"));
		assert.ok(!URI_SCHEME_NAME_PATTERN.test("HTTP"));
	});
});

describe("uri scheme allow-list — widening and narrowing", () => {
	it("lets a host widen to a scheme the default set refuses", () => {
		assert.equal(hrefOf(["https", "tauri"], "tauri://localhost/a"), "tauri://localhost/a");
		assert.equal(hrefOf(["https", "tauri"], "https://example.com/a"), "https://example.com/a");
	});

	it("replaces the default set rather than extending it, so declaring narrows too", () => {
		assert.equal(hrefOf(["https"], "https://example.com/a"), "https://example.com/a");
		assert.equal(hrefOf(["https"], "http://example.com/a"), null);
		assert.equal(hrefOf(["https"], "mailto:a@example.com"), null);
		assert.equal(hrefOf(["tauri"], "https://example.com/a"), null);
	});

	it("treats [] as deliberate closure — no absolute URLs at all", () => {
		for (const value of ["https://example.com/a", "http://example.com/a", "mailto:a@example.com"]) {
			assert.equal(hrefOf([], value), null);
		}
	});

	it("matches schemes case-insensitively while preserving the value's casing", () => {
		assert.equal(hrefOf(["https"], "HTTPS://example.com/a"), "HTTPS://example.com/a");
		assert.equal(hrefOf(["https"], "HtTpS://example.com/A"), "HtTpS://example.com/A");
		assert.equal(hrefOf(["tauri"], "TAURI://localhost/a"), "TAURI://localhost/a");
		assert.equal(hrefOf(["https"], "HTTP://example.com/a"), null);
		assert.equal(hrefOf(["https"], "TAURI://localhost/a"), null);
	});
});

describe("uri scheme allow-list — relative urls always pass", () => {
	const RELATIVE = ["about.html", "/absolute/path", "//cdn.example.com/a.css", "#anchor", "?q=1"];

	for (const schemes of [undefined, [], ["https"], ["tauri"]]) {
		const label = schemes === undefined ? "absent" : JSON.stringify(schemes);
		it(`passes every relative shape when schemes is ${label}`, () => {
			for (const value of RELATIVE) {
				assert.equal(hrefOf(schemes, value), value, `${value} under ${label}`);
			}
		});
	}

	it("does not read a path segment containing a colon as a scheme", () => {
		assert.equal(hrefOf([], "nested/dir/icon.png"), "nested/dir/icon.png");
		assert.equal(hrefOf([], "path/to:thing"), "path/to:thing");
	});
});

describe("uri scheme allow-list — normalization is not bypassable", () => {
	it("still defeats tab, newline and carriage-return reassembly", () => {
		for (const value of [
			"java\tscript:alert(1)",
			"java\nscript:alert(1)",
			"java\rscript:alert(1)",
			"javascript:alert(1)",
			" javascript:alert(1)",
			"JaVaScRiPt:alert(1)",
		]) {
			assert.equal(hrefOf(undefined, value), null, `expected ${JSON.stringify(value)} to be refused`);
			assert.equal(hrefOf(["https"], value), null);
		}
	});

	it("leaves a raw null character inert rather than smuggling a scheme past the list", () => {
		assert.equal(hrefOf(undefined, "\u0000javascript:alert(1)"), "\uFFFDjavascript:alert(1)");
		assert.equal(hrefOf(undefined, "&#0;javascript:alert(1)"), "\uFFFDjavascript:alert(1)");
	});

	it("defeats entity-encoded reassembly through the same normalization", () => {
		assert.equal(hrefOf(undefined, "java&#9;script:alert(1)"), null);
		assert.equal(hrefOf(undefined, "java&#10;script:alert(1)"), null);
		assert.equal(hrefOf(undefined, "&#106;avascript:alert(1)"), null);
	});

	it("extracts the allow-list scheme from the normalized value, not the raw one", () => {
		assert.equal(hrefOf(["https"], "ht\ttps://example.com/a"), "https://example.com/a");
		assert.equal(hrefOf([], "ht\ttps://example.com/a"), null);
		assert.equal(hrefOf(["tauri"], "ta\nuri://localhost/a"), "tauri://localhost/a");
		assert.equal(hrefOf(["https"], "ta\nuri://localhost/a"), null);
	});
});

describe("uri scheme allow-list — the data: gate is unchanged", () => {
	const IMAGE = "data:image/png;base64,iVBORw0KGgo=";

	it("keeps data: on src only, and only for the safe image subtypes", () => {
		assert.equal(srcOf(undefined, IMAGE), IMAGE);
		assert.equal(srcOf(undefined, "data:image/jpeg;base64,/9j/4AAQ"), "data:image/jpeg;base64,/9j/4AAQ");
		assert.equal(srcOf(undefined, "data:image/gif;base64,R0lGOD"), "data:image/gif;base64,R0lGOD");
		assert.equal(srcOf(undefined, "data:image/svg+xml;base64,PHN2Zz4="), "data:image/svg+xml;base64,PHN2Zz4=");
		assert.equal(srcOf(undefined, "data:text/html;base64,PHNjcmlwdD4="), null);
		assert.equal(hrefOf(undefined, IMAGE), null);
	});

	it("allow-listing data grants no more than it does today", () => {
		assert.equal(srcOf(["data"], IMAGE), IMAGE);
		assert.equal(srcOf(["data"], "data:text/html;base64,PHNjcmlwdD4="), null);
		assert.equal(hrefOf(["data"], IMAGE), null);
	});

	it("refuses data: outright when it is left out of the list", () => {
		assert.equal(srcOf(["https"], IMAGE), null);
		assert.equal(srcOf([], IMAGE), null);
		assert.equal(srcOf(["https"], "https://example.com/a.png"), "https://example.com/a.png");
	});
});

describe("uri scheme allow-list — the image-uri sink", () => {
	it("honors the list on a declared image-uri prop", () => {
		assert.equal(applySink("image-uri", "https://example.com/a.png", new Set(["https"])), "https://example.com/a.png");
		assert.equal(applySink("image-uri", "tauri://localhost/a.png", new Set(["https"])), null);
		assert.equal(applySink("image-uri", "tauri://localhost/a.png", new Set(["tauri"])), "tauri://localhost/a.png");
		assert.equal(applySink("image-uri", "javascript:alert(1)", new Set(["javascript"])), null);
	});

	it("defaults to the safe set when a caller omits the argument", () => {
		assert.equal(applySink("uri", "https://example.com/a"), "https://example.com/a");
		assert.equal(applySink("uri", "tauri://localhost/a"), null);
		assert.equal(applySink("uri", "javascript:alert(1)"), null);
	});
});

describe("uri scheme allow-list — declared vocabularies and bind time", () => {
	it("routes a declared uri prop through the format's list", () => {
		const narrow = profileFor(["https"]);
		const wide = profileFor(["https", "tauri"]);
		assert.equal(routePropValue(narrow, "Link", "href", "https://example.com/a"), "https://example.com/a");
		assert.equal(routePropValue(narrow, "Link", "href", "tauri://localhost/a"), null);
		assert.equal(routePropValue(wide, "Link", "href", "tauri://localhost/a"), "tauri://localhost/a");
		assert.equal(routePropValue(wide, "Link", "href", "javascript:alert(1)"), null);
		assert.equal(routePropValue(narrow, "Link", "href", "/relative/path"), "/relative/path");
	});

	it("routes a declared image-uri prop through the format's list", () => {
		const wide = profileFor(["tauri"]);
		assert.equal(routePropValue(wide, "Image", "src", "tauri://localhost/a.png"), "tauri://localhost/a.png");
		assert.equal(routePropValue(wide, "Image", "src", "https://example.com/a.png"), null);
		assert.equal(routePropValue(wide, "Image", "src", "#anchor"), "#anchor");
	});

	it("applies the list to a value bound at render time, not just at parse time", () => {
		const host = {
			xript: "0.8",
			name: "scheme-host",
			slots: [{ id: "panel", accepts: [NODE_FORMAT], description: "panel" }],
			formats: nodeFormats(["https"]),
		};
		const runtime = createRuntime(host, { hostBindings: {} });
		const mod = runtime.loadMod({
			xript: "0.8",
			name: "scheme-mod",
			version: "1.0.0",
			fills: {
				panel: [{
					id: "p",
					format: NODE_FORMAT,
					inline: true,
					source: JSON.stringify(["Link", { "data-bind": "target" }]),
					bindings: [{ name: "target", path: "link.target" }],
				}],
			},
		});

		const fragment = mod.fragments[0];
		assert.equal(
			fragment.getContent({ link: { target: "https://example.com/ok" } }).tree[0].props.href,
			"https://example.com/ok",
		);
		for (const hostile of ["tauri://localhost/a", "javascript:alert(1)", "file:///etc/passwd"]) {
			const bound = fragment.getContent({ link: { target: hostile } }).tree[0].props;
			assert.ok(!("href" in bound) || bound.href !== hostile, `bound ${hostile} leaked into href`);
		}
		runtime.dispose();
	});
});

describe("uri scheme allow-list — command-buffer ops", () => {
	function setProp(schemes, prop, value) {
		const profile = resolveFragmentProfile(NODE_FORMAT, "f", nodeFormats(schemes), null);
		const diagnostics = [];
		const ops = finalizeOps(
			[{ op: "setProp", selector: "#n", prop, value }],
			profile,
			(d) => diagnostics.push(d),
		);
		return { ops, diagnostics };
	}

	it("applies the format's list to a mod-issued setProp, not just to parsed source", () => {
		const ok = setProp(["https"], "href", "https://example.com/a");
		assert.equal(ok.ops.length, 1);
		assert.equal(ok.ops[0].value, "https://example.com/a");

		const refused = setProp(["https"], "href", "tauri://localhost/a");
		assert.equal(refused.ops.length, 0);
		assert.ok(refused.diagnostics.some((d) => d.code === "unsafe-prop"));
	});

	it("lets a widened list through the op path", () => {
		const widened = setProp(["tauri"], "href", "tauri://localhost/a");
		assert.equal(widened.ops.length, 1);
		assert.equal(widened.ops[0].value, "tauri://localhost/a");
	});

	it("keeps the hard floor on the op path even when the value is bound late", () => {
		for (const hostile of ["javascript:alert(1)", "java	script:alert(1)", "vbscript:msgbox(1)"]) {
			const result = setProp(["https", "http"], "href", hostile);
			assert.equal(result.ops.length, 0, `op carrying ${JSON.stringify(hostile)} was not refused`);
		}
	});

	it("closes the op path entirely when the format declares []", () => {
		assert.equal(setProp([], "href", "https://example.com/a").ops.length, 0);
		assert.equal(setProp([], "href", "/relative/path").ops.length, 1);
	});
});

describe("uri scheme allow-list — extends", () => {
	function resolved(base, child) {
		const loader = () => ({ xript: "0.8", name: "base", formats: base });
		return resolveExtends(
			{ xript: "0.8", name: "child", extends: "base.json", formats: child },
			".",
			loader,
		);
	}

	it("inherits the base's list when the child omits schemes", () => {
		const manifest = resolved(
			{ [HTML_FORMAT]: { syntax: "html", vocabularies: ["html"], schemes: ["https", "tauri"] } },
			{ [HTML_FORMAT]: { refines: true } },
		);
		assert.deepEqual(manifest.formats[HTML_FORMAT].schemes, ["https", "tauri"]);
	});

	it("replaces the base's list wholesale when the child declares one", () => {
		const manifest = resolved(
			{ [HTML_FORMAT]: { syntax: "html", vocabularies: ["html"], schemes: ["https", "tauri"] } },
			{ [HTML_FORMAT]: { refines: true, schemes: ["https"] } },
		);
		assert.deepEqual(manifest.formats[HTML_FORMAT].schemes, ["https"]);
	});

	it("lets a child close its base's list with []", () => {
		const manifest = resolved(
			{ [HTML_FORMAT]: { syntax: "html", vocabularies: ["html"], schemes: ["https", "tauri"] } },
			{ [HTML_FORMAT]: { refines: true, schemes: [] } },
		);
		assert.deepEqual(manifest.formats[HTML_FORMAT].schemes, []);
		assert.equal(hrefOf([], "https://example.com/a"), null);
	});
});
