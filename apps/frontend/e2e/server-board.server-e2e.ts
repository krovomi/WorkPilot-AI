/**
 * What the board of a server project gained after 1.5.0, from the desktop
 * app: sprints kept by the server for the whole team
 * (`shared_board/sprints.py`, `main/sprints/server-sprints.ts`), « Interroger
 * le tableau » over the server's cards (`main/board-ask/`), and the captures a
 * server card prepared for its pull request, whose published copies the
 * server sends (`shared_board/captures.py`, `main/task-captures/server-captures.ts`).
 *
 * `tests/server_e2e/app_world.py` starts the server and fills the board of
 * "Team App" (`tests/server_e2e/world_cards.py`): three backlog cards, one
 * of which prepared its captures, waiting for the team's review. Alice owns
 * the project, Bob is a member. No model answers here: the board is asked
 * by its words, as it is without a provider. Run by
 * `pnpm run test:e2e:server` after `pnpm run build`.
 */
import { expect, type Page, test } from "@playwright/test";
import { type IsolatedApp, launchIsolatedApp } from "./app-harness";
import { openBoard, type Server, signIn, startServer } from "./server-harness";

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
	await openBoard(alice.page, world.appProject);
	bob = await launchIsolatedApp();
	await signIn(bob.page, world, world.people.bob);
	await openBoard(bob.page, world.appProject);
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

/** The board's « Sprints » menu, opened. */
async function sprintsMenu(page: Page) {
	await page.getByRole("button", { name: /^(Sprints|Backlog \(no sprint\))$/ }).first().click();
	const menu = page.getByRole("dialog").filter({ hasText: "All cards" });
	await expect(menu).toBeVisible();
	return menu;
}

/** One sprint's row in that menu. */
function sprintRow(page: Page, name: string) {
	return page.locator("[data-sprint]").filter({ has: page.getByRole("button", { name, exact: true }) });
}

test("Alice plans and starts a sprint on the server, and Bob's board follows it", async () => {
	const { invoice, emails } = server.world.appCards;
	const page = alice.page;
	await (await sprintsMenu(page)).getByRole("button", { name: "New sprint" }).click();
	await page.getByLabel("Name").fill("Sprint 1");
	await page.getByLabel("Goal").fill("Invoices add up");
	await page.getByRole("button", { name: "Create", exact: true }).click();

	// Creating it opens its planning: the board's backlog on one side.
	const planning = page.getByRole("dialog").filter({ hasText: "Plan « Sprint 1 »" });
	await expect(planning).toBeVisible({ timeout: 30_000 });
	await planning.getByRole("checkbox", { name: invoice, exact: true }).click();
	await planning.getByRole("button", { name: "Add 1 card to the sprint" }).click();
	await expect(planning.getByText("1 card added to the sprint")).toBeVisible({ timeout: 30_000 });
	await planning.getByRole("button", { name: "Start the sprint" }).click();
	// Started, it is no longer offered; the planning stays open until closed.
	await expect(planning.getByRole("button", { name: "Start the sprint" })).toHaveCount(0, { timeout: 30_000 });
	await page.keyboard.press("Escape");
	await expect(planning).toBeHidden();
	await expect(page.getByTestId("kanban-sprint-banner")).toContainText("Sprint 1", { timeout: 30_000 });

	// Bob never reloaded: the server told his app, which read the sprints again.
	const banner = bob.page.getByTestId("kanban-sprint-banner");
	await expect(banner).toContainText("Sprint 1", { timeout: 30_000 });
	await banner.getByRole("button", { name: "Show only this sprint" }).click();
	await expect(bob.page.getByText(invoice, { exact: true })).toBeVisible();
	await expect(bob.page.getByText(emails, { exact: true })).toHaveCount(0);
	await banner.getByRole("button", { name: "Show every card" }).click();
	await expect(bob.page.getByText(emails, { exact: true })).toBeVisible();
	const row = sprintRow(bob.page, "Sprint 1");
	await sprintsMenu(bob.page);
	await expect(row).toContainText("Active");
	await expect(row).toContainText("Invoices add up");
	await expect(row).toContainText("0/1 cards");
	await bob.page.keyboard.press("Escape");
});

test("Alice completes the sprint; its unfinished card goes back to the backlog for everyone", async () => {
	const { invoice } = server.world.appCards;
	const page = alice.page;
	await sprintsMenu(page);
	await sprintRow(page, "Sprint 1").getByRole("button", { name: "Complete sprint" }).click();
	const closing = page.getByRole("dialog").filter({ hasText: "Complete « Sprint 1 »" });
	await expect(closing).toContainText("0 cards done (0 pts), 1 unfinished.");
	await closing.getByRole("button", { name: "Complete sprint" }).click();
	await expect(closing).toBeHidden({ timeout: 30_000 });
	await expect(page.getByTestId("kanban-sprint-banner")).toHaveCount(0, { timeout: 30_000 });

	await expect(bob.page.getByTestId("kanban-sprint-banner")).toHaveCount(0, { timeout: 30_000 });
	const menu = await sprintsMenu(bob.page);
	const row = sprintRow(bob.page, "Sprint 1");
	await expect(row).toContainText("Closed");
	await expect(row).toContainText("Done: 0 cards (0 pts) · carried over: 1");
	// A closed sprint is not planned again: no « Plan » nor « Start » on it.
	await expect(row.getByRole("button", { name: "Plan" })).toHaveCount(0);
	// The card left the closed sprint: the backlog counts all three again.
	await expect(menu.getByRole("button", { name: /Backlog \(no sprint\)/ })).toContainText("3");
	await bob.page.keyboard.press("Escape");
	await expect(bob.page.getByText(invoice, { exact: true })).toBeVisible();
});

test("Bob asks the server's board a question and finds the team's card by its words", async () => {
	const { emails, invoice } = server.world.appCards;
	const page = bob.page;
	await page.getByRole("button", { name: "Ask", exact: true }).click();
	const panel = page.getByRole("dialog").filter({ hasText: "Ask the board" });
	await expect(panel).toBeVisible();
	// The panel says where the tickets come from: the server's, with his rights.
	await expect(panel.getByText("The server's cards, with your rights")).toBeVisible();
	await panel.getByRole("textbox", { name: "Ask a question about the tickets…" }).fill("onboarding emails in French");
	await page.keyboard.press("Enter");
	await expect(panel.getByText("Keyword search")).toBeVisible({ timeout: 60_000 });
	await expect(panel.getByText("3 tickets searched")).toBeVisible();
	await expect(panel.getByText(emails, { exact: true })).toBeVisible();
	await expect(panel.getByText(invoice, { exact: true })).toHaveCount(0);
	await page.keyboard.press("Escape");
	await expect(panel).toBeHidden();
});

test("Bob reads a server card's captures, each published copy sent by the server", async () => {
	const { captures } = server.world.appCards;
	const page = bob.page;
	await page.getByText(captures, { exact: true }).first().click();
	await page.getByRole("tab", { name: "Captures" }).click();
	await expect(page.getByText("Captures for the PR")).toBeVisible({ timeout: 30_000 });
	await expect(page.getByText("Waiting for Publish")).toBeVisible();
	await expect(page.getByText("A server card: its captures are published by the server.")).toBeVisible();
	// Both copies of "Settings" are drawn, from the server: the app's mirror has no image.
	for (const side of ["Before", "After"]) {
		const image = page.getByRole("img", { name: `Settings · ${side}`, exact: true });
		await expect(image).toBeVisible({ timeout: 30_000 });
		await expect(image).toHaveJSProperty("naturalWidth", 64);
	}
	await expect(page.getByText("This copy could not be read.")).toHaveCount(0);
	// The screen whose personal data could not be replaced is held back, never shown.
	await expect(page.getByText("Held back: too much personal data, or a check failed")).toBeVisible();
	await expect(page.getByRole("img", { name: /^Profile/ })).toHaveCount(0);
	await page.keyboard.press("Escape");
});
