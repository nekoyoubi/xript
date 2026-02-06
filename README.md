# xript

**eXtensible Runtime Interface Protocol Tooling**

*mod the it*

---

xript is a platform specification for making any application moddable. Users write JavaScript. xript standardizes the bindings, the capability model, the sandboxing guarantees, the documentation, and the tooling.

## Repository Structure

```
xript/
├── spec/           # the specification itself
├── runtimes/       # language-specific implementations
│   ├── js/
│   ├── rust/
│   └── ...
├── tools/          # ecosystem tooling
│   ├── docgen/
│   ├── typegen/
│   └── ...
├── docs/           # documentation site (Astro)
└── examples/       # example manifests and integrations
```

## Quick Start

```sh
npm install
npm run docs:dev    # run the docs site locally on port 4351
```

## Learn More

- [Vision](spec/vision.md) — the guiding principles behind xript
- [Documentation](https://nekoyoubi.github.io/xript) — the live site
