import { expect, test } from "./fixtures";
import { login, seedMemory } from "./helpers";

test.describe("memory form actions", () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
	});

	test("PATCH edit updates memory content", async ({ page, projectId }) => {
		const original = `Original E2E ${Date.now()}`;
		const updated = `Updated E2E ${Date.now()}`;
		const memoryId = await seedMemory(page, original, projectId);
		await page.goto(`/?project=${encodeURIComponent(projectId)}&edit=${memoryId}`);

		const textarea = page.locator("form.edit-form textarea");
		await expect(textarea).toBeVisible();
		await textarea.fill(updated);
		await page.locator("form.edit-form button.btn-primary").click();

		await page.waitForURL(
			(url) => url.searchParams.get("project") === projectId && !url.searchParams.has("edit"),
		);
		await expect(page.locator(".memory-card", { hasText: updated })).toBeVisible();
	});

	test("DELETE with confirmation archives memory", async ({ page, projectId }) => {
		const label = `Memory to archive ${Date.now()}`;
		const memoryId = await seedMemory(page, label, projectId);
		await page.goto(`/?project=${encodeURIComponent(projectId)}&delete=${memoryId}`);

		await expect(page.locator(".confirm-box", { hasText: label })).toBeVisible();
		await page.getByRole("button", { name: "Confirm Delete" }).click();

		await page.waitForURL(
			(url) => url.searchParams.get("project") === projectId && !url.searchParams.has("delete"),
		);
		await expect(page.locator(".memory-card", { hasText: label })).toHaveCount(0);
	});
});
