/**
 * The agile Kanban in the real built app (tests since 1.5.0, lot E-A): quick
 * edits, a selection dragged as one, the outcome columns, the « + » of In
 * Progress, sprints from creation to closing with carry-over, swimlanes, the
 * list, timeline and reports views.
 *
 * Every step is read twice: on screen, and in the files the app keeps
 * (`.workpilot/specs/<spec>/`, `.workpilot/sprints.json`), so a board that
 * only looks right fails. Only the model is left out: the backend folder is
 * `e2e/fake-backend/` (see `kanban-flow.e2e.ts`), whose build waits for the
 * test's `e2e-release` file.
 *
 * Left to their own threads: the pre-start check dialog, resuming an
 * interrupted task, and the board's AI (Ask, Propose the sprint: `board-ai.e2e.ts`).
 */
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { type IsolatedApp, launchIsolatedApp, makeGitProject } from "./app-harness";
import { AgileBoard } from "./kanban-agile-board";
import { enterLocalMode, fakeBackendDir, openProject } from "./local-project";

test.describe.configure({ mode: "serial" });

const ALPHA = "Alpha card";
const BRAVO = "Bravo card";
const CHARLIE = "Charlie card";
const ECHO = "Echo card";
const DELTA = "Delta card";

let ctx: IsolatedApp;
let board: AgileBoard;

test.beforeAll(async () => {
	ctx = await launchIsolatedApp({
		// Not Claude: no sign-in stands between a card and its build.
		settings: { autoBuildPath: fakeBackendDir(), selectedProvider: "openai" },
		gitIdentity: { name: "E2E User", email: "user@e2e.invalid" },
	});
	const projectDir = makeGitProject(ctx.root, "agile-project");
	await enterLocalMode(ctx);
	await openProject(ctx, projectDir);
	board = new AgileBoard(ctx.page, projectDir);
	await board.showWholeBoard(ctx.app);
});

test.afterAll(async () => {
	await ctx?.close();
});

test("quick add in Planning makes one card per Enter, each with its spec", async () => {
	await board.quickAdd("Add new task to backlog", [ALPHA, BRAVO, CHARLIE, ECHO]);
	for (const title of [ALPHA, BRAVO, CHARLIE, ECHO]) {
		await expect(board.cardIn("backlog", title)).toBeVisible();
		expect(existsSync(board.specDir(title))).toBe(true);
	}
	expect(board.specDirs()).toHaveLength(4);
});

test("a right click on a column opens its menu, whose « Add a task » opens the column's box", async () => {
	const { page } = ctx;
	const queue = board.column("queue");
	await queue.click({ button: "right", position: { x: 100, y: 500 } });
	const menu = page.getByRole("menu", { name: "Column options" });
	await expect(menu).toBeVisible();
	await menu.getByRole("menuitem", { name: "Add a task" }).click();
	const box = queue.getByRole("textbox", { name: "Describe the new task" });
	await expect(box).toBeVisible();
	await expect(box).toBeFocused();
	await box.press("Escape");
	await expect(box).toBeHidden();
	expect(board.specDirs()).toHaveLength(4);
});

test("a double click renames a card in place, and Ctrl+Z gives the old title back", async () => {
	const { page } = ctx;
	const dir = board.specDir(ALPHA);
	const renamed = "Alpha card, renamed";
	await board.card(ALPHA).getByRole("heading", { name: ALPHA }).dblclick();
	const title = page.getByRole("textbox", { name: "Task title" });
	await expect(title).toHaveValue(ALPHA);
	await title.fill(renamed);
	await title.press("Enter");
	await expect(board.cardIn("backlog", renamed)).toBeVisible();
	await expect.poll(() => board.planTitle(dir)).toBe(renamed);

	await page.keyboard.press("Control+z");
	await expect(board.cardIn("backlog", ALPHA)).toBeVisible();
	await expect(board.card(renamed)).toHaveCount(0);
	await expect.poll(() => board.planTitle(dir)).toBe(ALPHA);
	await expect(page.getByText("Undone: rename").first()).toBeVisible();
});

test("the card's right-click menu sets its priority", async () => {
	const { page } = ctx;
	const dir = board.specDir(BRAVO);
	await board.card(BRAVO).click({ button: "right" });
	const menu = page.getByRole("menu", { name: "Task menu" });
	await menu.getByRole("menuitem", { name: "Priority" }).click();
	await page.getByRole("menuitem", { name: "High" }).click();
	await expect(menu).toBeHidden();
	await expect.poll(() => board.metadata(dir).priority).toBe("high");
});

test("dragging one card of a selection moves the whole selection, and Ctrl+Z brings it back", async () => {
	const { page } = ctx;
	const alpha = board.specDir(ALPHA);
	const bravo = board.specDir(BRAVO);
	await page.getByRole("checkbox", { name: `Select task: ${ALPHA}` }).check();
	await page.getByRole("checkbox", { name: `Select task: ${BRAVO}` }).check();
	const bar = page.getByRole("toolbar", { name: "Selected tasks" });
	await expect(bar).toContainText("2 tasks selected");

	await board.drag(board.card(ALPHA), board.column("queue"));
	await expect(board.cardIn("queue", ALPHA)).toBeVisible({ timeout: 15_000 });
	await expect(board.cardIn("queue", BRAVO)).toBeVisible();
	await expect(board.cardIn("backlog", CHARLIE)).toBeVisible();
	await expect.poll(() => board.plan(alpha).status).toBe("queue");
	await expect.poll(() => board.plan(bravo).status).toBe("queue");
	// Moved by hand into the queue, they wait there: nothing started.
	await expect(board.column("in_progress").getByRole("option")).toHaveCount(0);

	await page.keyboard.press("Escape");
	await page.keyboard.press("Control+z");
	await expect(board.cardIn("backlog", ALPHA)).toBeVisible({ timeout: 15_000 });
	await expect(board.cardIn("backlog", BRAVO)).toBeVisible();
	await expect.poll(() => board.plan(alpha).status).toBe("backlog");
	await expect.poll(() => board.plan(bravo).status).toBe("backlog");
});

test("a new card deleted from the selection bar comes back with Undo", async () => {
	const { page } = ctx;
	const dir = board.specDir(ECHO);
	await page.getByRole("checkbox", { name: `Select task: ${ECHO}` }).check();
	const bar = page.getByRole("toolbar", { name: "Selected tasks" });
	await bar.getByRole("button", { name: "Delete" }).click();
	// A card nothing worked on goes without a confirmation, and only later.
	await expect(board.card(ECHO)).toHaveCount(0);
	const toast = page.getByRole("region", { name: /Notifications/ });
	await toast.getByRole("button", { name: "Undo" }).click();
	await expect(board.cardIn("backlog", ECHO)).toBeVisible();
	expect(existsSync(dir)).toBe(true);
});

test("Abandon… sets a card aside in the Abandoned column, with its reason", async () => {
	const { page } = ctx;
	const dir = board.specDir(CHARLIE);
	await board.card(CHARLIE).click({ button: "right" });
	await page.getByRole("menuitem", { name: "Abandon…" }).click();
	const dialog = page.getByRole("alertdialog", { name: "Abandon task" });
	await dialog.getByRole("textbox", { name: "Note" }).fill("The product owner dropped it");
	await dialog.getByRole("button", { name: "Abandon", exact: true }).click();
	await expect(dialog).toBeHidden();
	await expect(board.cardIn("abandoned", CHARLIE)).toBeVisible({ timeout: 15_000 });
	await expect.poll(() => board.metadata(dir).abandoned).toBe(true);
	expect(board.metadata(dir).abandonedReason).toContain("The product owner dropped it");
});

test("a run that ended on errors lands in Failed, which refuses a card dropped by hand", async () => {
	const { page } = ctx;
	const dir = board.specDir(ECHO);
	// What a build that stops on errors leaves in its plan.
	board.writePlan(dir, { ...board.plan(dir), status: "human_review", reviewReason: "errors" });
	await page.getByRole("button", { name: "Refresh Tasks" }).click();
	await expect(board.cardIn("failed", ECHO)).toBeVisible({ timeout: 15_000 });

	await board.drag(board.card(BRAVO), board.column("failed"));
	await expect(page.getByText(/Only a failed run lands in Failed/).first()).toBeVisible();
	await expect(board.cardIn("backlog", BRAVO)).toBeVisible();
	expect(board.plan(board.specDir(BRAVO)).status).toBe("backlog");
});

test("the « + » of In Progress creates a card and starts it at once", async () => {
	const before = new Set(board.specDirs());
	await board.quickAdd("Add and start", [DELTA]);
	// Its folder is the new one: the agent rewrites the plan from the start.
	const [dir] = board.specDirs().filter((spec) => !before.has(spec));
	expect(dir).toBeDefined();
	const running = board.cardIn("in_progress", DELTA);
	await expect(running).toBeVisible({ timeout: 30_000 });
	await expect(running.getByText("Coding", { exact: true })).toBeVisible({ timeout: 30_000 });
	// Let the fake agent finish: the card goes on to Human Review.
	writeFileSync(path.join(dir, "e2e-release"), "");
	await expect(board.cardIn("human_review", DELTA)).toBeVisible({ timeout: 60_000 });
	// The agent kept the plan the app wrote while it started: title and all.
	expect(board.planTitle(dir)).toBe(DELTA);
});

test("a sprint is created, planned with backlog cards, then started", async () => {
	const { page } = ctx;
	const menu = await board.openSprintMenu();
	await menu.getByRole("button", { name: "New sprint" }).click();
	const create = page.getByRole("dialog", { name: "New sprint" });
	await create.getByRole("textbox", { name: "Name" }).fill("Sprint 1");
	await create.getByRole("textbox", { name: "Goal" }).fill("Ship the first cards");
	await create.getByRole("button", { name: "Create" }).click();

	// A new sprint opens on its planning view.
	const planning = page.getByRole("dialog", { name: "Plan « Sprint 1 »" });
	await expect(planning).toBeVisible();
	const backlog = planning.getByRole("region", { name: "Backlog (no sprint)" });
	await backlog.getByRole("checkbox", { name: ALPHA }).check();
	await backlog.getByRole("checkbox", { name: BRAVO }).check();
	await backlog.getByRole("button", { name: "Add 2 cards to the sprint" }).click();
	const inSprint = planning.getByRole("region", { name: "Sprint 1" });
	await expect(inSprint.getByRole("button", { name: ALPHA })).toBeVisible();
	await expect(inSprint.getByRole("button", { name: BRAVO })).toBeVisible();

	const sprint = () => board.sprint("Sprint 1");
	await expect.poll(() => sprint()?.state).toBe("planned");
	const id = sprint()?.id;
	await expect.poll(() => board.metadata(board.specDir(ALPHA)).sprintId).toBe(id);
	await expect.poll(() => board.metadata(board.specDir(BRAVO)).sprintId).toBe(id);
	expect(board.metadata(board.specDir(CHARLIE)).sprintId).toBeUndefined();

	await planning.getByRole("button", { name: "Start the sprint" }).click();
	await expect.poll(() => sprint()?.state).toBe("active");
	await page.keyboard.press("Escape");
	await expect(planning).toBeHidden();
	const banner = page.getByTestId("kanban-sprint-banner");
	await expect(banner).toContainText("Sprint 1");
	await expect(banner).toContainText("0/2 cards");
});

test("the Sprints menu shows only the sprint's cards, then every card again", async () => {
	const menu = await board.openSprintMenu();
	await menu.getByRole("button", { name: "Sprint 1", exact: true }).click();
	await expect(board.card(ALPHA)).toBeVisible();
	await expect(board.card(BRAVO)).toBeVisible();
	await expect(board.card(ECHO)).toHaveCount(0);
	await expect(board.card(DELTA)).toHaveCount(0);
	await menu.getByRole("button", { name: /^All cards/ }).click();
	await expect(board.card(ECHO)).toBeVisible();
	await ctx.page.keyboard.press("Escape");
});

test("swimlanes by priority: dragging a card into a lane sets its priority", async () => {
	const { page } = ctx;
	const dir = board.specDir(ALPHA);
	await page.getByRole("button", { name: "Swimlanes" }).click();
	await page.getByRole("button", { name: "Priority", exact: true }).click();
	await page.keyboard.press("Escape");
	const lanes = page.getByTestId("kanban-lanes");
	await expect(lanes).toBeVisible();
	const high = lanes.getByRole("region", { name: /High/ });
	const urgent = lanes.getByRole("region", { name: /Urgent/ });
	await expect(high.getByRole("option", { name: BRAVO })).toBeVisible();
	await expect(lanes.getByRole("region", { name: /No priority/ }).getByRole("option", { name: ALPHA })).toBeVisible();

	await board.drag(board.card(ALPHA), urgent.locator('[data-column-status="backlog"]'));
	await expect(urgent.getByRole("option", { name: ALPHA })).toBeVisible({ timeout: 15_000 });
	await expect.poll(() => board.metadata(dir).priority).toBe("urgent");

	await page.getByRole("button", { name: /^Lanes:/ }).click();
	await page.getByRole("button", { name: "None", exact: true }).click();
	await page.keyboard.press("Escape");
	await expect(lanes).toBeHidden();
});

test("the list view shows each card with its sprint, sorted by a column header", async () => {
	const { page } = ctx;
	await page.getByRole("button", { name: "List", exact: true }).click();
	const table = page.getByRole("table", { name: "The board's cards as a list" });
	await expect(table).toBeVisible();
	const alpha = table.getByRole("row", { name: new RegExp(`^${ALPHA}`) });
	await expect(alpha).toContainText("Sprint 1");
	await expect(alpha).toContainText("Planning");
	await expect(table.getByRole("row", { name: new RegExp(`^${DELTA}`) })).toContainText("Human Review");

	const header = table.getByRole("columnheader", { name: "Card" });
	await header.getByRole("button").click();
	await expect(header).toHaveAttribute("aria-sort", "ascending");
	const titles = async () =>
		(await table.locator("tbody tr td:first-child").allInnerTexts()).map((text) => text.trim());
	const ascending = await titles();
	expect(ascending).toEqual([...ascending].sort((a, b) => a.localeCompare(b)));
	await header.getByRole("button").click();
	await expect(header).toHaveAttribute("aria-sort", "descending");
	expect(await titles()).toEqual([...ascending].reverse());
});

test("the timeline draws each card's stage as a bar", async () => {
	const { page } = ctx;
	await page.getByRole("button", { name: "Timeline", exact: true }).click();
	const timeline = page.getByTestId("kanban-timeline");
	await expect(timeline).toBeVisible();
	await expect(timeline.getByRole("button", { name: DELTA })).toBeVisible();
	// Each card's bar says its stage: the reviewed, failed and abandoned ones too.
	await expect(timeline.getByRole("img", { name: /^Human Review: since .*, still running$/ })).toHaveCount(1);
	await expect(timeline.getByRole("img", { name: /^Failed: since / })).toHaveCount(1);
	await expect(timeline.getByRole("img", { name: /^Abandoned: / })).toHaveCount(1);
	await expect(timeline.getByRole("img", { name: /^Planning: since / })).toHaveCount(2);
	await page.getByRole("button", { name: "Board", exact: true }).click();
	await expect(timeline).toBeHidden();
	await expect(board.cardIn("backlog", ALPHA)).toBeVisible();
});

test("the burndown report follows the active sprint", async () => {
	const { page } = ctx;
	await page.getByRole("button", { name: "Reports" }).click();
	const reports = page.getByRole("dialog", { name: "Reports" });
	await expect(reports.getByRole("tab", { name: "Burndown" })).toHaveAttribute("aria-selected", "true");
	await expect(reports.getByRole("tabpanel")).toContainText("Sprint 1");
	await expect(reports.getByText(/No sprint in progress/)).toHaveCount(0);
	await page.keyboard.press("Escape");
	await expect(reports).toBeHidden();
});

test("completing the sprint closes it and carries its open cards to the next one", async () => {
	const { page } = ctx;
	const menu = await board.openSprintMenu();
	await menu.getByRole("button", { name: "New sprint" }).click();
	const create = page.getByRole("dialog", { name: "New sprint" });
	await create.getByRole("textbox", { name: "Name" }).fill("Sprint 2");
	await create.getByRole("button", { name: "Create" }).click();
	const planning = page.getByRole("dialog", { name: "Plan « Sprint 2 »" });
	await expect(planning).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(planning).toBeHidden();
	await expect.poll(() => board.sprint("Sprint 2")?.state).toBe("planned");

	await page.getByTestId("kanban-sprint-banner").getByRole("button", { name: "Complete sprint" }).click();
	const complete = page.getByRole("dialog", { name: "Complete « Sprint 1 »" });
	await expect(complete).toContainText("0 cards done");
	// The next planned sprint is offered first.
	await expect(complete.getByRole("button", { name: "Sprint 2" })).toHaveAttribute("aria-pressed", "true");
	await complete.getByRole("button", { name: "Complete sprint" }).click();
	await expect(complete).toBeHidden();

	await expect.poll(() => board.sprint("Sprint 1")?.state).toBe("closed");
	expect(board.sprint("Sprint 1")?.report).toMatchObject({ done: 0, carried: 2 });
	const next = board.sprint("Sprint 2")?.id;
	await expect.poll(() => board.metadata(board.specDir(ALPHA)).sprintId).toBe(next);
	await expect.poll(() => board.metadata(board.specDir(BRAVO)).sprintId).toBe(next);
	await expect(page.getByTestId("kanban-sprint-banner")).toHaveCount(0);

	// The closed sprint now feeds the velocity.
	await page.getByRole("button", { name: "Reports" }).click();
	const reports = page.getByRole("dialog", { name: "Reports" });
	await reports.getByRole("tab", { name: "Velocity" }).click();
	await expect(reports.getByRole("tabpanel")).toContainText("Average of the last 3 sprints");
	await expect(reports.getByText(/No sprint closed yet/)).toHaveCount(0);
	await page.keyboard.press("Escape");
});
