import type { Page } from "@playwright/test";

export const E2E_PASSWORD = process.env.DIVMEMORY_WEB_PASSWORD ?? "e2e-test-password";

export async function login(page: Page, password = E2E_PASSWORD): Promise<void> {
	await page.goto("/login");
	await page.locator("#web-password").fill(password);
	await Promise.all([
		page.waitForURL((url) => !url.pathname.endsWith("/login"), { timeout: 15_000 }),
		page.getByRole("button", { name: "Sign in" }).click(),
	]);
}

/** Seed a memory using the authenticated session cookie (hybridAuth). */
export async function seedMemory(page: Page, content: string, projectId: string): Promise<string> {
	const res = await page.request.post("/memories", {
		headers: { "Content-Type": "application/json" },
		data: {
			project_id: projectId,
			project_name: "E2E Project",
			content,
			topic: "general",
		},
	});
	if (!res.ok()) {
		throw new Error(`seedMemory failed: ${res.status()} ${await res.text()}`);
	}
	const json = (await res.json()) as { id: string };
	return json.id;
}
