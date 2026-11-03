# @xriptjs/sanitize

HTML and JSML sanitizer for [xript](https://github.com/nekoyoubi/xript) UI fragments. Pure string-based; no DOM dependency, so it runs everywhere including QuickJS WASM.

[![npm](https://img.shields.io/npm/v/@xriptjs/sanitize)](https://www.npmjs.com/package/@xriptjs/sanitize)

## Install

```sh
npm install @xriptjs/sanitize
```

## CLI

```sh
npx xript-sanitize fragment.html
```

Outputs sanitized HTML to stdout. Options:

```sh
npx xript-sanitize fragment.html --validate   # validation report + sanitized output
npx xript-sanitize fragment.html --quiet      # sanitized HTML only, no diagnostics
```

Exit code is `1` if validation finds issues.

## API

```javascript
import { sanitizeHTML, sanitizeHTMLDetailed, validateFragment } from "@xriptjs/sanitize";

// Quick sanitize — returns clean HTML string
const clean = sanitizeHTML('<div onclick="alert(1)"><p>safe</p></div>');
// => '<div><p>safe</p></div>'

// Detailed sanitize — returns what was stripped
const result = sanitizeHTMLDetailed('<script>bad</script><p>safe</p>');
// result.html => '<p>safe</p>'
// result.strippedElements => ['script']
// result.strippedAttributes => []

// Fragment validation — validates and sanitizes in one pass
const check = validateFragment('<p>hello</p>', 'text/html');
// check.valid => true
// check.errors => []
// check.sanitized => '<p>hello</p>'
```

### `sanitizeHTML(input): string`

Returns sanitized HTML with all dangerous elements and attributes removed.

### `sanitizeHTMLDetailed(input): SanitizeResult`

Returns sanitized HTML plus a report of everything that was stripped.

### `validateFragment(input, format?): FragmentValidationResult`

Validates and sanitizes a fragment. Supports `text/html` and `application/jsml+json`.

### `sanitizeJsml(nodes): JsmlSanitizeResult`

Sanitizes JSML (J5ML) nodes directly. Returns the sanitized tree, its HTML conversion, and stripped element/attribute reports.

### `jsmlToHtml(nodes): string`

Converts JSML nodes to an HTML string without sanitization.

### `EXPRESSION_REFERENCE`

The machine-readable reference for XEG, the expression grammar behind `data-if`, `data-bind`, `data-each`, `data-key`, and `{{ }}`: every builtin's parameters, return type, description, and examples, the operators by precedence, the evaluation rules, and the attributes that carry expressions. Read it to drive completion and hover help in an editor instead of writing your own descriptions. It is deeply frozen, and `BUILTINS` is derived from its signatures.

```typescript
import { EXPRESSION_REFERENCE } from "@xriptjs/sanitize";

const round = EXPRESSION_REFERENCE.builtins.find((b) => b.name === "round");
// round.params → [{ name: "x", type: "number" }], round.returns → "number | null"
```

### Types

```typescript
interface SanitizeResult {
  html: string;
  strippedElements: string[];
  strippedAttributes: Array<{ element: string; attribute: string }>;
}

interface FragmentValidationResult {
  valid: boolean;
  errors: Array<{ message: string; line?: number }>;
  sanitized: string;
}
```

## What it does

- Strips dangerous elements (`script`, `iframe`, `object`, `embed`, `form`, and more)
- Strips event handler attributes (`onclick`, `onload`, etc.)
- Sanitizes `href` and `src` URIs (blocks `javascript:` and `data:` schemes)
- Sanitizes inline styles (blocks `expression()`, `url()`, and other injection vectors)
- Handles both HTML and JSML (J5ML) fragment formats
- No DOM, no parser dependencies; works in any JavaScript environment

## Documentation

[xript.dev](https://xript.dev): full docs, fragment specification, and sanitizer conformance suite.

## License

MIT
