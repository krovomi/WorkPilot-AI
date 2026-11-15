/**
 * The pieces every `*.server-e2e.ts` spec shares: a real WorkPilot server
 * started by `tests/server_e2e/app_world.py`, seeded with two organizations
 * (Alice, its administrator, and Bob in the first, with the project "Team
 * Board"; Carol in the second), and the app's own screens to sign in and
 * open the project's board.
 *
 * Needs the backend's Python (`apps/backend/.venv`, or
 * `WORKPILOT_E2E_PYTHON`), Linux and port 8765 free.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { expect, type Page } from "@playwright/test";

const REPO = path.resolve(import.meta.dirname, "..", "..", "..");

export interface Account {
	email: string;
	password: string;
}

export type Who = "alice" | "bob" | "carol";

export interface World {
	serverUrl: string;
	project: string;
	people: Record<Who, Account>;
}

export interface Server {
	world: World;
	stop: () => Promise<void>;
}

export async function startServer(): Promise<Server> {
	const python =
		process.env.WORKPILOT_E2E_PYTHON ||
		path.join(REPO, "apps", "backend", ".venv", "bin", "python");
	if (!existsSync(python)) {
		throw new Error(`the backend's Python is missing: ${python}`);
	}
	const child = spawn(python, ["-m", "tests.server_e2e.app_world"], {
		cwd: REPO,
		stdio: ["pipe", "pipe", "inherit"],
	});
	const exited = new Promise<number | null>((resolve) =>
		child.once("exit", (code) => resolve(code)),
	);
	// Closing its standard input ends the script, which stops the server
	// and removes its files; a kill only comes after a grace period.
	const stop = async () => {
		child.stdin.end();
		await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 30_000))]);
		if (child.exitCode === null) child.kill();
	};
	// The passwords are drawn here and go to the server only through the
	// script's standard input; it answers with the URL and the emails.
	const passwords = {
		alice: randomBytes(18).toString("base64url"),
		bob: randomBytes(18).toString("base64url"),
		carol: randomBytes(18).toString("base64url"),
	} satisfies Record<Who, string>;
	child.stdin.write(`${JSON.stringify(passwords)}\n`);
	const firstLine = new Promise<string>((resolve, reject) => {
		const lines = createInterface({ input: child.stdout });
		lines.once("line", resolve);
		void exited.then((code) => reject(new Error(`server exited (${code})`)));
	});
	let answer: { serverUrl: string; project: string; emails: Record<Who, string> };
	try {
		answer = JSON.parse(
			await Promise.race([
				firstLine,
				new Promise<string>((_, reject) =>
					setTimeout(() => reject(new Error("server not ready in time")), 180_000),
				),
			]),
		);
	} catch (error) {
		await stop();
		throw error;
	}
	const account = (who: Who): Account => ({
		email: answer.emails[who],
		password: passwords[who],
	});
	const world: World = {
		serverUrl: answer.serverUrl,
		project: answer.project,
		people: { alice: account("alice"), bob: account("bob"), carol: account("carol") },
	};
	return { world, stop };
}

/** Sign in from the app's first screen, as a person of the world. */
export async function signIn(page: Page, world: World, who: Account): Promise<void> {
	await page.locator("#server-url").fill(world.serverUrl);
	await page.locator("#login-email").fill(who.email);
	await page.locator("#login-password").fill(who.password);
	await page.getByRole("button", { name: /^(Sign in|Connexion)$/ }).click();
	await expect(page.locator("#login-password")).toBeHidden({ timeout: 30_000 });
	// The setup wizard may open a moment after the first start.
	const skip = page.getByRole("button", { name: /Skip Setup/ });
	await skip.waitFor({ timeout: 15_000 }).then(
		() => skip.click(),
		() => undefined,
	);
}

/** The project's board, opened from the welcome screen unless the app
 * already opened it (it does when the person has a single project). */
export async function openBoard(page: Page, project: string): Promise<void> {
	const tab = page.getByText(project, { exact: true }).first();
	const fromWelcome = page.getByRole("button", { name: `Open project ${project}` });
	// On the welcome screen both match (the name is inside the button).
	await expect(tab.or(fromWelcome).first()).toBeVisible({ timeout: 15_000 });
	if (await fromWelcome.isVisible()) await fromWelcome.click();
	await expect(page.getByText(/Shared board/).first()).toBeVisible({
		timeout: 15_000,
	});
	await expect(page.getByRole("button", { name: /^New Task$/ })).toBeEnabled();
}


/**
 * Open a view from the sidebar: its space in the rail (unless already open),
 * then the view's entry in that space's list.
 */
export async function openView(page: Page, space: string, view: string): Promise<void> {
	const rail = page.getByRole("navigation", { name: "Menu spaces" });
	const spaceButton = rail.getByRole("button", { name: space, exact: true });
	if ((await spaceButton.getAttribute("aria-pressed")) !== "true") {
		await spaceButton.click();
	}
	await expect(spaceButton).toHaveAttribute("aria-pressed", "true");
	// The rail's button of the same name comes first in the page.
	await page.getByRole("button", { name: view, exact: true }).last().click();
}
