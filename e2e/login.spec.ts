import { expect, test } from "@playwright/test";
import { E2E_PASSWORD, login } from "./helpers";

test.describe("login", () => {
	test("shows password form on /login", async ({ page }) => {
		await page.goto("/login");
		await expect(page.locator("#web-password")).toBeVisible();
		await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
	});

	test("successful login sets session and redirects home", async ({ page }) => {
		await login(page);
		await expect(page).not.toHaveURL(/\/login$/);
		const cookies = await page.context().cookies();
		expect(cookies.some((c) => c.name === "divmemory_session")).toBe(true);
	});

	test("invalid credentials return 401 without session cookie", async ({ request }) => {
		const res = await request.post("/login", {
			form: { password: "wrong-password" },
		});
		expect(res.status()).toBe(401);
		expect(res.headers()["set-cookie"]).toBeUndefined();
	});

	test("empty password returns 401", async ({ request }) => {
		const res = await request.post("/login", {
			form: { password: "" },
		});
		expect(res.status()).toBe(401);
	});

	test("redirect query is preserved after login", async ({ page }) => {
		await page.goto("/login?redirect=%2F%3Fproject%3De2e-project");
		await page.locator("#web-password").fill(E2E_PASSWORD);
		await page.getByRole("button", { name: "Sign in" }).click();
		await page.waitForURL(/project=e2e-project/);
	});

	test("unauthenticated root redirects to login", async ({ page }) => {
		await page.goto("/");
		await expect(page).toHaveURL(/\/login/);
	});
});
