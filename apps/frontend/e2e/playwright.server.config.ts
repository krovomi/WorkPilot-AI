/**
 * Playwright configuration for the specs that drive the built app against a
 * real WorkPilot server (`*.server-e2e.ts`). Same rules as
 * `playwright.config.ts`; a separate run because these specs need the
 * backend's Python to start the server (CI job `app-server-e2e`).
 */
import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

export default defineConfig({
	...base,
	testMatch: "**/*.server-e2e.ts",
	timeout: 180_000,
	projects: [
		{
			name: "electron-server",
			testMatch: "**/*.server-e2e.ts",
		},
	],
});
