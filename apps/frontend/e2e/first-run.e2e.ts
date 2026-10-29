/**
 * A new user's first minutes, against the real built app (plan of 29 October,
 * lot N3). No step is skipped when the app does not start: a launch failure
 * fails the suite, which is the point.
 */
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
	answerNextFolderPicker,
	type IsolatedApp,
	launchIsolatedApp,
	makeGitProject,
} from "./app-harness";

test.describe.configure({ mode: "serial" });

let ctx: IsolatedApp;
let projectDir: string;

test.beforeAll(async () => {
	ctx = await launchIsolatedApp();
	projectDir = makeGitProject(ctx.root, "demo-project");
});

test.afterAll(async () => {
	await ctx?.close();
});

test("first start offers local mode and reaches the welcome screen", async () => {
	const { page } = ctx;
	await page.getByRole("button", { name: /Mode local|Local mode/ }).click();
	// The setup wizard opens a moment after the first start.
	const skip = page.getByRole("button", { name: /Skip Setup/ });
	await skip.waitFor({ timeout: 15_000 }).then(
		() => skip.click(),
		() => undefined,
	);
	await expect(page.getByText("Welcome to WorkPilot AI!")).toBeVisible();
});

test("an existing folder becomes a project, initialized from where it lands", async () => {
	const { app, page } = ctx;
	await answerNextFolderPicker(app, projectDir);
	await page.getByRole("button", { name: /Open existing project/ }).first().click();
	await page.getByRole("button", { name: "Open existing project folder" }).click();

	// The folder has no .workpilot/ yet: adding it opens the project's
	// settings, where it is initialized (F122).
	const initialize = page.getByRole("button", {
		name: "Initialize WorkPilot AI",
		exact: true,
	});
	await expect(initialize).toBeVisible({ timeout: 15_000 });
	await initialize.click();
	await expect(initialize).toBeHidden({ timeout: 30_000 });
	expect(existsSync(path.join(projectDir, ".workpilot"))).toBe(true);

	await page.keyboard.press("Escape");
	await expect(page.getByRole("button", { name: /^New Task$/ })).toBeEnabled();
});

test("a task created from the dialog lands in Planning, with its spec on disk", async () => {
	const { page } = ctx;
	await page.getByRole("button", { name: /^New Task$/ }).click();
	const dialog = page.getByRole("dialog");
	await dialog.getByPlaceholder(/Describe the feature/).fill(
		"Add a CONTRIBUTING.md that explains how to run the tests.",
	);
	await dialog.getByRole("button", { name: /^Create Task$/ }).click();
	await expect(dialog).toBeHidden({ timeout: 15_000 });

	await expect(page.getByText(/CONTRIBUTING/).first()).toBeVisible({
		timeout: 15_000,
	});
	const specs = path.join(projectDir, ".workpilot", "specs");
	await expect
		.poll(() => (existsSync(specs) ? readdirSync(specs).length : 0))
		.toBeGreaterThan(0);
});
