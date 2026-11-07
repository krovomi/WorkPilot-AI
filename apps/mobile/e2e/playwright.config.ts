import { defineConfig, devices } from "@playwright/test";

/**
 * The phone app's screens, from its web bundle (`expo export --platform
 * web`), against a real WorkPilot server. See `server.e2e.ts`.
 */
export default defineConfig({
	testDir: ".",
	testMatch: /.*\.e2e\.ts$/,
	timeout: 180_000,
	retries: 0,
	workers: 1,
	reporter: [["list"]],
	outputDir: "../test-results",
	use: {
		...devices["iPhone 14"],
		// The phone's engine is not the point here, the screens and the server are.
		browserName: "chromium",
		locale: "en-US",
		screenshot: "only-on-failure",
		trace: "retain-on-failure",
		launchOptions: process.env.WORKPILOT_E2E_CHROMIUM
			? { executablePath: process.env.WORKPILOT_E2E_CHROMIUM }
			: {},
	},
});
