/**
 * The pieces every `*.server-e2e.ts` spec shares: a real WorkPilot server
 * started by `tests/server_e2e/app_world.py`, seeded with two organizations
 * (Alice, its administrator, and Bob in the first, with the projects "Team
 * Board", "Team Site" on a fake GitHub, "Team Docs" on a fake GitLab and
 * "Team App", whose board the world filled; Carol in the second), and the
 * app's own screens to sign in and open a project's board.
 *
 * Needs the backend's Python (`apps/backend/.venv`, or
 * `WORKPILOT_E2E_PYTHON`), Linux and port 8765 free.
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { expect, type Page } from "@playwright/test";
import { withoutCredentials } from "./app-harness";

const REPO = path.resolve(import.meta.dirname, "..", "..", "..");

export interface Account {
	email: string;
	password: string;
}

export type Who = "alice" | "bob" | "carol";

export interface World {
	serverUrl: string;
	project: string;
	/** The team's project on GitHub, and the one on GitLab (`fake_forge.py`). */
	githubProject: string;
	gitlabProject: string;
	/**
	 * A project whose board the world filled (`tests/server_e2e/world_cards.py`):
	 * the titles of its cards, by what each one is for.
	 */
	appProject: string;
	appCards: { captures: string; emails: string; invoice: string };
	/** Where the fake forges say what they were asked (`forgeCalls`). */
	forgeUrl: string;
	people: Record<Who, Account>;
}

/** A call the fake GitHub or GitLab received through the server's relay. */
export interface ForgeCall {
	host: string;
	method: string;
	path: string;
	query: string;
	/** The SHA-256 prefix of the token it carried (`tokenTag`), "" for none. */
	token: string;
	body: unknown;
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
	// The server gets the developer's environment without its credentials,
	// as the app does: it needs none of them.
	const child = spawn(python, ["-m", "tests.server_e2e.app_world"], {
		cwd: REPO,
		env: withoutCredentials(process.env),
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
	let answer: Omit<World, "people"> & { emails: Record<Who, string> };
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
		githubProject: answer.githubProject,
		gitlabProject: answer.gitlabProject,
		appProject: answer.appProject,
		appCards: answer.appCards,
		forgeUrl: answer.forgeUrl,
		people: { alice: account("alice"), bob: account("bob"), carol: account("carol") },
	};
	return { world, stop };
}

/** What the fake forges were asked so far, oldest first. */
export async function forgeCalls(world: World): Promise<ForgeCall[]> {
	const answer = await fetch(`${world.forgeUrl}/calls`);
	if (!answer.ok) throw new Error(`fake forge: ${answer.status}`);
	return (await answer.json()) as ForgeCall[];
}

/** What a fake forge keeps of a token (`fake_forge.token_tag`). */
export function tokenTag(token: string): string {
	return createHash("sha256").update(token, "utf8").digest("hex").slice(0, 16);
}

/** Sign in from the app's first screen, as a person of the world. */
export async function signIn(page: Page, world: World, who: Account): Promise<void> {
	await page.locator("#server-url").fill(world.serverUrl);
	await page.locator("#login-email").fill(who.email);
	await page.locator("#login-password").fill(who.password);
	await page.getByRole("button", { name: /^(Sign in|Connexion)$/ }).click();
	await expect(page.locator("#login-password")).toBeHidden({ timeout: 30_000 });
	// Two dialogs may open a moment after the sign-in, in either order: the
	// notice of what the server measures (once per organization) and the
	// setup wizard (first start). The notice can open over the wizard while
	// its button is being clicked: a click that does not land is tried again,
	// on whichever dialog is on top by then.
	const notice = page.getByRole("button", { name: /^(I understand|J'ai compris)$/ });
	const skip = page.getByRole("button", { name: /Skip Setup/ });
	const deadline = Date.now() + 60_000;
	for (let closed = 0; closed < 2 && Date.now() < deadline; ) {
		const shown = await notice
			.or(skip)
			.first()
			.waitFor({ timeout: 15_000 })
			.then(
				() => true,
				() => false,
			);
		if (!shown) return;
		const button = (await notice.isVisible()) ? notice : skip;
		const landed = await button.click({ timeout: 5_000 }).then(
			() => true,
			() => false,
		);
		if (landed) closed++;
	}
	await expect(notice).toBeHidden();
	await expect(skip).toBeHidden();
}

/**
 * A project's board: from the welcome screen, from its tab, or, when the
 * app opened another project first (it opens a tab for the first one only),
 * from the team's projects listed by the "Add project" dialog.
 */
export async function openBoard(page: Page, project: string): Promise<void> {
	const tab = page.getByText(project, { exact: true }).first();
	const fromWelcome = page.getByRole("button", { name: `Open project ${project}` });
	// Another project's tab, shown with the button that adds or opens one.
	const tabBar = page.getByText(/Shared board/).or(page.getByRole("button", { name: "Add project" }));
	// On the welcome screen both match (the name is inside the button).
	await expect(tab.or(fromWelcome).or(tabBar).first()).toBeVisible({
		timeout: 15_000,
	});
	// The app may still be opening the project's tab itself.
	await tab
		.or(fromWelcome)
		.first()
		.waitFor({ timeout: 5_000 })
		.catch(() => undefined);
	if (await fromWelcome.isVisible()) {
		await fromWelcome.click();
	} else if (await tab.isVisible()) {
		await tab.click();
	} else {
		await page.getByRole("button", { name: "Add project" }).click();
		await page.getByRole("button", { name: `Open ${project}`, exact: true }).click();
	}
	await expect(tab).toBeVisible({ timeout: 15_000 });
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
