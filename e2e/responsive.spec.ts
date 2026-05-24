import { expect, test } from "@playwright/test";
import { E2E_PROJECT, login, seedMemory } from "./helpers";

test.describe("responsive layout", () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
		await seedMemory(page, `E2E responsive ${Date.now()}`, E2E_PROJECT);
		await page.goto(`/?project=${encodeURIComponent(E2E_PROJECT)}`);
	});

	test("sidebar navigation is visible", async ({ page }) => {
		const sidebar = page.locator("nav.sidebar");
		await expect(sidebar).toBeVisible();
		await expect(sidebar.getByRole("heading", { name: "Projects" })).toBeVisible();
	});

	test("main layout fits viewport width", async ({ page, viewport }) => {
		const container = page.locator(".container");
		const sidebar = page.locator("nav.sidebar");
		const main = page.locator(".main").first();
		await expect(container).toBeVisible();
		await expect(sidebar).toBeVisible();
		await expect(main).toBeVisible();

		const containerBox = await container.boundingBox();
		expect(containerBox?.width ?? 0).toBeLessThanOrEqual((viewport?.width ?? 1280) + 2);

		const flexDirection = await container.evaluate((el) => getComputedStyle(el).flexDirection);
		expect(flexDirection).toBe("row");
	});
});
