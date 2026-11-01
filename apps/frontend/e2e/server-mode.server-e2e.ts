/**
 * The desktop app against a real WorkPilot server (multi-tenant plan, MT5).
 *
 * `tests/server_e2e/app_world.py` starts the server as `deploy/` does and
 * seeds two organizations: Alice (administrator) and Bob in the first, with
 * the project "Team Board"; Carol in the second. Each person signs in from
 * their own copy of the built app, through the sign-in screen, as they
 * would. What it proves: a card Alice creates from the app is on the server
 * and shows up live on Bob's board, a card Bob deletes leaves Alice's, and
 * Carol never sees the project.
 *
 * Needs the backend's Python (`apps/backend/.venv`, or
 * `WORKPILOT_E2E_PYTHON`), Linux and port 8765 free. Run by
 * `pnpm run test:e2e:server` after `pnpm run build`, under xvfb on a
 * machine without a display (CI job `app-server-e2e`).
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { expect, type Page, test } from "@playwright/test";
import { type IsolatedApp, launchIsolatedApp } from "./app-harness";

const REPO = path.resolve(import.meta.dirname, "..", "..", "..");

interface Account {
	email: string;
	password: string;
}

interface World {
	serverUrl: string;
	project: string;
	people: Record<"alice" | "bob" | "carol", Account>;
}

interface Server {
	world: World;
	stop: () => Promise<void>;
}

async function startServer(): Promise<Server> {
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
	const firstLine = new Promise<string>((resolve, reject) => {
		const lines = createInterface({ input: child.stdout });
		lines.once("line", resolve);
		void exited.then((code) => reject(new Error(`server exited (${code})`)));
	});
	const world = JSON.parse(
		await Promise.race([
			firstLine,
			new Promise<string>((_, reject) =>
				setTimeout(() => reject(new Error("server not ready in time")), 180_000),
			),
		]),
	) as World;
	return {
		world,
		stop: async () => {
			child.stdin.end();
			await Promise.race([
				exited,
				new Promise((resolve) => setTimeout(resolve, 30_000)),
			]);
			if (child.exitCode === null) child.kill();
		},
	};
}

/** Sign in from the app's first screen, as a person of the world. */
async function signIn(page: Page, world: World, who: Account): Promise<void> {
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
async function openBoard(page: Page, project: string): Promise<void> {
	const tab = page.getByText(project, { exact: true }).first();
	const fromWelcome = page.getByRole("button", { name: `Open project ${project}` });
	await expect(tab.or(fromWelcome)).toBeVisible({ timeout: 15_000 });
	if (await fromWelcome.isVisible()) await fromWelcome.click();
	await expect(page.getByText(/Shared board/).first()).toBeVisible({
		timeout: 15_000,
	});
	await expect(page.getByRole("button", { name: /^New Task$/ })).toBeEnabled();
}

test.describe.configure({ mode: "serial" });

let server: Server;
let alice: IsolatedApp;
let bob: IsolatedApp;
let cardTitle = "";

test.beforeAll(async () => {
	test.setTimeout(240_000);
	server = await startServer();
});

test.afterAll(async () => {
	await alice?.close();
	await bob?.close();
	await server?.stop();
});

test("each member signs in to the server and finds the team's project", async () => {
	test.setTimeout(180_000);
	const { world } = server;
	alice = await launchIsolatedApp();
	await signIn(alice.page, world, world.people.alice);
	bob = await launchIsolatedApp();
	await signIn(bob.page, world, world.people.bob);

	await openBoard(alice.page, world.project);
	await openBoard(bob.page, world.project);
});

test("a card Alice creates appears on Bob's board without a reload", async () => {
	const { page } = alice;
	const title = `Document the release steps ${Date.now()}`;
	await page.getByRole("button", { name: /^New Task$/ }).click();
	const dialog = page.getByRole("dialog");
	await dialog.getByPlaceholder(/Describe the feature/).fill(title);
	await dialog.getByRole("button", { name: /^Create Task$/ }).click();
	await expect(dialog).toBeHidden({ timeout: 15_000 });

	await expect(page.getByText(title).first()).toBeVisible({ timeout: 15_000 });
	await expect(bob.page.getByText(title).first()).toBeVisible({
		timeout: 30_000,
	});
	cardTitle = title;
});

test("Bob deletes that card and it leaves Alice's board", async () => {
	const { page } = bob;
	// The card's delete button shows on hover, at the card's corner, where the
	// next column's drop zone overlaps it in a narrow window: press it directly.
	const card = page.getByRole("option", { name: cardTitle });
	await card.getByRole("button", { name: /^Delete$/ }).dispatchEvent("click");
	await page.getByRole("button", { name: /^Delete Permanently$/ }).click();

	await expect(page.getByText(cardTitle)).toHaveCount(0, { timeout: 15_000 });
	await expect(alice.page.getByText(cardTitle)).toHaveCount(0, {
		timeout: 30_000,
	});
});

test("someone of another organization never sees the project", async () => {
	const { world } = server;
	const carol = await launchIsolatedApp();
	try {
		await signIn(carol.page, world, world.people.carol);
		// Signed in, with no project: the welcome screen, and nothing of the
		// first organization anywhere in the app.
		await expect(carol.page.getByText("Welcome to WorkPilot AI!")).toBeVisible({
			timeout: 15_000,
		});
		await expect(carol.page.getByText(world.project)).toHaveCount(0);
	} finally {
		await carol.close();
	}
});
