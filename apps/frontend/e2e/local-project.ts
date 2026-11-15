/**
 * The steps every local-mode spec starts from: local mode chosen, the setup
 * wizard skipped, one git project opened and initialized. And the fake
 * backend the Kanban flow runs its builds with.
 */
import { existsSync, lstatSync, symlinkSync } from "node:fs";
import path from "node:path";
import { expect } from "@playwright/test";
import { answerNextFolderPicker, type IsolatedApp } from "./app-harness";

const BACKEND = path.resolve(import.meta.dirname, "..", "..", "backend");
const FAKE_BACKEND = path.resolve(import.meta.dirname, "fake-backend");

/** Local mode, then the welcome screen (the wizard is skipped). */
export async function enterLocalMode(ctx: IsolatedApp): Promise<void> {
	const { page } = ctx;
	await page.getByRole("button", { name: /Mode local|Local mode/ }).click();
	// The setup wizard opens a moment after the first start.
	const skip = page.getByRole("button", { name: /Skip Setup/ });
	await skip.waitFor({ timeout: 15_000 }).then(
		() => skip.click(),
		() => undefined,
	);
	await expect(page.getByText("Welcome to WorkPilot AI!")).toBeVisible();
}

/** Opens `dir` as a project and initializes it; its board is then on screen. */
export async function openProject(ctx: IsolatedApp, dir: string): Promise<void> {
	const { app, page } = ctx;
	await answerNextFolderPicker(app, dir);
	await page.getByRole("button", { name: /Open existing project/ }).first().click();
	await page.getByRole("button", { name: "Open existing project folder" }).click();
	const initialize = page.getByRole("button", {
		name: "Initialize WorkPilot AI",
		exact: true,
	});
	await expect(initialize).toBeVisible({ timeout: 15_000 });
	await initialize.click();
	await expect(initialize).toBeHidden({ timeout: 30_000 });
	await page.keyboard.press("Escape");
	await expect(page.getByRole("button", { name: /^New Task$/ })).toBeEnabled();
}

/**
 * The folder to give the app as its backend (`autoBuildPath`) so that a
 * build runs `e2e/fake-backend/` instead of the agents. It uses the
 * backend's own virtualenv (`apps/backend/.venv`, which `pnpm run
 * install:all` or CI's setup-python-backend makes), linked beside it.
 */
export function fakeBackendDir(): string {
	const venv = path.join(BACKEND, ".venv");
	if (!existsSync(venv)) {
		throw new Error(`no backend virtualenv at ${venv}: install the backend first`);
	}
	const link = path.join(FAKE_BACKEND, ".venv");
	const linked = (() => {
		try {
			return lstatSync(link).isSymbolicLink();
		} catch {
			return false;
		}
	})();
	if (!linked) symlinkSync(venv, link, "junction");
	return FAKE_BACKEND;
}
