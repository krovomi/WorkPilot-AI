/**
 * The phone app against a real WorkPilot server.
 *
 * `tests/server_e2e/app_world.py` starts the server as `deploy/` does (API,
 * streaming server, migrations, a fake agent) and seeds two organizations:
 * Alice (administrator) and Bob in the first, with the project "Team Board";
 * Carol in the second. The app's screens are served from its web bundle
 * (`dist/`, `expo export --platform web`) on localhost:3000, an origin the
 * server's CORS allows, and driven at a phone's size.
 *
 * What it proves: a person signs in through the sign-in screen, finds the
 * project, creates a card that the board lists through `GET /api/board/cards`,
 * starts it (the fake agent writes the spec), and a teammate sees the card;
 * a person of another organization never sees the project; a refused password
 * says so; a theme chosen in Settings is kept on the person's account and
 * applies on another device. The browser cannot set headers on a WebSocket, so on the web the
 * board follows by its periodic read; the header handshake is the native
 * app's (unit-tested in `src/__tests__`).
 *
 * Needs the backend's Python (`apps/backend/.venv`, or `WORKPILOT_E2E_PYTHON`),
 * Linux and port 8765 free. `pnpm run test:e2e:server` after `pnpm run export:web`.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
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
	const answer = JSON.parse(line) as { serverUrl: string; project: string; emails: Record<Who, string> };
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
	await page.getByLabel("Password").fill(password);
	if (who === "alice") await shot(page, "1-sign-in");
	await page.getByRole("button", { name: "Sign in", exact: true }).click();
	if (password === world.passwords[who]) signedIn.set(who, page);
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

test("the project's Insights, roadmap and ideas open from the board", async ({ browser }) => {
	const alice = await signIn(browser, world, "alice");
	await alice.getByRole("button", { name: world.project }).click({ timeout: 30_000 });

	// Insights: a conversation, then the teammate sees it but cannot ask in it.
	await alice.getByRole("link", { name: "Insights" }).click();
	await alice.getByRole("button", { name: "New conversation" }).click();
	await expect(alice.getByText("Ask your first question below.")).toBeVisible({ timeout: 30_000 });
	await expect(alice.getByLabel("Your question")).toBeVisible();
	await shot(alice, "7-insights");
	await alice.goBack();
	await alice.goBack();

	await alice.getByRole("link", { name: "Roadmap" }).click();
	await expect(alice.getByText(/No roadmap yet/)).toBeVisible({ timeout: 30_000 });
	await expect(alice.getByRole("button", { name: "Generate" })).toBeVisible();
	await shot(alice, "8-roadmap");
	await alice.goBack();

	await alice.getByRole("link", { name: "Ideas" }).click();
	await expect(alice.getByText(/No ideas yet/)).toBeVisible({ timeout: 30_000 });

	const bob = await signIn(browser, world, "bob");
	await bob.getByRole("button", { name: world.project }).click({ timeout: 30_000 });
	await bob.getByRole("link", { name: "Insights" }).click();
	await bob.getByRole("button", { name: /New Conversation/ }).first().click({ timeout: 30_000 });
	await expect(bob.getByText("Ask your first question below.")).toBeVisible();
	await expect(bob.getByLabel("Your question")).toHaveCount(0);
});

test("the dashboard, the sessions and the analyses open from the board", async () => {
	// Alice is still on the ideas, where the previous scenario left her.
	const alice = signedInPage("alice");
	await alice.goBack();
	await alice.getByRole("link", { name: "Dashboard" }).click();
	await expect(alice.getByText("Quality")).toBeVisible({ timeout: 30_000 });
	await expect(alice.getByText(/Spending, last \d+ days/)).toBeVisible();
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
	await alice.goBack();
	await alice.goBack();
	await alice.goBack();
	await alice.getByRole("link", { name: "Context" }).click();
	await expect(alice.getByText(/hasn't been indexed yet/)).toBeVisible({ timeout: 30_000 });
	await expect(alice.getByRole("button", { name: "Generate" })).toBeVisible();
	await alice.getByRole("tab", { name: "Memories" }).click();
	await expect(alice.getByText(/No memories yet/)).toBeVisible({ timeout: 30_000 });
	await shot(alice, "10-context");

	// Bob saves a GitHub token: the server says it is set, and never shows it back.
	// Bob is on the Insights conversation where an earlier scenario left him.
	const bob = signedInPage("bob");
	await bob.goBack();
	await bob.goBack();
	await bob.goBack();
	await bob.getByText("Settings", { exact: true }).click();
	await bob.getByRole("button", { name: "Manage my tokens" }).click();
	await bob.getByRole("button", { name: "Add" }).first().click({ timeout: 30_000 });
	const token = `ghp_${randomBytes(12).toString("hex")}`;
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
	await alice.goBack();
	await alice.goBack();
	await alice.getByText("Settings", { exact: true }).click();
	await alice.getByRole("button", { name: "Open the administration" }).click();

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
