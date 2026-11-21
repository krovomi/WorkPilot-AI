/**
 * Cross-feature journey (#380): an agent's pull request, the pipeline it
 * starts, the red build that comes back, and the incident Self-Healing makes
 * of it, in the real built app, as a user takes them one after the other.
 *
 * 1. Project settings and CI/CD Triggers: the project's Jenkins, started on
 *    each pull request an agent opens.
 * 2. Self-Healing, CI/CD tab: healing on, automatic repair off (the incident
 *    waits for a person).
 * 3. Kanban: a card is built by the agent, reaches Human Review, and the
 *    review dialog opens its pull request with the analysed impact in its body.
 * 4. CI/CD Triggers starts the pipeline on the PR's branch by itself (#378):
 *    the card and the CI/CD page say so.
 * 5. The pipeline goes red and reports it as a project's CI does; the incident
 *    shows in Self-Healing, on the agent's commit, and the person dismisses it.
 *
 * Only the model, the forge and the CI are played: the agent by
 * `e2e/fake-backend/` (the backend's own event, phase and worktree code),
 * the forge by the same fake (`forge.e2e.invalid`, which cannot resolve), the
 * CI by `fake-ci.ts` on 127.0.0.1. CI/CD Triggers' runner and Self-Healing's
 * are the real ones, from `apps/backend/runners/`. No network, no model, no
 * credential: the app starts without the shell's (`app-harness.ts`).
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { type IsolatedApp, launchIsolatedApp, makeGitProject } from "../app-harness";
import { enterLocalMode, fakeBackendDir, openProject } from "../local-project";
import { type FakeCi, startFakeCi } from "./fake-ci";

test.describe.configure({ mode: "serial" });

const TITLE = "Add a CONTRIBUTING.md that explains how to run the tests.";
const JOB = "demo-pipeline";
const FAILING_TEST = "tests/test_docs.py::test_contributing_lists_the_commands";
const TEST_OUTPUT = `============ 1 failed, 4 passed in 0.42s ============\nFAILED ${FAILING_TEST} - AssertionError`;

let ci: FakeCi;
let ctx: IsolatedApp;
let projectDir: string;

function cardIn(status: string): Locator {
	return ctx.page.locator(
		`[data-column-status="${status}"] [role="option"][aria-label="${TITLE}"]`,
	);
}

function card(): Locator {
	return ctx.page.locator(`[data-column-status] [role="option"][aria-label="${TITLE}"]`);
}

function specDir(): string {
	const specs = path.join(projectDir, ".workpilot", "specs");
	const [spec] = readdirSync(specs).filter((name) => !name.startsWith("."));
	return path.join(specs, spec);
}

function readJson(file: string): Record<string, unknown> {
	return JSON.parse(readFileSync(file, "utf-8"));
}

/** Open a page of the left menu, in its space of the rail (`menu-pages.e2e.ts`). */
async function openPage(page: Page, space: string, entry: string): Promise<void> {
	const button = page.locator(`nav button[data-space="${space}"]`);
	if ((await button.getAttribute("aria-pressed")) !== "true") await button.click();
	await expect(button).toHaveAttribute("aria-pressed", "true");
	await page.locator(`[data-nav-item="${entry}"]`).click();
	await expect(page.locator(`[data-nav-item="${entry}"][aria-current="page"]`)).toBeVisible();
}

test.beforeAll(async () => {
	ci = await startFakeCi();
	ctx = await launchIsolatedApp({
		// A provider other than Claude: no sign-in stands between the card
		// and its build (the OAuth gate is Claude's alone).
		settings: { autoBuildPath: fakeBackendDir(), selectedProvider: "openai" },
		gitIdentity: { name: "E2E User", email: "user@e2e.invalid" },
		// A proxy of the machine that runs the specs is never asked for the fake CI.
		env: { NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" },
	});
	projectDir = makeGitProject(ctx.root, "demo-project");
	await enterLocalMode(ctx);
	await openProject(ctx, projectDir);
	// Every page of the rail, the ones still in beta included.
	await ctx.page.getByRole("button", { name: "Full", exact: true }).click();
});

test.afterEach(async () => {
	const info = test.info();
	if (info.status !== info.expectedStatus && ctx) {
		await info.attach("app", {
			body: await ctx.page.screenshot({ timeout: 10_000 }).catch(() => Buffer.from("")),
			contentType: "image/png",
		});
		await info.attach("fake-ci-calls", {
			body: JSON.stringify(ci?.calls() ?? [], null, 2),
			contentType: "application/json",
		});
	}
});

test.afterAll(async () => {
	await ctx?.close();
	await ci?.stop();
});

test("the project's pipeline is set up: its Jenkins, started on each agent PR", async () => {
	const { page } = ctx;
	await page.getByRole("button", { name: "Application Settings" }).click();
	await page.getByRole("button", { name: "CI/CD Pipeline", exact: true }).click();
	await page.locator('[data-guide="cicd.provider"]').click();
	await page.getByRole("option", { name: "Jenkins", exact: true }).click();
	await page.getByPlaceholder("https://jenkins.example.com").fill(ci.url);
	await page.getByPlaceholder("my-multibranch-job").fill(JOB);
	await page.keyboard.press("Escape");
	await expect(page.getByPlaceholder("my-multibranch-job")).toBeHidden();

	await openPage(page, "git-integrations", "cicd-triggers");
	const view = page.getByTestId("cicd-triggers-view");
	// The provider chosen in the project's settings is the one CI/CD Triggers uses.
	await expect(view.locator("#cicd-provider")).toHaveValue("jenkins", { timeout: 15_000 });
	await expect(view.locator("#cicd-trigger_on_pr")).toHaveAttribute("aria-checked", "true");
	await view.locator("#cicd-enabled").click();
	await expect(view.locator("#cicd-enabled")).toHaveAttribute("aria-checked", "true");
	await expect(view.getByText("No pipeline runs yet")).toBeVisible();
	expect(ci.builds()).toEqual([]);
});

test("Self-Healing takes the CI's failures, and leaves the repair to a person", async () => {
	const { page } = ctx;
	await openPage(page, "agents", "self-healing");
	const view = page.getByTestId("self-healing-view");
	await expect(view.getByText("No CI/CD incidents detected")).toBeVisible({ timeout: 30_000 });
	await view.getByLabel("Enable CI/CD healing").check();
	await view.getByLabel("Auto-fix regressions").uncheck();
	const config = path.join(projectDir, ".workpilot", "self-healing", "config.json");
	await expect
		.poll(() => (existsSync(config) ? readJson(config).cicd : null), { timeout: 15_000 })
		.toMatchObject({ enabled: true, autoFixEnabled: false });
});

test("an agent builds the card to Human Review", async () => {
	const { page } = ctx;
	await openPage(page, "workspace", "kanban");
	await page.getByRole("button", { name: /^New Task$/ }).click();
	const dialog = page.getByRole("dialog");
	await dialog.getByPlaceholder(/Describe the feature/).fill(TITLE);
	await dialog.getByRole("button", { name: /^Create Task$/ }).click();
	await expect(dialog).toBeHidden({ timeout: 15_000 });
	await cardIn("backlog").getByRole("button", { name: /^Start$/ }).click();
	await expect(cardIn("in_progress")).toBeVisible({ timeout: 30_000 });
	// The fake agent writes its file once the spec lets it.
	writeFileSync(path.join(specDir(), "e2e-release"), "");
	await expect(cardIn("human_review")).toBeVisible({ timeout: 60_000 });
});

test("the review opens the PR, with the analysed impact in its body", async () => {
	const { page } = ctx;
	await cardIn("human_review").click();
	await expect(page.getByText("The changes are waiting for your review")).toBeVisible();
	await page.getByRole("button", { name: "Create the PR for review" }).click();
	const dialog = page.getByRole("dialog", { name: "Create Pull Request" });
	// The impact analysis (the fake's, in place of the model) fills the dialog.
	await expect(dialog.locator("#impact-rating")).toHaveText("2", { timeout: 30_000 });
	await dialog.getByRole("button", { name: "Create Pull Request", exact: true }).click();
	// The task now carries its pull request, and the review is over.
	const prFile = path.join(specDir(), "e2e-pull-request.json");
	await expect.poll(() => existsSync(prFile), { timeout: 60_000 }).toBe(true);
	const pr = readJson(prFile);
	await expect(page.getByText(String(pr.url), { exact: true })).toBeVisible({
		timeout: 30_000,
	});
	await expect(cardIn("done")).toBeVisible({ timeout: 30_000 });

	expect(pr.branch).toBe(`workpilot/${path.basename(specDir())}`);
	expect(pr.target).toBe("main");
	expect(pr.title).toBe(TITLE);
	expect(pr.body).toContain("Adds `CONTRIBUTING.md`.");
	expect(pr.body).toContain("Contributor guide");
});

test("CI/CD Triggers starts the pipeline on the PR's branch by itself", async () => {
	const { page } = ctx;
	const pr = readJson(path.join(specDir(), "e2e-pull-request.json"));
	await expect.poll(() => ci.builds().length, { timeout: 30_000 }).toBe(1);
	expect(ci.builds()).toEqual([{ job: JOB, branch: pr.branch, prUrl: pr.url }]);
	// No credential was configured, and none went out.
	expect(ci.calls().some((c) => c.authorized)).toBe(false);

	// The task keeps what started, and says it under its PR.
	const metadataFile = path.join(specDir(), "task_metadata.json");
	await expect
		.poll(() => readJson(metadataFile).cicdRun, { timeout: 30_000 })
		.toMatchObject({ provider: "jenkins", event: "pr", status: "triggered" });
	expect(readJson(metadataFile).prUrl).toBe(pr.url);
	await expect(
		page.getByText(/Jenkins pipeline started after the PR was opened/).first(),
	).toBeVisible({ timeout: 30_000 });
	await page.keyboard.press("Escape");

	// The CI/CD page lists the run, started for this task.
	await openPage(page, "git-integrations", "cicd-triggers");
	const view = page.getByTestId("cicd-triggers-view");
	await expect(view.getByText(String(pr.branch), { exact: true })).toBeVisible({
		timeout: 15_000,
	});
	await expect(view.getByText("Triggered", { exact: true })).toBeVisible();
	await expect(
		view.getByText(`started after the PR of ${path.basename(specDir())}`, { exact: false }),
	).toBeVisible();
	await expect(view.getByText(String(pr.url))).toBeVisible();
});

test("the red build becomes a Self-Healing incident on the agent's commit", async () => {
	const { page } = ctx;
	const pr = readJson(path.join(specDir(), "e2e-pull-request.json"));
	const [build] = ci.builds();
	await ci.failBuild(projectDir, build, TEST_OUTPUT);

	await openPage(page, "agents", "self-healing");
	const view = page.getByTestId("self-healing-view");
	const head = String(pr.head);
	const incident = view.getByText(`Test regression: 1 test(s) failing after ${head.slice(0, 7)}`);
	await expect(incident).toBeVisible({ timeout: 30_000 });
	await expect(view.getByText(`on branch ${pr.branch}`, { exact: false })).toBeVisible();
	await expect(view.getByText("Incidents (1)")).toBeVisible();

	// Automatic repair is off: the incident waits, nothing was attempted.
	const stored = JSON.parse(
		readFileSync(path.join(projectDir, ".workpilot", "self-healing", "incidents.json"), "utf-8"),
	) as Array<Record<string, unknown>>;
	expect(stored).toHaveLength(1);
	expect(stored[0]).toMatchObject({ mode: "cicd", status: "pending", regression_commit: head });
	const data = stored[0].source_data as Record<string, unknown>;
	expect(data.failing_tests).toEqual([FAILING_TEST]);
	expect(data.branch).toBe(pr.branch);
});

test("the person dismisses the incident once the build is theirs to fix", async () => {
	const { page } = ctx;
	const view = page.getByTestId("self-healing-view");
	await view.getByRole("button", { name: "Dismiss", exact: true }).click();
	await expect(view.getByRole("button", { name: "Dismiss", exact: true })).toHaveCount(0, {
		timeout: 15_000,
	});
	const incidents = path.join(projectDir, ".workpilot", "self-healing", "incidents.json");
	await expect
		.poll(() => (JSON.parse(readFileSync(incidents, "utf-8")) as Array<{ status: string }>)[0].status)
		.toBe("resolved");
	// And the card it came from is still where the review left it.
	await openPage(page, "workspace", "kanban");
	await expect(card()).toBeVisible();
});
