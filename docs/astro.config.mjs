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
