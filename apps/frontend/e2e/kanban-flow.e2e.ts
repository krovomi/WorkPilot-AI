/**
 * A card's whole life on the board, in the real built app (coverage plan,
 * lot E1): created, started, built by an agent, reviewed, merged, done.
 *
 * Only the model is left out. The app's backend folder is
 * `e2e/fake-backend/`, whose scripts get the same arguments and speak the
 * same stdout protocol as the agents, through the backend's own event,
 * phase and worktree code; the merge itself is the real `run.py --merge`.
 * The build waits for the test (`e2e-release`), so the card is seen running.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, type Locator, test } from "@playwright/test";
import { type IsolatedApp, launchIsolatedApp, makeGitProject } from "./app-harness";
import { enterLocalMode, fakeBackendDir, openProject } from "./local-project";

test.describe.configure({ mode: "serial" });

const TITLE = "Add a CONTRIBUTING.md that explains how to run the tests.";
const WRITTEN = "Run the tests with `pytest`.";

let ctx: IsolatedApp;
let projectDir: string;

/** The card in the board column for `status`. */
function cardIn(status: string): Locator {
	return ctx.page.locator(
		`[data-column-status="${status}"] [role="option"][aria-label="${TITLE}"]`,
	);
}

function specDir(): string {
	const specs = path.join(projectDir, ".workpilot", "specs");
	const [spec] = readdirSync(specs).filter((name) => !name.startsWith("."));
	return path.join(specs, spec);
}

function git(...args: string[]): string {
	return execFileSync("git", args, { cwd: projectDir, encoding: "utf-8" });
}

test.beforeAll(async () => {
	ctx = await launchIsolatedApp({
		// A provider other than Claude: no sign-in stands between the card
		// and its build (the OAuth gate is Claude's alone).
		settings: { autoBuildPath: fakeBackendDir(), selectedProvider: "openai" },
		// The merge commits on main, as the user who set git up.
		gitIdentity: { name: "E2E User", email: "user@e2e.invalid" },
	});
	projectDir = makeGitProject(ctx.root, "demo-project");
	await enterLocalMode(ctx);
	await openProject(ctx, projectDir);
});

test.afterAll(async () => {
	await ctx?.close();
});

test("a card created from the dialog waits in Planning", async () => {
	const { page } = ctx;
	await page.getByRole("button", { name: /^New Task$/ }).click();
	const dialog = page.getByRole("dialog");
	await dialog.getByPlaceholder(/Describe the feature/).fill(TITLE);
	await dialog.getByRole("button", { name: /^Create Task$/ }).click();
	await expect(dialog).toBeHidden({ timeout: 15_000 });
	await expect(cardIn("backlog")).toBeVisible({ timeout: 15_000 });
	const metadata = JSON.parse(
		readFileSync(path.join(specDir(), "task_metadata.json"), "utf-8"),
	);
	expect(metadata.provider).toBe("openai");
});

test("Start runs the agent: the card codes In Progress, in its own worktree", async () => {
	await cardIn("backlog").getByRole("button", { name: /^Start$/ }).click();
	const running = cardIn("in_progress");
	await expect(running).toBeVisible({ timeout: 30_000 });
	await expect(running.getByText("Coding", { exact: true })).toBeVisible({
		timeout: 30_000,
	});
	// The spec phase wrote its files, and the build branched off main.
	const spec = specDir();
	expect(readFileSync(path.join(spec, "spec.md"), "utf-8")).toContain(TITLE);
	const worktree = path.join(
		projectDir,
		".workpilot",
		"worktrees",
		"tasks",
		path.basename(spec),
	);
	expect(existsSync(worktree)).toBe(true);
	expect(git("branch", "--list", "workpilot/*")).toContain(path.basename(spec));
	// Nothing lands on main while the agent works.
	expect(existsSync(path.join(projectDir, "CONTRIBUTING.md"))).toBe(false);
});

test("its QA pass brings it to Human Review with the one file it wrote", async () => {
	const { page } = ctx;
	writeFileSync(path.join(specDir(), "e2e-release"), "");
	const review = cardIn("human_review");
	await expect(review).toBeVisible({ timeout: 30_000 });
	await expect(cardIn("in_progress")).toHaveCount(0);

	await review.click();
	await expect(page.getByText("The changes are waiting for your review")).toBeVisible();
	await expect(page.getByText("1/1 subtasks")).toBeVisible();
	await page.getByRole("button", { name: /^View$/ }).click();
	await expect(page.getByText("1 file changed")).toBeVisible({ timeout: 15_000 });
	await page.getByText("CONTRIBUTING.md", { exact: true }).last().click();
	await expect(page.getByText(WRITTEN)).toBeVisible();
	await page.getByRole("button", { name: /^Close$/ }).last().click();
	await expect(page.getByText("1 file changed")).toBeHidden();
});

test("Merge to main puts the agent's commit on main", async () => {
	const { page } = ctx;
	await page.getByRole("button", { name: "Check for Conflicts" }).click();
	await expect(page.getByText("Ready to merge")).toBeVisible({ timeout: 60_000 });
	await page.getByRole("button", { name: "Merge to main" }).click();
	await expect
		.poll(() => existsSync(path.join(projectDir, "CONTRIBUTING.md")), {
			timeout: 60_000,
		})
		.toBe(true);
	expect(readFileSync(path.join(projectDir, "CONTRIBUTING.md"), "utf-8")).toContain(
		WRITTEN,
	);
	expect(git("log", "--format=%s", "main")).toContain("Add CONTRIBUTING.md");
	expect(git("status", "--porcelain")).toBe("");
	// A merge is reviewed before the card is closed: it waits in Human Review.
	await expect(cardIn("human_review")).toBeVisible({ timeout: 15_000 });
});

test("Done closes the merged card, with no pull request to open", async () => {
	const { page } = ctx;
	await cardIn("human_review").click();
	await page.getByRole("button", { name: "Move task to another column" }).click();
	await page.getByRole("menuitem", { name: /Done/ }).click();
	await expect(cardIn("done")).toBeVisible({ timeout: 30_000 });
	await expect(page.getByText(/Failed to create PR/)).toHaveCount(0);
	await expect(page.getByText("Operation failed")).toHaveCount(0);
});
