import { test as base, expect } from "@playwright/test";

type Fixtures = {
	projectId: string;
};

export const test = base.extend<Fixtures>({
	projectId: async ({ browserName }, use, testInfo) => {
		const slug = [browserName, ...testInfo.titlePath]
			.join("-")
			.replace(/[^a-z0-9]+/gi, "-")
			.toLowerCase();
		const suffix = Math.random().toString(36).slice(2, 8);
		await use(`e2e-${slug}-${Date.now()}-${suffix}`);
	},
});

export { expect };
