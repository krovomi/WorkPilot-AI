/**
 * The phone app against a real WorkPilot server.
 *
 * `tests/server_e2e/app_world.py` starts the server as `deploy/` does (API,
 * streaming server, migrations, a fake agent) and seeds two organizations:
 * Alice (administrator) and Bob in the first, with the project "Team Board",
 * "Team Site" on a fake GitHub and "Team Docs" on a fake GitLab
 * (`fake_forge.py`); Carol in the second. The app's screens are served from its web bundle
 * (`dist/`, `expo export --platform web`) on localhost:3000, an origin the
 * server's CORS allows, and driven at a phone's size.
 *
 * What it proves: a person signs in through the sign-in screen, finds the
 * project, creates a card that the board lists through `GET /api/board/cards`,
 * starts it (the fake agent writes the spec), and a teammate sees the card;
 * a person of another organization never sees the project; a refused password
 * says so; Settings say how the person's session was opened; a theme chosen
 * in Settings is kept on the person's account and applies on another device; the team's pull requests, issues and merge
 * requests read and commented through the server with each person's own
 * token, which the fake forge saw and the page never shows; a card's spec
 * approved from the phone, built (the fake agent checks the approval as a
 * build does and commits in the card's workspace), reviewed with its changes
 * and sent back to a build that runs; a person shows their name on the
 * team's leaderboard, a choice the server keeps, and finds their replay links. The browser cannot set headers on a WebSocket, so on the web the
 * board follows by its periodic read; the header handshake is the native
 * app's (unit-tested in `src/__tests__`).
 *
 * Needs the backend's Python (`apps/backend/.venv`, or `WORKPILOT_E2E_PYTHON`),
 * Linux and port 8765 free. `pnpm run test:e2e:server` after `pnpm run export:web`.
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { createInterface } from "node:readline";
import { type Browser, expect, type Page, test } from "@playwright/test";

const MOBILE = path.resolve(__dirname, "..");
const REPO = path.resolve(MOBILE, "..", "..");
const DIST = path.join(MOBILE, "dist");
const APP_PORT = 3000;
const SHOTS = process.env.WORKPILOT_E2E_SCREENSHOTS;

type Who = "alice" | "bob" | "carol";

interface World {
	serverUrl: string;
	project: string;
	/** The team's projects on the fake GitHub and GitLab (`fake_forge.py`). */
	githubProject: string;
	gitlabProject: string;
	/** Where the fake forges say what they were asked (`GET /calls`). */
	forgeUrl: string;
	emails: Record<Who, string>;
	passwords: Record<Who, string>;
	stop: () => Promise<void>;
}

async function startServer(): Promise<World> {
	const python = process.env.WORKPILOT_E2E_PYTHON || path.join(REPO, "apps", "backend", ".venv", "bin", "python");
	if (!existsSync(python)) throw new Error(`the backend's Python is missing: ${python}`);
	const child = spawn(python, ["-m", "tests.server_e2e.app_world"], {
		cwd: REPO,
		stdio: ["pipe", "pipe", "inherit"],
	});
	const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
	const stop = async () => {
		child.stdin.end();
		await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 30_000))]);
		if (child.exitCode === null) child.kill();
	};
	// Drawn here; they reach the server only through the script's standard input.
	const passwords = {
		alice: randomBytes(18).toString("base64url"),
		bob: randomBytes(18).toString("base64url"),
		carol: randomBytes(18).toString("base64url"),
	} satisfies Record<Who, string>;
	child.stdin.write(`${JSON.stringify(passwords)}\n`);
	const line = await new Promise<string>((resolve, reject) => {
		createInterface({ input: child.stdout }).once("line", resolve);
		void exited.then((code) => reject(new Error(`server exited (${code})`)));
	});
	const answer = JSON.parse(line) as Omit<World, "passwords" | "stop">;
	return { ...answer, passwords, stop };
}

const TYPES: Record<string, string> = {
	".html": "text/html",
	".js": "text/javascript",
	".css": "text/css",
	".json": "application/json",
	".png": "image/png",
	".ico": "image/x-icon",
	".ttf": "font/ttf",
};

/** The web bundle, with every unknown path answered by index.html (the router's). */
function serveApp(): Promise<http.Server> {
	if (!existsSync(path.join(DIST, "index.html"))) {
		throw new Error("dist/ is missing: run `pnpm run export:web` first");
	}
	const server = http.createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		const wanted = path.normalize(path.join(DIST, decodeURIComponent(url.pathname)));
		const inside = wanted.startsWith(DIST + path.sep);
		const file = inside && existsSync(wanted) && statSync(wanted).isFile() ? wanted : path.join(DIST, "index.html");
		res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream" });
		res.end(readFileSync(file));
	});
	return new Promise((resolve) => server.listen(APP_PORT, "127.0.0.1", () => resolve(server)));
}

/** Two frames: the app's `useColorScheme()` has re-rendered after a scheme change. */
async function settled(page: Page): Promise<void> {
	await page.evaluate(
		() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
	);
}

/**
 * The screen as it is, in the device's light then dark scheme (`name-light.png`,
 * `name-dark.png`), on the same page: no new sign-in (the server allows ten a
 * minute). The page goes back to light, the scheme the scenarios run in.
 */
async function shot(page: Page, name: string): Promise<void> {
	if (!SHOTS) return;
	mkdirSync(SHOTS, { recursive: true });
	for (const colorScheme of ["light", "dark"] as const) {
		await page.emulateMedia({ colorScheme });
		await settled(page);
		await page.screenshot({ path: path.join(SHOTS, `${name}-${colorScheme}.png`) });
	}
	await page.emulateMedia({ colorScheme: "light" });
	await settled(page);
}

async function signIn(browser: Browser, world: World, who: Who, password = world.passwords[who]): Promise<Page> {
	const context = await browser.newContext({ colorScheme: "light" });
	const page = await context.newPage();
	await page.goto(`http://localhost:${APP_PORT}/`);
	await page.getByLabel("Server address").fill(world.serverUrl);
	await page.getByLabel("Email").fill(world.emails[who]);
	await page.getByRole("textbox", { name: "Password" }).fill(password);
	if (who === "alice") await shot(page, "1-sign-in");
	await page.getByRole("button", { name: "Sign in", exact: true }).click();
	if (password !== world.passwords[who]) return page;
	// What the server measures is shown once in each organization, right
	// after the sign-in; a device signed in again later is not shown it.
	const notice = page.getByRole("button", { name: "I understand", exact: true });
	const shown = await notice.waitFor({ timeout: 15_000 }).then(
		() => true,
		() => false,
	);
	if (shown) {
		await notice.click();
		await expect(notice).toBeHidden();
	}
	signedIn.set(who, page);
	return page;
}

/**
 * The page of someone already signed in, as an earlier scenario left it: the
 * server allows ten sign-ins a minute from one address, and the web build keeps
 * its tokens in memory, so a new page would have to sign in again.
 */
function signedInPage(who: Who): Page {
	const page = signedIn.get(who);
	if (!page) throw new Error(`${who} never signed in`);
	return page;
}

const signedIn = new Map<Who, Page>();

/** Bob's GitHub token, saved on the server by a scenario and used by a later one. */
const bobGitHub = `ghp_${randomBytes(12).toString("hex")}`;

interface ForgeCall {
	host: string;
	method: string;
	path: string;
	token: string;
	body: unknown;
}

/** What the fake forges were asked so far, oldest first. */
async function forgeCalls(): Promise<ForgeCall[]> {
	const answer = await fetch(`${world.forgeUrl}/calls`);
	return (await answer.json()) as ForgeCall[];
}

/** What a fake forge keeps of a token (`fake_forge.token_tag`). */
function tokenTag(token: string): string {
	return createHash("sha256").update(token, "utf8").digest("hex").slice(0, 16);
}

/** Back to the list of projects, from wherever a scenario left the page. */
async function home(page: Page, project: string): Promise<void> {
	const button = page.getByRole("button", { name: project, exact: true });
	for (let i = 0; i < 10 && !(await button.isVisible()); i++) {
		await page.goBack();
		await page.waitForTimeout(300);
	}
	await expect(button).toBeVisible({ timeout: 30_000 });
}

/** Opens a project from the list of projects, on its board. */
async function openProject(page: Page, project: string): Promise<void> {
	await home(page, project);
	await page.getByRole("button", { name: project, exact: true }).click();
	await expect(page.getByRole("tab", { name: "More", exact: true })).toBeVisible({ timeout: 30_000 });
}

/** A tab of the project's tab bar (Board, Insights, the forge, Dashboard, More). */
async function projectTab(page: Page, name: string): Promise<void> {
	await page.getByRole("tab", { name, exact: true }).click();
}

/** A page of the project's More tab (Roadmap, Ideas, Context, Sessions…). */
async function morePage(page: Page, name: string): Promise<void> {
	await projectTab(page, "More");
	await page.getByRole("button", { name, exact: true }).click();
}

/** The settings, from the list of projects. */
async function openSettings(page: Page, project: string): Promise<void> {
	await home(page, project);
	await page.getByRole("button", { name: "Settings", exact: true }).click();
}

let world: World;
let app: http.Server;

test.beforeAll(async () => {
	app = await serveApp();
	world = await startServer();
});

test.afterAll(async () => {
	await world?.stop();
	await new Promise((resolve) => app?.close(resolve));
});

test("a refused password says so and keeps the person signed out", async ({ browser }) => {
	const page = await signIn(browser, world, "alice", "not-the-password-at-all");
	await expect(page.getByText("Sign-in failed: Wrong email or password.")).toBeVisible();
	await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
});

test("a card created from the phone is on the team's board, and starts", async ({ browser }) => {
	const alice = await signIn(browser, world, "alice");
	const project = alice.getByRole("button", { name: world.project });
	await expect(project).toBeVisible({ timeout: 30_000 });
	await shot(alice, "2-projects");
	await project.click();

	await expect(alice.getByRole("tab", { name: /Planning/ })).toBeVisible();
	await alice.getByRole("button", { name: "New card" }).click();
	await alice.getByLabel("Title").fill("Add a dark mode toggle");
	await alice.getByLabel("Description").fill("A switch in the settings that follows the system by default.");
	await alice.getByRole("switch").click(); // no review before coding
	await shot(alice, "3-new-card");
	await alice.getByRole("button", { name: "Create" }).click();

	// The card's screen, read back from the server.
	await expect(alice.getByRole("heading", { name: "Add a dark mode toggle" })).toBeVisible({ timeout: 30_000 });
	await expect(alice.getByText("A switch in the settings")).toBeVisible();
	await shot(alice, "4-card");

	// Before work starts, the card can still be edited (PATCH, then read back).
	await alice.getByRole("button", { name: "Edit" }).click();
	await alice.getByLabel("Description").fill("A switch in the settings, following the system by default.");
	await shot(alice, "4b-edit-card");
	await alice.getByRole("button", { name: "Save" }).click();
	await expect(alice.getByText("A switch in the settings, following the system by default.")).toBeVisible({
		timeout: 30_000,
	});

	// Bob, of the same organization, finds it on the board.
	const bob = await signIn(browser, world, "bob");
	await bob.getByRole("button", { name: world.project }).click({ timeout: 30_000 });
	await expect(bob.getByRole("button", { name: "Add a dark mode toggle" })).toBeVisible({ timeout: 30_000 });
	await shot(bob, "5-board-teammate");

	// Alice starts it: the server runs the spec phase (the fake agent).
	await alice.getByRole("button", { name: "Start" }).click();
	// The run is listed under Runs, queued, running or already done.
	await expect(alice.getByText(/^(Queued|Running|Succeeded)$/).first()).toBeVisible({ timeout: 60_000 });
	await expect(alice.getByText("No run yet.")).toHaveCount(0);
	await shot(alice, "6-card-started");
});

test("a person of another organization never sees the project", async ({ browser }) => {
	const carol = await signIn(browser, world, "carol");
	await expect(carol.getByText(/No project yet/)).toBeVisible({ timeout: 30_000 });
	await expect(carol.getByRole("button", { name: world.project })).toHaveCount(0);
});

test("the board finds a card by its words, and keeps the person's own", async () => {
	const alice = signedInPage("alice");
	await openProject(alice, world.project);
	const search = alice.getByLabel("Search the board");
	await search.fill("DARK mode");
	await expect(alice.getByRole("button", { name: "Add a dark mode toggle" })).toBeVisible({ timeout: 30_000 });
	await search.fill("no card is called like this");
	await expect(alice.getByText("No card matches.")).toBeVisible();
	await alice.getByRole("button", { name: "Clear the filters" }).click();
	// The card Alice started is hers: it stays with "Mine" on.
	await alice.getByRole("button", { name: "Filters" }).click();
	await alice.getByRole("checkbox", { name: "Mine" }).click();
	await expect(alice.getByRole("button", { name: "Filters, 1 on" })).toBeVisible();
	await expect(alice.getByText("No card matches.")).toHaveCount(0);
	await shot(alice, "6b-board-filters");
	await alice.getByRole("checkbox", { name: "Clear the filters" }).click();
});

test("the project's Insights, roadmap and ideas open from the board", async ({ browser }) => {
	const alice = await signIn(browser, world, "alice");
	await alice.getByRole("button", { name: world.project }).click({ timeout: 30_000 });

	// Insights: a conversation, then the teammate sees it but cannot ask in it.
	await projectTab(alice, "Insights");
	await alice.getByRole("button", { name: "New conversation" }).click();
	await expect(alice.getByText("Ask your first question below.")).toBeVisible({ timeout: 30_000 });
	await expect(alice.getByLabel("Your question")).toBeVisible();
	await shot(alice, "7-insights");

	await openProject(alice, world.project);
	await morePage(alice, "Roadmap");
	await expect(alice.getByText(/No roadmap yet/)).toBeVisible({ timeout: 30_000 });
	await expect(alice.getByRole("button", { name: "Generate" })).toBeVisible();
	await shot(alice, "8-roadmap");

	await openProject(alice, world.project);
	await morePage(alice, "Ideas");
	await expect(alice.getByText(/No ideas yet/)).toBeVisible({ timeout: 30_000 });

	const bob = await signIn(browser, world, "bob");
	await bob.getByRole("button", { name: world.project }).click({ timeout: 30_000 });
	await projectTab(bob, "Insights");
	await bob.getByRole("button", { name: /New Conversation/ }).first().click({ timeout: 30_000 });
	await expect(bob.getByText("Ask your first question below.")).toBeVisible();
	await expect(bob.getByLabel("Your question")).toHaveCount(0);
});

test("the dashboard, the sessions and the analyses open from the board", async () => {
	// Alice is still on the ideas, where the previous scenario left her.
	const alice = signedInPage("alice");
	await openProject(alice, world.project);
	await projectTab(alice, "Dashboard");
	await expect(alice.getByText("Quality")).toBeVisible({ timeout: 30_000 });
	await expect(alice.getByText(/^Spending, last \d+ days$/)).toBeVisible();
	await shot(alice, "9-dashboard");

	// The card started in an earlier scenario is in the history.
	await alice.getByRole("button", { name: "Sessions" }).click();
	await expect(alice.getByText(/ · Spec$/).first()).toBeVisible({ timeout: 30_000 });
	await alice.goBack();

	await alice.getByRole("button", { name: "Analyses" }).click();
	await alice.getByRole("button", { name: /Technical debt/ }).click();
	await expect(alice.getByText("Never run on this project.")).toBeVisible({ timeout: 30_000 });
	await expect(alice.getByRole("button", { name: "Generate" })).toBeVisible();
});

test("the project's context, and a personal token kept on the server", async () => {
	// Alice is still on the analyses, where the previous scenario left her.
	const alice = signedInPage("alice");
	await openProject(alice, world.project);
	await morePage(alice, "Context");
	await expect(alice.getByText(/hasn't been indexed yet/)).toBeVisible({ timeout: 30_000 });
	await expect(alice.getByRole("button", { name: "Generate" })).toBeVisible();
	await alice.getByRole("tab", { name: "Memories" }).click();
	await expect(alice.getByText(/No memories yet/)).toBeVisible({ timeout: 30_000 });
	await shot(alice, "10-context");

	// Bob saves a GitHub token: the server says it is set, and never shows it back.
	// Bob is on the Insights conversation where an earlier scenario left him.
	const bob = signedInPage("bob");
	await openSettings(bob, world.project);
	// His session, as the server tells it: opened with his password.
	await expect(bob.getByText("Password", { exact: true })).toBeVisible({ timeout: 30_000 });
	await bob.getByRole("button", { name: "My tokens on the server" }).click();
	await bob.getByRole("button", { name: "Add" }).first().click({ timeout: 30_000 });
	const token = bobGitHub;
	await bob.getByLabel("GitHub token").fill(token);
	await bob.getByRole("button", { name: "Save" }).click();
	await expect(bob.getByText("Saved")).toBeVisible({ timeout: 30_000 });
	await expect(bob.getByRole("button", { name: "Replace" })).toBeVisible();
	await shot(bob, "11-tokens");
	expect(await bob.content()).not.toContain(token);
});

test("an organization admin runs members, invitations and groups from the phone", async () => {
	// Alice, an admin of the team's organization, is still on the context.
	const alice = signedInPage("alice");
	await openSettings(alice, world.project);
	await alice.getByRole("button", { name: "Administration", exact: true }).click();

	await alice.getByRole("link", { name: /^Members/ }).click();
	await expect(alice.getByText(world.emails.bob, { exact: false })).toBeVisible({ timeout: 30_000 });
	await shot(alice, "12-members");
	await alice.goBack();

	// No mail server: the link to share comes back once, and the invitation is
	// pending. An organization admin is not offered a server administrator.
	await alice.getByRole("link", { name: /^Invitations/ }).click();
	await expect(alice.getByRole("radio", { name: "Member" })).toBeVisible({ timeout: 30_000 });
	await expect(alice.getByRole("radio", { name: "Server administrator" })).toHaveCount(0);
	const invited = `dave-${randomBytes(4).toString("hex")}@example.com`;
	await alice.getByLabel("Email").fill(invited);
	await alice.getByRole("button", { name: "Invite", exact: true }).click();
	await expect(alice.getByText(/share this link with them/)).toBeVisible({ timeout: 30_000 });
	await expect(alice.getByText("1 pending invitation")).toBeVisible();
	await shot(alice, "13-invitations");
	await alice.goBack();

	await alice.getByRole("link", { name: /^Groups/ }).click();
	await alice.getByLabel("Name").fill("Mobile team");
	await alice.getByRole("button", { name: "Create the group" }).click();
	await alice.getByRole("link", { name: /Mobile team/ }).click({ timeout: 30_000 });
	await alice.getByRole("button", { name: "Add a member" }).click();
	await alice.getByRole("radio", { name: "bob", exact: true }).click();
	await expect(alice.getByText("1 member")).toBeVisible({ timeout: 30_000 });
	await shot(alice, "14-group");
});

/** Whether an element of the page is painted in this background colour. */
async function paints(page: Page, rgb: string): Promise<boolean> {
	return await page.evaluate(
		(wanted) =>
			Array.from(document.querySelectorAll("div")).some((el) => getComputedStyle(el).backgroundColor === wanted),
		rgb,
	);
}

test("the theme chosen on the phone follows the person to another device", async ({ browser }) => {
	// Alice is still on the group, where the previous scenario left her.
	const alice = signedInPage("alice");
	await alice.goBack();
	await alice.goBack();
	await alice.goBack();
	await alice.getByRole("radio", { name: "Ocean", exact: true }).click();
	await alice.getByRole("radio", { name: "Dark", exact: true }).click();
	// Ocean, dark (#082F49), although this browser asks for light.
	await expect.poll(() => paints(alice, "rgb(8, 47, 73)"), { timeout: 10_000 }).toBe(true);
	await shot(alice, "15-theme");

	// A second device, in light, with no copy of its own: the account's theme wins.
	// The run has used most of the server's ten sign-ins a minute by now: when
	// it refuses, the next minute's window lets this one through.
	const elsewhere = await signIn(browser, world, "alice");
	const projects = elsewhere.getByRole("button", { name: world.project });
	const refused = elsewhere.getByText(/Too many attempts/);
	await expect(projects.or(refused)).toBeVisible({ timeout: 30_000 });
	if (await refused.isVisible()) {
		await elsewhere.waitForTimeout(61_000);
		await elsewhere.getByRole("button", { name: "Sign in", exact: true }).click();
	}
	await expect(projects).toBeVisible({ timeout: 30_000 });
	await expect.poll(() => paints(elsewhere, "rgb(8, 47, 73)"), { timeout: 30_000 }).toBe(true);
});

test("Bob reads the team's GitHub from the phone, and comments with his own token", async () => {
	// Bob saved his GitHub token on the server in an earlier scenario.
	const bob = signedInPage("bob");
	await openProject(bob, world.githubProject);
	await projectTab(bob, "GitHub");

	// Pull requests first, with the files of the one opened.
	await bob.getByText("#12 Add a welcome banner").click({ timeout: 30_000 });
	await expect(bob.getByText("app.py").first()).toBeVisible({ timeout: 30_000 });
	await shot(bob, "16-pull");
	await bob.goBack();

	await bob.getByRole("tab", { name: "Issues" }).click();
	await bob.getByText("#7 The onboarding guide is missing").click({ timeout: 30_000 });
	await expect(bob.getByText("New teammates have nothing to read on their first day.")).toBeVisible({
		timeout: 30_000,
	});
	await expect(bob.getByText("A short page in docs/ would already help.")).toBeVisible();
	const comment = `On it from the phone ${randomBytes(3).toString("hex")}`;
	await bob.getByLabel("Your comment").fill(comment);
	await bob.getByRole("button", { name: "Comment", exact: true }).click();
	await expect
		.poll(async () => (await forgeCalls()).some((c) => c.method === "POST" && JSON.stringify(c.body).includes(comment)))
		.toBe(true);
	await shot(bob, "17-issue");

	const calls = (await forgeCalls()).filter((c) => c.host === "api.github.com");
	const posted = calls.find((c) => c.method === "POST" && JSON.stringify(c.body).includes(comment));
	expect(posted?.path).toBe("/repos/e2e-team/team-site/issues/7/comments");
	// Every call carried Bob's own token, and the page never shows it.
	expect(new Set(calls.map((c) => c.token))).toEqual(new Set([tokenTag(bobGitHub)]));
	expect(await bob.content()).not.toContain(bobGitHub);
});

test("Alice adds her GitLab token and reads the team's merge requests", async () => {
	const alice = signedInPage("alice");
	await openSettings(alice, world.gitlabProject);
	await alice.getByRole("button", { name: "My tokens on the server" }).click();
	const token = `glpat-${randomBytes(12).toString("hex")}`;
	const field = alice.getByLabel("GitLab token");
	if (!(await field.isVisible())) {
		await alice.getByRole("button", { name: "Add" }).nth(1).click({ timeout: 30_000 });
	}
	await field.fill(token);
	await alice.getByRole("button", { name: "Save" }).click();
	await expect(alice.getByText("Saved")).toBeVisible({ timeout: 30_000 });

	await openProject(alice, world.gitlabProject);
	await projectTab(alice, "GitLab");
	await expect(alice.getByRole("tab", { name: "Merge requests" })).toBeVisible({ timeout: 30_000 });
	await expect(alice.getByText("#5 Document the deploy steps")).toBeVisible({ timeout: 30_000 });
	await alice.getByRole("tab", { name: "Issues" }).click();
	await expect(alice.getByText("#3 Write the release checklist")).toBeVisible({ timeout: 30_000 });
	await shot(alice, "18-gitlab");

	const calls = (await forgeCalls()).filter((c) => c.host === "gitlab.e2e.test");
	expect(calls.map((c) => c.path)).toContain("/api/v4/projects/e2e-team%2Fteam-docs/merge_requests");
	expect(new Set(calls.map((c) => c.token))).toEqual(new Set([tokenTag(token)]));
});

test("Alice approves a card's spec from the phone, builds it, and sends it back", async () => {
	// Two runs of the fake agent, each released at once, and a second build.
	test.setTimeout(300_000);
	const alice = signedInPage("alice");
	await home(alice, world.project);
	await alice.getByRole("button", { name: world.project }).click();
	await alice.getByRole("button", { name: "New card" }).click();
	await alice.getByLabel("Title").fill("Greet the team by name");
	await alice.getByLabel("Description").fill("hello() takes the team's name.");
	// The review before coding stays on: the spec waits for an approval.
	await alice.getByRole("button", { name: "Create" }).click();
	await expect(alice.getByRole("heading", { name: "Greet the team by name" })).toBeVisible({ timeout: 30_000 });

	// The spec phase runs on the server; the fake agent writes the spec.
	await alice.getByRole("button", { name: "Start" }).click();
	const approve = alice.getByRole("button", { name: "Approve the spec" });
	await expect(approve).toBeVisible({ timeout: 90_000 });
	await expect(alice.getByText("Spec written by the fake agent")).toBeVisible();
	await approve.click();
	// The approval section read from the server: the count, then who approved.
	await expect(alice.getByText("1 of 1 approvals")).toBeVisible({ timeout: 30_000 });
	await expect(alice.getByText(/^alice, /)).toBeVisible();
	await shot(alice, "19-approved");

	// The build checks that approval, then the card waits for the team's
	// review, its changes read from its workspace on the server. The build
	// moved the plan on: the card still counts as approved.
	await alice.getByRole("button", { name: "Start" }).click();
	const requestChanges = alice.getByRole("button", { name: "Request changes" });
	await expect(requestChanges).toBeVisible({ timeout: 90_000 });
	await expect(alice.getByRole("button", { name: "Merge" })).toBeVisible();
	await expect(alice.getByText("BUILD_NOTES.md").first()).toBeVisible({ timeout: 30_000 });
	await shot(alice, "20-review");

	// Sent back with what to change: the build it starts is not stopped for
	// a new approval, and the card comes back to review.
	await requestChanges.click();
	await alice.getByPlaceholder("What should the agents change?").fill("Say good morning before noon.");
	await alice.getByRole("button", { name: "Send", exact: true, disabled: false }).click();
	await expect(alice.getByText(/^(Queued|Running)$/).first()).toBeVisible({ timeout: 60_000 });
	await expect(requestChanges).toBeVisible({ timeout: 90_000 });
	await expect(alice.getByText(/Failed/)).toHaveCount(0);
	await shot(alice, "21-sent-back");
});

test("Alice finds what waits for her across projects, and has Telegram tell her", async () => {
	const alice = signedInPage("alice");
	// The card sent back in the previous scenario is in review again: hers to look at.
	await home(alice, world.project);
	await alice.getByRole("button", { name: "What waits for you" }).click();
	await expect(alice.getByRole("button", { name: `Greet the team by name, ${world.project}` })).toBeVisible({
		timeout: 30_000,
	});
	await shot(alice, "22-inbox");

	await openSettings(alice, world.project);
	await alice.getByRole("button", { name: "Notify me elsewhere" }).click();
	// The test server keeps secrets but does not send: it says so, and offers no test.
	await expect(alice.getByText(/does not send them yet/)).toBeVisible({ timeout: 30_000 });
	await alice.getByRole("button", { name: "Set up" }).nth(1).click();
	await alice.getByLabel("Bot token").fill(`123456:${randomBytes(16).toString("hex")}`);
	await alice.getByLabel("Your user id").fill("42");
	await alice.getByRole("button", { name: "Save", exact: true }).click();
	// Read back from the server: set, never shown again.
	await expect(alice.getByRole("switch", { name: "Send on Telegram" })).toBeVisible({ timeout: 30_000 });
	await expect(alice.getByText("On", { exact: true })).toBeVisible();
	await expect(alice.getByRole("button", { name: "Send a test" })).toHaveCount(0);
	const failed = alice.getByRole("switch", { name: "A task I started stopped on an error" });
	await expect(failed).toBeChecked();
	await failed.click();
	await shot(alice, "23-needs-you");
	// Kept by the server: read again on the way back in.
	await alice.goBack();
	await alice.getByRole("button", { name: "Notify me elsewhere" }).click();
	await expect(alice.getByRole("switch", { name: "A task I started stopped on an error" })).not.toBeChecked({
		timeout: 30_000,
	});
});

test("Alice shows her name on the team's leaderboard, and finds her replay links", async () => {
	const alice = signedInPage("alice");
	await openProject(alice, world.project);
	// The browser cannot put the token in the stream's handshake: the chat page opens, the native app talks.
	await morePage(alice, "Team chat");
	await expect(alice.getByText("Connecting…")).toBeVisible({ timeout: 30_000 });
	await alice.goBack();

	await morePage(alice, "Leaderboard");
	await expect(alice.getByText("Your score")).toBeVisible({ timeout: 30_000 });
	const showMe = alice.getByRole("switch", { name: "Show my name on the leaderboard" });
	// Nobody is named until they say so.
	await expect(showMe).not.toBeChecked();
	await showMe.click();
	await expect(showMe).toBeChecked({ timeout: 30_000 });
	await alice.getByRole("radio", { name: "Whole organization" }).click();
	await expect(alice.getByRole("switch", { name: "Show my name on the leaderboard" })).toBeChecked({ timeout: 30_000 });
	await shot(alice, "24-leaderboard");
	// Kept by the server: read again on the way back in.
	await alice.goBack();
	await morePage(alice, "Leaderboard");
	await expect(alice.getByRole("switch", { name: "Show my name on the leaderboard" })).toBeChecked({
		timeout: 30_000,
	});

	await openSettings(alice, world.project);
	await alice.getByRole("button", { name: "My replay links" }).click();
	await expect(alice.getByText("You have shared no replay.")).toBeVisible({ timeout: 30_000 });
});
