/**
 * A server project's GitHub and GitLab, from the desktop app: its issues and
 * its pull or merge requests come through the server's relay
 * (`shared_features/forge.py`, `forge_gitlab.py`), which calls the forge
 * with the token each person stored on the server, never someone else's.
 *
 * `tests/server_e2e/app_world.py` starts the server with two fake forges
 * (`tests/server_e2e/fake_forge.py`) reached under their real names through
 * a proxy: "Team Site" is on GitHub, "Team Docs" on GitLab, and Alice and Bob
 * are members of both. The fake forges record a tag of each token they get,
 * so the spec checks whose token each call carried without writing one out.
 * Run by `pnpm run test:e2e:server` after `pnpm run build`.
 */
import { randomBytes } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { type IsolatedApp, launchIsolatedApp } from "./app-harness";
import {
	forgeCalls,
	openBoard,
	openView,
	type Server,
	signIn,
	startServer,
	tokenTag,
} from "./server-harness";

test.describe.configure({ mode: "serial" });

const INTEGRATIONS = "Git & Integrations";

let server: Server;
let alice: IsolatedApp;
let bob: IsolatedApp;
const bobGitHub = `ghp_${randomBytes(12).toString("hex")}`;
const aliceGitLab = `glpat-${randomBytes(12).toString("hex")}`;

test.beforeAll(async () => {
	test.setTimeout(300_000);
	server = await startServer();
	const { world } = server;
	alice = await launchIsolatedApp();
	await signIn(alice.page, world, world.people.alice);
	bob = await launchIsolatedApp();
	await signIn(bob.page, world, world.people.bob);
	await openBoard(bob.page, world.githubProject);
});

test.afterEach(async () => {
	const testInfo = test.info();
	if (testInfo.status !== testInfo.expectedStatus && bob) {
		await testInfo.attach("bob", {
			body: await bob.page.screenshot({ timeout: 10_000 }).catch(() => Buffer.from("")),
			contentType: "image/png",
		});
	}
});

test.afterAll(async () => {
	await alice?.close();
	await bob?.close();
	await server?.stop();
});

/** Store one of the person's forge tokens on the server, from the settings. */
async function storeToken(page: Page, label: string, token: string): Promise<void> {
	await page.getByRole("button", { name: "Application Settings" }).click();
	await page.getByRole("button", { name: "My tokens on the server" }).click();
	await page.getByLabel(label).fill(token);
	await page
		.getByLabel(label)
		.locator("xpath=ancestor::*[.//button[normalize-space()='Save']][1]")
		.getByRole("button", { name: "Save" })
		.click();
	await expect(page.getByLabel(label)).toHaveValue("", { timeout: 30_000 });
	await page.keyboard.press("Escape");
}

test("without his own GitHub token, Bob is told where to add it", async () => {
	const { page } = bob;
	await openView(page, INTEGRATIONS, "GitHub issues");
	await expect(
		page.getByText(/Add your GitHub token in Settings → My tokens on the server/).first(),
	).toBeVisible({ timeout: 30_000 });
	// Nothing reached GitHub: the server refused before calling it.
	expect(await forgeCalls(server.world)).toEqual([]);
});

test("with it, Bob reads the project's issues, and GitHub saw his token", async () => {
	const { page } = bob;
	await storeToken(page, "GitHub token", bobGitHub);
	// The view checks the connection when it opens.
	await openView(page, "Workspace", "Kanban board");
	await openView(page, INTEGRATIONS, "GitHub issues");
	await expect(page.getByText("The onboarding guide is missing").first()).toBeVisible({
		timeout: 30_000,
	});
	await expect(page.getByText("Greeting fails for an empty team").first()).toBeVisible();

	await page.getByText("The onboarding guide is missing").first().click();
	await expect(
		page.getByText("New teammates have nothing to read on their first day.").first(),
	).toBeVisible({ timeout: 30_000 });

	const calls = (await forgeCalls(server.world)).filter((c) => c.host === "api.github.com");
	expect(calls.map((c) => c.path)).toContain("/repos/e2e-team/team-site/issues");
	expect(new Set(calls.map((c) => c.token))).toEqual(new Set([tokenTag(bobGitHub)]));
	expect(await page.content()).not.toContain(bobGitHub);
});

test("Bob lists the open pull requests, with their diff stats", async () => {
	const { page } = bob;
	await openView(page, INTEGRATIONS, "GitHub PRs");
	await expect(page.getByText("Add a welcome banner").first()).toBeVisible({
		timeout: 30_000,
	});
	const calls = await forgeCalls(server.world);
	expect(calls.some((c) => c.method === "POST" && c.path === "/graphql")).toBe(true);
});

test("Alice's GitHub views do not borrow Bob's token", async () => {
	const { page } = alice;
	const before = (await forgeCalls(server.world)).length;
	await openBoard(page, server.world.githubProject);
	await openView(page, INTEGRATIONS, "GitHub issues");
	await expect(
		page.getByText(/Add your GitHub token in Settings → My tokens on the server/).first(),
	).toBeVisible({ timeout: 30_000 });
	expect((await forgeCalls(server.world)).slice(before)).toEqual([]);
});

test("on the GitLab project, Alice reads issues and merge requests with her token", async () => {
	const { page } = alice;
	await storeToken(page, "GitLab token", aliceGitLab);
	await openBoard(page, server.world.gitlabProject);
	// A GitLab project offers GitLab's views, not GitHub's.
	await openView(page, INTEGRATIONS, "GitLab issues");
	await expect(page.getByRole("button", { name: "GitHub issues", exact: true })).toHaveCount(0);
	await expect(page.getByText("Write the release checklist").first()).toBeVisible({
		timeout: 30_000,
	});
	await openView(page, INTEGRATIONS, "GitLab MRs");
	await expect(page.getByText("Document the deploy steps").first()).toBeVisible({
		timeout: 30_000,
	});
	const calls = (await forgeCalls(server.world)).filter((c) => c.host === "gitlab.e2e.test");
	expect(calls.map((c) => c.path)).toContain("/api/v4/projects/e2e-team%2Fteam-docs/issues");
	expect(new Set(calls.map((c) => c.token))).toEqual(new Set([tokenTag(aliceGitLab)]));
});
