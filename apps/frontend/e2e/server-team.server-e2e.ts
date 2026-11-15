/**
 * What a team shares through the desktop app on a WorkPilot server, beyond
 * the board (`server-mode.server-e2e.ts`): the views a server project
 * offers, the analyses that run on the server and whose last report every
 * member reads, the history and dashboard built from the team's runs, the
 * administration of the organization, and a person's own tokens kept on the
 * server.
 *
 * `tests/server_e2e/app_world.py` starts the server and seeds it: Alice
 * administers the first organization, Bob is a member of its project "Team
 * Board", whose repository has a guide citing a function the code does not
 * have. Run by `pnpm run test:e2e:server` after `pnpm run build`, under xvfb
 * on a machine without a display (CI job `app-server-e2e`).
 */
import { randomBytes } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { type IsolatedApp, launchIsolatedApp } from "./app-harness";
import { openBoard, openView, type Server, signIn, startServer } from "./server-harness";

test.describe.configure({ mode: "serial" });

let server: Server;
let alice: IsolatedApp;
let bob: IsolatedApp;

test.beforeAll(async () => {
	test.setTimeout(300_000);
	server = await startServer();
	const { world } = server;
	alice = await launchIsolatedApp();
	await signIn(alice.page, world, world.people.alice);
	await openBoard(alice.page, world.project);
	bob = await launchIsolatedApp();
	await signIn(bob.page, world, world.people.bob);
	await openBoard(bob.page, world.project);
});

test.afterEach(async () => {
	const testInfo = test.info();
	// A failure shows both windows: the page Playwright attaches is Alice's.
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

/** The names of the views listed in one space of the sidebar. */
async function viewsOf(page: Page, space: string): Promise<string[]> {
	const rail = page.getByRole("navigation", { name: "Menu spaces" });
	const button = rail.getByRole("button", { name: space, exact: true });
	if ((await button.getAttribute("aria-pressed")) !== "true") await button.click();
	await expect(page.getByRole("heading", { level: 2, name: space, exact: true }).first()).toBeVisible();
	// Each entry is the first button of its row; the row's star comes after it.
	const entries = page.locator("xpath=//div[contains(@class, 'group/nav-item')]/button[1]");
	await expect(entries.first()).toBeVisible();
	const names = (await entries.allInnerTexts()).map((name) => name.trim());
	return names;
}

test("a server project offers the views the server serves, and no others", async () => {
	const { page } = alice;
	expect(await viewsOf(page, "Development")).toEqual([
		"Debt and refactoring",
		"Docs and drift",
		"Flaky tests",
	]);
	expect(await viewsOf(page, "Explore")).toEqual(["Insights", "Project context", "Ideation"]);
	expect(await viewsOf(page, "Planning")).toEqual([
		"Roadmap",
		"Analytics",
		"Costs and estimation",
		"Changelog",
	]);
	// What a server does not serve, a server project does not offer: the
	// agent terminals, which run on this computer, are in no space.
	for (const space of ["Workspace", "Toolbox"]) {
		expect(await viewsOf(page, space)).not.toContain("Agent terminals");
	}
});

test("teammates see each other on the board and talk in the team chat", async () => {
	// Both boards hold the project's live stream: each sees the other there.
	for (const [me, other] of [
		[alice, "bob"],
		[bob, "alice"],
	] as const) {
		await openView(me.page, "Workspace", "Kanban board");
		await expect(me.page.getByRole("img", { name: other, exact: true })).toBeVisible({
			timeout: 30_000,
		});
	}

	const message = `Standup moved to 10:30 (${randomBytes(3).toString("hex")})`;
	await alice.page.getByRole("button", { name: "Team chat" }).click();
	const box = alice.page.getByPlaceholder("Write to the team… (@ai to ask the AI)");
	await box.fill(message);
	await alice.page.getByRole("button", { name: "Send", exact: true }).click();
	await expect(alice.page.getByText(message)).toBeVisible({ timeout: 15_000 });

	// Bob opens the chat after it was written: the room keeps its history.
	await bob.page.getByRole("button", { name: "Team chat" }).click();
	await expect(bob.page.getByText(message)).toBeVisible({ timeout: 15_000 });
	for (const me of [alice, bob]) {
		await me.page.getByRole("button", { name: "Close the chat" }).click();
	}
});

test("the documentation drift Alice finds on the server is the report Bob reads", async () => {
	test.setTimeout(240_000);
	const { page } = alice;
	await openView(page, "Development", "Docs and drift");
	await page.getByRole("button", { name: /^(Run scan|Scan again)$/ }).click();
	// The guide cites greet_everyone(), which app.py does not define.
	await expect(page.getByText(/greet_everyone/).first()).toBeVisible({ timeout: 180_000 });

	// Bob runs nothing: the last report saved on the server is his too.
	await openView(bob.page, "Development", "Docs and drift");
	await expect(bob.page.getByText(/greet_everyone/).first()).toBeVisible({ timeout: 30_000 });
});

test("the technical debt scan runs on the server for a server project", async () => {
	test.setTimeout(240_000);
	const { page } = alice;
	await openView(page, "Development", "Debt and refactoring");
	await page.getByRole("button", { name: "Scan now" }).click();
	await expect(page.getByText(/Last scanned:/)).toBeVisible({ timeout: 180_000 });
	await expect(page.getByRole("alert")).toHaveCount(0);
});

test("a card Bob starts runs on the server, in the team's history and dashboard", async () => {
	test.setTimeout(240_000);
	const stamp = Date.now();
	const title = `Write the onboarding guide ${stamp}`;
	const { page } = bob;
	await openView(page, "Workspace", "Kanban board");
	await page.getByRole("button", { name: /^New Task$/ }).click();
	const dialog = page.getByRole("dialog");
	await dialog.getByPlaceholder(/Describe the feature/).fill(title);
	await dialog.getByRole("button", { name: /^Create Task$/ }).click();
	await expect(dialog).toBeHidden({ timeout: 15_000 });
	const card = page.getByRole("option", { name: title });
	await card.getByRole("button", { name: "Start", exact: true }).dispatchEvent("click");

	// Alice reads the run the server made for Bob's card, named after its
	// spec: the fake agent wrote the spec and the run completed, by Bob.
	await openView(alice.page, "Workspace", "Agent history");
	const history = alice.page.getByRole("main");
	const session = history
		.getByRole("button")
		.filter({ hasText: `write-the-onboarding-guide-${stamp}` });
	await expect(async () => {
		await history.getByRole("button", { name: "Refresh" }).click();
		await expect(session.first()).toContainText("completed", { timeout: 5_000 });
	}).toPass({ timeout: 120_000 });
	await expect(session.first()).toContainText("by bob");

	await openView(alice.page, "Workspace", "Dashboard");
	// One card on the board, none done yet: "Total Tasks 1", "0 completed".
	await expect(alice.page.getByRole("main")).toContainText(/Total Tasks\s*1\s*0 completed/, {
		timeout: 30_000,
	});
});

test("Alice runs the organization from the administration console", async () => {
	const { page } = alice;
	const { world } = server;
	await openView(page, "Administration", "Administration");
	const tabs = page.getByRole("main").getByRole("navigation");

	await expect(page.getByText("Active members", { exact: true })).toBeVisible({ timeout: 30_000 });

	await tabs.getByRole("button", { name: "Members", exact: true }).click();
	await expect(page.getByText(world.people.bob.email).first()).toBeVisible({ timeout: 30_000 });

	// An organization administrator invites members and viewers; a server
	// administrator, who reaches every organization, is not hers to make.
	await tabs.getByRole("button", { name: "Invitations", exact: true }).click();
	const role = page.getByLabel("Role", { exact: true });
	await expect(role.locator("option")).toHaveText(["Member", "Viewer"]);
	const invited = `dave-${randomBytes(4).toString("hex")}@example.com`;
	await page.getByLabel("New user's email").fill(invited);
	await page.getByRole("button", { name: "Invite", exact: true }).click();
	await expect(page.getByText(/Share this single-use link/)).toBeVisible({ timeout: 30_000 });
	await expect(page.getByText(invited)).toBeVisible();

	await tabs.getByRole("button", { name: "Groups", exact: true }).click();
	await page.getByRole("button", { name: "New group" }).first().click();
	await page.getByLabel("Name", { exact: true }).fill("Desktop team");
	await page.getByRole("button", { name: "Create group" }).click();
	await page.getByText("Desktop team").first().click({ timeout: 30_000 });
	await page.getByRole("combobox", { name: "Add to the group" }).selectOption({ label: "bob" });
	await page.getByRole("button", { name: "Add to the group" }).click();
	await expect(page.getByText(/1 members?,/)).toBeVisible({ timeout: 30_000 });

	// Each change is on the record, under Alice's name.
	await tabs.getByRole("button", { name: "Audit", exact: true }).click();
	for (const action of ["auth.invitation.created", "org.group.created", "org.group.member_added"]) {
		const row = page.getByRole("row").filter({ hasText: action });
		await expect(row.first()).toContainText(world.people.alice.email, { timeout: 30_000 });
	}
});

test("Bob keeps his GitHub token on the server, and never sees it again", async () => {
	const { page } = bob;
	await page.getByRole("button", { name: "Application Settings" }).click();
	await page.getByRole("button", { name: "My tokens on the server" }).click();
	const token = `ghp_${randomBytes(12).toString("hex")}`;
	const field = page.getByLabel("GitHub token");
	await field.fill(token);
	await page.getByRole("button", { name: "Save" }).first().click();
	await expect(page.getByText("Stored").first()).toBeVisible({ timeout: 30_000 });
	await expect(page.getByLabel("GitHub token")).toHaveValue("");
	expect(await page.content()).not.toContain(token);
});
