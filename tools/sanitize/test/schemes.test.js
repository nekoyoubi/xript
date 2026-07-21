import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	DEFAULT_URI_SCHEMES,
	FormatProfileError,
	resolveFormatProfile,
	sanitizeFragment,
	sanitizeUri,
} from "../dist/index.js";

const formatId = "application/x-schemed+json";

function formats(schemes) {
	return {
		[formatId]: {
			syntax: "j5ml",
			...(schemes === undefined ? {} : { schemes }),
			nodes: {
				Link: { props: { href: { type: "string", sink: "uri" } }, children: "none" },
				Avatar: { props: { src: { type: "string", sink: "image-uri" } }, children: "none" },
			},
		},
	};
}

function profileFor(schemes) {
	const profile = resolveFormatProfile(formatId, formats(schemes), null);
	assert.ok(profile, "expected a profile");
	return profile;
}

function propAfterSanitize(schemes, node, prop, value) {
	const result = sanitizeFragment(JSON.stringify([node, { [prop]: value }]), profileFor(schemes));
	return result.tree[0].props[prop];
}

const linkHref = (schemes, href) => propAfterSanitize(schemes, "Link", "href", href);
const avatarSrc = (schemes, src) => propAfterSanitize(schemes, "Avatar", "src", src);

const [TAB, LF, CR] = [9, 10, 13].map((code) => String.fromCharCode(code));

describe("scheme allow-list", () => {
	it("defaults to http, https, mailto, and data", () => {
		assert.deepEqual([...DEFAULT_URI_SCHEMES], ["http", "https", "mailto", "data"]);
		assert.deepEqual([...profileFor(undefined).schemes].sort(), [
			"data",
			"http",
			"https",
			"mailto",
		]);
	});

	it("carries a declared set onto the profile, lowercased", () => {
		assert.deepEqual([...profileFor(["HTTPS", "tauri"]).schemes].sort(), ["https", "tauri"]);
	});

	it("replaces the default rather than extending it", () => {
		assert.equal(linkHref(["tauri"], "tauri://localhost/api"), "tauri://localhost/api");
		assert.equal(linkHref(["tauri"], "https://example.com"), undefined);
	});

	it("narrows to a single scheme when asked", () => {
		assert.equal(linkHref(["https"], "https://example.com"), "https://example.com");
		assert.equal(linkHref(["https"], "http://example.com"), undefined);
	});

	it("reads an empty list as deliberate closure", () => {
		assert.equal(linkHref([], "https://example.com"), undefined);
		assert.equal(linkHref([], "mailto:someone@example.com"), undefined);
	});

	it("matches a declared scheme case-insensitively", () => {
		assert.equal(linkHref(["tauri"], "TAURI://localhost/api"), "TAURI://localhost/api");
	});

	it("refuses the schemes the default set never admitted", () => {
		for (const href of [
			"file:///etc/passwd",
			"blob:https://example.com/uuid",
			"filesystem:https://example.com/temporary/a",
			"view-source:https://example.com",
			"chrome://settings",
			"tauri://localhost/api",
			"jar:http://example.com/a.jar!/b",
			"about:blank",
		]) {
			assert.equal(linkHref(undefined, href), undefined, href);
		}
	});

	it("refuses javascript and vbscript whatever the set says", () => {
		for (const declared of ["javascript", "VBScript"]) {
			assert.throws(
				() => resolveFormatProfile(formatId, formats([declared]), null),
				(err) => err instanceof FormatProfileError && err.code === "prohibited-scheme",
			);
		}
		assert.equal(sanitizeUri("javascript:alert(1)", "href", new Set(["javascript"])), null);
		assert.equal(sanitizeUri("vbscript:MsgBox(1)", "href", new Set(["vbscript"])), null);
	});

	it("refuses a malformed scheme list", () => {
		for (const schemes of ["https", [7], ["https:"], ["ht tp"], [""]]) {
			assert.throws(
				() => resolveFormatProfile(formatId, formats(schemes), null),
				(err) => err instanceof FormatProfileError && err.code === "invalid-schemes",
				JSON.stringify(schemes),
			);
		}
	});

	it("leaves every relative shape alone whatever the set says", () => {
		const relatives = ["about.html", "/abs/path", "//cdn.example.com/a.css", "#anchor", "?q=1"];
		for (const schemes of [undefined, [], ["https"], ["tauri"]]) {
			for (const href of relatives) {
				assert.equal(linkHref(schemes, href), href, `${JSON.stringify(schemes)} :: ${href}`);
			}
		}
		assert.equal(avatarSrc([], "nested/dir/icon.png"), "nested/dir/icon.png");
	});

	it("reads the scheme from the normalized value, so smuggling cannot bypass the list", () => {
		assert.equal(linkHref(["https"], `fi${TAB}le:///etc/passwd`), undefined);
		assert.equal(linkHref(["https"], `ta${LF}uri://localhost/api`), undefined);
		assert.equal(linkHref([], `ht${CR}tps://example.com`), undefined);
		assert.equal(linkHref(["https"], `java${TAB}script:alert(1)`), undefined);
		assert.equal(linkHref(["https"], "file:///etc/passwd"), undefined);
	});

	it("gates data: by subtype and sink exactly as before", () => {
		assert.equal(avatarSrc(["data"], "data:image/png;base64,abc"), "data:image/png;base64,abc");
		assert.equal(avatarSrc(["data"], "data:text/html,<script>x</script>"), undefined);
		assert.equal(linkHref(["data"], "data:image/png;base64,abc"), undefined);
	});

	it("refuses data: outright when the list omits it", () => {
		assert.equal(avatarSrc(["https"], "data:image/png;base64,abc"), undefined);
		assert.equal(avatarSrc([], "data:image/png;base64,abc"), undefined);
	});

	it("defaults sanitizeUri to the safe set when no set is passed", () => {
		assert.equal(sanitizeUri("https://example.com", "href"), "https://example.com");
		assert.equal(sanitizeUri("file:///etc/passwd", "href"), null);
		assert.equal(sanitizeUri("./relative", "href"), "./relative");
	});
});
