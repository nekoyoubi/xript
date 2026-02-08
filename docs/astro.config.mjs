// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
	site: "https://xript.dev",
	integrations: [
		starlight({
			title: "xript",
			social: [
				{
					icon: "github",
					label: "GitHub",
					href: "https://github.com/nekoyoubi/xript",
				},
			],
			sidebar: [
				{
					label: "About",
					items: [
						{ label: "Vision", slug: "vision" },
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
						{ label: "Manifest Validator", slug: "tools/validator" },
						{ label: "Type Generator", slug: "tools/typegen" },
						{ label: "Doc Generator", slug: "tools/docgen" },
					],
				},
				{
					label: "Examples",
					items: [
						{ label: "Expression Evaluator", slug: "examples/expression-evaluator" },
						{ label: "Plugin System", slug: "examples/plugin-system" },
					],
				},
			],
			customCss: ["./src/styles/custom.css"],
			editLink: {
				baseUrl: "https://github.com/nekoyoubi/xript/edit/main/docs/",
			},
		}),
	],
	server: {
		port: 4351,
	},
});
