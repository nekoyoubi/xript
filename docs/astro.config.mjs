// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import { llmsTxt } from "./integrations/llms-txt.mjs";

export default defineConfig({
	site: "https://xript.dev",
	prefetch: false,
	integrations: [
		llmsTxt(),
		starlight({
			title: "xript",
			favicon: "/favicon.svg",
			social: [
				{
					icon: "github",
					label: "GitHub",
					href: "https://github.com/nekoyoubi/xript",
				},
			],
			components: {
				ThemeSelect: "./src/components/ThemeSelect.astro",
				SiteTitle: "./src/components/SiteTitle.astro",
			},
			head: [
				{
					tag: "script",
					content: `(function(){var s=localStorage.getItem('starlight-color-scheme');if(s)document.documentElement.setAttribute('data-color-scheme',s);window.addEventListener('DOMContentLoaded',function(){requestAnimationFrame(function(){document.documentElement.classList.add('theme-transitions')})})})();`,
				},
			],
			sidebar: [
				{
					label: "About",
					items: [
						{ label: "Vision", slug: "vision" },
						{ label: "Adoption Tiers", slug: "adoption-tiers" },
						{ label: "Getting Started", slug: "getting-started" },
					],
				},
				{
					label: "Doctrine",
					items: [
						{ label: "When to reach for xript", slug: "guidance/when-to-use" },
						{ label: "Choosing a surface", slug: "guidance/surfaces" },
						{ label: "Mod zero", slug: "guidance/mod-zero" },
						{ label: "The host/mod boundary", slug: "guidance/boundary" },
						{ label: "More extensible, not less", slug: "guidance/openness" },
						{ label: "Authoring a mod", slug: "guidance/authoring" },
						{ label: "Hosting xript", slug: "guidance/hosting" },
						{ label: "Hosting: rendering fragments", slug: "guidance/host-fragments" },
						{ label: "Hosting: granting capabilities", slug: "guidance/host-capabilities" },
						{ label: "Hosting: mounting slots", slug: "guidance/host-slots" },
						{ label: "Hosting: resolving roles", slug: "guidance/host-roles" },
						{ label: "Hosting: firing hooks & events", slug: "guidance/host-hooks" },
						{ label: "Hosting: limits, cancellation & audit", slug: "guidance/host-safety" },
						{ label: "Adoption tiers", slug: "guidance/tiers" },
					],
				},
				{
					label: "Specification",
					items: [
						{ label: "Manifest", slug: "spec/manifest" },
						{ label: "Mod Manifest", slug: "spec/mod-manifest" },
						{ label: "Fragments", slug: "spec/fragments" },
						{ label: "Fragment Formats", slug: "spec/fragment-formats" },
						{ label: "Capabilities", slug: "spec/capabilities" },
						{ label: "Bindings", slug: "spec/bindings" },
						{ label: "Hooks", slug: "spec/hooks" },
						{ label: "Module-Format Mods", slug: "spec/modules" },
						{ label: "Debugging", slug: "spec/debugging" },
						{ label: "Security", slug: "spec/security" },
						{ label: "Annotations", slug: "spec/annotations" },
					],
				},
				{
					label: "Runtimes",
					items: [
						{ label: "Choosing a Runtime", slug: "runtimes/overview" },
						{ label: "JS/WASM Runtime", slug: "runtimes/js-wasm" },
						{ label: "Node.js Runtime", slug: "runtimes/node" },
						{ label: "Rust Runtime", slug: "runtimes/rust" },
						{ label: "C# Runtime", slug: "runtimes/csharp" },
					],
				},
				{
					label: "Tools",
					items: [
						{ label: "CLI", slug: "tools/cli" },
						{ label: "MCP Server", slug: "tools/mcp" },
						{ label: "Extensibility Score", slug: "tools/score" },
						{ label: "Lint", slug: "tools/lint" },
						{ label: "TUI Wizard", slug: "tools/wiz" },
						{ label: "Fragment Workbench", slug: "tools/fragment-workbench" },
					],
				},
				{
					label: "Examples",
					items: [
						{
							label: "Expression Evaluator",
							slug: "examples/expression-evaluator",
						},
						{ label: "Plugin System", slug: "examples/plugin-system" },
						{
							label: "Game Mod System",
							slug: "examples/game-mod-system",
						},
						{
							label: "UI Dashboard",
							slug: "examples/ui-dashboard",
						},
					],
				},
				{
					label: "Live Demos",
					items: [
						{
							label: "Expression Playground",
							slug: "demos/expression-playground",
						},
						{
							label: "Plugin Workshop",
							slug: "demos/plugin-workshop",
						},
						{
							label: "Dungeon Modding",
							slug: "demos/dungeon-modding",
						},
						{
							label: "Fragment Builder",
							slug: "demos/fragment-builder",
						},
					],
				},
			],
			customCss: [
				"@fontsource-variable/inter",
				"@fontsource/jetbrains-mono/400.css",
				"@fontsource/jetbrains-mono/600.css",
				"./src/styles/custom.css",
			],
			editLink: {
				baseUrl: "https://github.com/nekoyoubi/xript/edit/main/docs/",
			},
		}),
	],
	vite: {
		optimizeDeps: {
			exclude: ["@xriptjs/runtime", "@xriptjs/sanitize", "quickjs-emscripten"],
		},
	},
	server: {
		port: 4351,
	},
});
