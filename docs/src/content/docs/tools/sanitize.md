---
title: HTML Sanitizer
description: "Pure string-based HTML sanitizer for xript UI fragments — no DOM dependency."
---

The sanitizer cleans HTML fragment content before it reaches the host. Pure string-based, no DOM dependency; runs inside QuickJS WASM, Node, Deno, browsers, wherever.

## Installation

```bash
npm install @xriptjs/cli
```

## CLI

```bash
# Sanitize a fragment file and print the result
xript sanitize fragment.html

# Validate and show what was stripped
xript sanitize fragment.html --validate

# Output sanitized HTML only (no diagnostics)
xript sanitize fragment.html --quiet
```

## API

```typescript
import { sanitizeHTML, sanitizeHTMLDetailed, validateFragment } from "@xriptjs/sanitize";

// Simple: returns sanitized HTML string
const clean = sanitizeHTML('<div onclick="evil()">safe text</div>');
// => '<div>safe text</div>'

// Detailed: returns what was stripped
const result = sanitizeHTMLDetailed('<script>alert("xss")</script><p>safe</p>');
// result.html => '<p>safe</p>'
// result.strippedElements => ['script']
// result.strippedAttributes => []

// Validation: returns structured report
const validation = validateFragment('<div data-bind="health">0</div>');
// validation.valid => true
// validation.sanitized => '<div data-bind="health">0</div>'
```

## What Gets Preserved

Structural and presentational elements: `div`, `span`, `p`, `h1`–`h6`, `ul`/`ol`/`li`, `table` family, `details`/`summary`, `section`, `article`, `header`, `footer`, `a`, `img`, `br`, `hr`, and more.

Safe attributes: `class`, `id`, `data-*` (including `data-bind` and `data-if`), `aria-*`, `role`, `style` (sanitized), `src`/`href` (safe URIs only), `alt`, `width`, `height`, `tabindex`, `hidden`.

Scoped `<style>` blocks with dangerous CSS properties stripped.

## What Gets Stripped

**Elements removed entirely (including children):** `script`, `iframe`, `object`, `embed`, `form`, `base`, `link`, `meta`, `title`, `noscript`, `applet`.

**Document wrappers unwrapped (children preserved):** `html`, `head`, `body`.

**Attributes stripped:** all `on*` event attributes (`onclick`, `onerror`, etc.), `formaction`, `action`, `method`.

**URIs stripped:** `javascript:`, `vbscript:`, dangerous `data:` URIs. Safe image `data:` URIs on `src` are preserved.

**CSS stripped:** `url()` references, `expression()`, `-moz-binding`, `behavior:` properties.

## Conformance

All xript runtime implementations must produce identical sanitized output. The conformance test suite lives at [`spec/sanitizer-tests.json`](https://github.com/nekoyoubi/xript/blob/main/spec/sanitizer-tests.json) with 45 test cases covering element stripping, attribute filtering, URI sanitization, style cleaning, and edge cases.
