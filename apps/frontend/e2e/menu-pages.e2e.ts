/**
 * Every page of the left menu opens in the real built app, on a fresh local
 * project, without an error (coverage plan, lot E1).
 *
 * The pages are not listed here: each space of the rail is opened and every
 * entry its panel shows is clicked, the beta pages of the Labo included; a
 * hub's tabs are each selected, and a tab that launches a tool opens it.
 * So a page added to the menu is opened here the day it appears. The spaces
 * themselves are listed, and checked against the rail, so that a new space
 * is named in this file.
 *
 * "Without an error" is what the user would see or the app would log: an
 * uncaught exception, a `console.error`, the error boundary's "Something
 * went wrong", an empty page, a page that does not become the current one.
 */
import { expect, type Locator, type Page, test } from "@playwright/test";
import { type IsolatedApp, launchIsolatedApp, makeGitProject } from "./app-harness";
import { enterLocalMode, openProject } from "./local-project";

test.describe.configure({ mode: "serial" });

/** The rail's spaces, in its order (`sidebar/spaces.ts`, `nav-model.ts`). */
const SPACES = [
	"workspace",
	"agents",
	"development",
	"explore",
	"git-integrations",
	"planning",
	"toolbox",
	"__labo__",
] as const;

let ctx: IsolatedApp;
let problems: string[] = [];

/**
 * A resource the page could not fetch from the internet (an avatar, a
 * catalog) depends on the network the run has, not on the app: only those
 * are let through. A local one (the app's files, its backend) is a problem.
 */
function isRemoteLoadFailure(text: string, url: string): boolean {
	return (
		text.startsWith("Failed to load resource") &&
		/^https?:\/\//.test(url) &&
		!/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url)
	);
}

function watchForProblems(page: Page): void {
	page.on("pageerror", (error) => problems.push(`uncaught: ${error.message}`));
	page.on("console", (message) => {
		if (message.type() !== "error") return;
		if (isRemoteLoadFailure(message.text(), message.location().url)) return;
		problems.push(`console.error: ${message.text().slice(0, 500)}`);
	});
}

/** Fails with what went wrong since the last check, on the page named. */
async function expectNoProblem(page: Page, where: string): Promise<void> {
	// Let what the page starts on mount (IPC, backend reads) come back.
	await page.waitForTimeout(400);
	const seen = problems;
	problems = [];
	expect(seen, where).toEqual([]);
	await expect(page.getByText("Something went wrong"), where).toHaveCount(0);
	expect(
		await page.evaluate(() => document.getElementById("root")?.childElementCount ?? 0),
		`${where}: the app is still rendered`,
	).toBeGreaterThan(0);
}

async function chooseSpace(page: Page, space: string): Promise<void> {
	const button = page.locator(`nav button[data-space="${space}"]`);
	// Choosing the space on screen again folds the panel.
	if ((await button.getAttribute("aria-pressed")) !== "true") await button.click();
	await expect(button).toHaveAttribute("aria-pressed", "true");
}

/** A dialog the entry or tab opened: it shows something, then closes. */
async function closeToolDialog(page: Page, where: string): Promise<void> {
	const dialog = page.getByRole("dialog");
	await expect(dialog, where).toBeVisible();
	await expect(dialog, where).not.toHaveText(/^\s*$/);
	await page.keyboard.press("Escape");
	await expect(dialog, `${where}: closes`).toBeHidden();
}

/** The main area shows the page: not empty. */
async function expectPageShown(main: Locator, where: string): Promise<void> {
	await expect(main, where).toBeVisible();
	await expect(main, where).not.toHaveText(/^\s*$/);
}

/** Selects each tab of the hub on screen; a launcher tab opens its tool. */
async function visitHubTabs(page: Page, entry: string): Promise<number> {
	const tabs = page.locator('main [role="tab"][id^="sidebar-hub-tab-"]');
	const ids = await tabs.evaluateAll((els) => els.map((el) => el.id));
	for (const id of ids) {
		const where = `${entry} > ${id.replace("sidebar-hub-tab-", "")}`;
		const tab = page.locator(`main [role="tab"][id="${id}"]`);
		await tab.click();
		await expect(tab, where).toHaveAttribute("aria-selected", "true");
		await expectPageShown(page.locator("main"), where);
		// A tool that opens as a dialog: its tab says what it does and opens it.
		const label = (await tab.innerText()).trim();
		const launcher = page.locator("main").getByRole("button", {
			name: `Open ${label}`,
			exact: true,
		});
		if ((await launcher.count()) > 0) {
			await launcher.click();
			await closeToolDialog(page, where);
		}
		await expectNoProblem(page, where);
	}
	return ids.length;
}

test.beforeAll(async () => {
	ctx = await launchIsolatedApp();
	watchForProblems(ctx.page);
	await enterLocalMode(ctx);
	await openProject(ctx, makeGitProject(ctx.root, "demo-project"));
	// Every page in the rail, beta ones in the Labo.
	await ctx.page.getByRole("button", { name: "Full", exact: true }).click();
	await expectNoProblem(ctx.page, "start");
});

test.afterAll(async () => {
	await ctx?.close();
});

test("the rail lists the known spaces", async () => {
	const shown = await ctx.page
		.locator("nav button[data-space]")
		.evaluateAll((els) => els.map((el) => el.getAttribute("data-space")));
	expect(shown).toEqual(["__mine__", ...SPACES]);
});

for (const space of SPACES) {
	test(`every page of the ${space} space opens without an error`, async () => {
		const { page } = ctx;
		await chooseSpace(page, space);
		const entries = await page
			.locator("[data-nav-item]")
			.evaluateAll((els) => els.map((el) => el.getAttribute("data-nav-item") as string));
		expect(entries.length, `${space} lists pages`).toBeGreaterThan(0);

		for (const entry of entries) {
			await chooseSpace(page, space);
			const item = page.locator(`[data-nav-item="${entry}"]`);
			await item.click();
			// An entry is a page, or a tool that opens as a dialog over the page.
			const dialog = page.getByRole("dialog");
			const current = page.locator(`[data-nav-item="${entry}"][aria-current="page"]`);
			await expect(current.or(dialog).first(), entry).toBeVisible();
			if (await dialog.isVisible()) {
				await closeToolDialog(page, entry);
			} else {
				await expectPageShown(page.locator("main"), entry);
				await visitHubTabs(page, entry);
			}
			await expectNoProblem(page, entry);
		}
	});
}
