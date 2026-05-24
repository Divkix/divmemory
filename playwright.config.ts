import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:8787";

export default defineConfig({
	testDir: "./e2e",
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 2 : 0,
	workers: process.env.CI ? 1 : undefined,
	reporter: process.env.CI ? "github" : "list",
	use: {
		baseURL,
		trace: "on-first-retry",
	},
	projects: [
		{
			name: "desktop",
			use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 720 } },
		},
		{ name: "mobile", use: { ...devices["Pixel 5"], viewport: { width: 390, height: 844 } } },
	],
	webServer: {
		command: "cd worker && bun wrangler dev --config wrangler.e2e.jsonc --port 8787",
		url: `${baseURL}/health`,
		reuseExistingServer: !process.env.CI,
		timeout: 120_000,
	},
});
