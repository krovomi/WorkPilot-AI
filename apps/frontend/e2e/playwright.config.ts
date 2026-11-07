/**
 * Playwright configuration for the Electron E2E specs (`*.e2e.ts`).
 *
 * The specs drive the built app (`pnpm run build` first) through
 * `e2e/app-harness.ts`. CI runs them on Linux under xvfb (`ci.yml`, job
 * `e2e`). A retry is allowed to collect a trace, never to turn a failure
 * green: a test that only passes on retry fails the run.
 */
import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: ".",
	testMatch: "**/*.e2e.ts",
	timeout: 90_000,
	expect: {
		timeout: 10_000,
	},
	fullyParallel: false, // One Electron app at a time
	forbidOnly: Boolean(process.env.CI),
	retries: process.env.CI ? 1 : 0,
	failOnFlakyTests: Boolean(process.env.CI),
	workers: 1,
	reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
	use: {
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
	},
	projects: [
		{
			name: "electron",
			testMatch: "**/*.e2e.ts",
		},
	],
});
