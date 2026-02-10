// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
	site: "https://xript.dev",
	prefetch: false,
	integrations: [
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
					label: "Specification",
					items: [
						{ label: "Manifest", slug: "spec/manifest" },
						{ label: "Capabilities", slug: "spec/capabilities" },
						{ label: "Bindings", slug: "spec/bindings" },
						{ label: "Security", slug: "spec/security" },
					],
				},
				{
					label: "Tools",
					items: [
						{ label: "Runtime", slug: "tools/runtime" },
						{ label: "Node.js Runtime", slug: "tools/runtime-node" },
						{ label: "Manifest Validator", slug: "tools/validator" },
						{ label: "Type Generator", slug: "tools/typegen" },
						{ label: "Doc Generator", slug: "tools/docgen" },
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
			exclude: ["@xript/runtime", "quickjs-emscripten"],
		},
	},
	server: {
		port: 4351,
	},
});
