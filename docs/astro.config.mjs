import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

export default defineConfig({
	site: "https://divmemory.pages.dev",
	integrations: [
		starlight({
			title: "divmemory",
			description: "Persistent cross-session memory for coding agents, backed by Cloudflare.",
			logo: {
				src: "./public/favicon.svg",
			},
			social: [{ icon: "github", label: "GitHub", href: "https://github.com/divkix/divmemory" }],
			sidebar: [
				{
					label: "Getting Started",
					items: [
						{ label: "Introduction", slug: "getting-started/introduction" },
						{ label: "Quickstart", slug: "getting-started/quickstart" },
						{ label: "Architecture", slug: "getting-started/architecture" },
					],
				},
				{
					label: "Self-Hosting",
					items: [
						{ label: "Prerequisites", slug: "self-hosting/prerequisites" },
						{ label: "Database Setup", slug: "self-hosting/database" },
						{ label: "Deploy", slug: "self-hosting/deploy" },
						{ label: "Secrets", slug: "self-hosting/secrets" },
					],
				},
				{
					label: "Plugin",
					items: [
						{ label: "Install", slug: "plugin/install" },
						{ label: "Environment Variables", slug: "plugin/env" },
					],
				},
				{
					label: "API Reference",
					items: [
						{ label: "Overview", slug: "api/overview" },
						{ label: "Ingest", slug: "api/ingest" },
						{ label: "Context", slug: "api/context" },
						{ label: "Memories", slug: "api/memories" },
						{ label: "Consolidate", slug: "api/consolidate" },
						{ label: "Status", slug: "api/status" },
					],
				},
				{
					label: "CLI",
					items: [{ label: "Bootstrap", slug: "cli/bootstrap" }],
				},
				{
					label: "Development",
					items: [
						{ label: "Local Dev", slug: "development/local" },
						{ label: "Testing", slug: "development/testing" },
					],
				},
				{
					label: "Troubleshooting",
					items: [{ label: "Common Issues", slug: "troubleshooting/common" }],
				},
			],
		}),
	],
});
