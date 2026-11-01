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
 * says so. The browser cannot set headers on a WebSocket, so on the web the
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

async function shot(page: Page, name: string): Promise<void> {
	if (!SHOTS) return;
	mkdirSync(SHOTS, { recursive: true });
	await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

async function signIn(browser: Browser, world: World, who: Who, password = world.passwords[who]): Promise<Page> {
	const context = await browser.newContext();
	const page = await context.newPage();
	await page.goto(`http://localhost:${APP_PORT}/`);
	await page.getByLabel("Server address").fill(world.serverUrl);
	await page.getByLabel("Email").fill(world.emails[who]);
	await page.getByLabel("Password").fill(password);
	if (who === "alice") await shot(page, "1-sign-in");
	await page.getByRole("button", { name: "Sign in" }).click();
	return page;
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
	await expect(page.getByText(/Sign-in failed/)).toBeVisible();
	await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
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
