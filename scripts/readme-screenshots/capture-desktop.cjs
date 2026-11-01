#!/usr/bin/env node
/**
 * Captures the desktop screenshots of the README into .github/assets/screenshots/.
 *
 * It starts the renderer's browser preview (Vite, `browser-mock.ts` in place of
 * Electron), fills it with the invented data of demo-data.js and drives it with
 * Playwright. No backend, no account, no network.
 *
 *   node scripts/readme-screenshots/capture-desktop.cjs            # every shot
 *   node scripts/readme-screenshots/capture-desktop.cjs kanban     # one shot
 *
 * Needs `pnpm install` and a Chromium for Playwright.
 */
const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");

const REPO = path.resolve(__dirname, "..", "..");
const FRONTEND = path.join(REPO, "apps", "frontend");
const { chromium } = require(
	require.resolve("@playwright/test", { paths: [FRONTEND] }),
);

const OUT =
	process.env.OUT || path.join(REPO, ".github", "assets", "screenshots");
const PORT = Number(process.env.PREVIEW_PORT || 5179);
const URL = `http://localhost:${PORT}/`;
const VIEWPORT = { width: 2010, height: 1080 }; // every Kanban column, sidebar open

function startPreview() {
	const vite = spawn(
		path.join(FRONTEND, "node_modules", ".bin", "vite"),
		[
			"src/renderer",
			"--config",
			"vite.config.js",
			"--port",
			String(PORT),
			"--strictPort",
		],
		{ cwd: FRONTEND, stdio: "ignore" },
	);
	return vite;
}

function waitForPreview(deadline = Date.now() + 60_000) {
	return new Promise((resolve, reject) => {
		const attempt = () => {
			http
				.get(URL, (res) => {
					res.resume();
					resolve();
				})
				.on("error", () => {
					if (Date.now() > deadline)
						reject(new Error(`preview not reachable on ${URL}`));
					else setTimeout(attempt, 500);
				});
		};
		attempt();
	});
}

async function openApp(browser) {
	const page = await browser.newPage({
		viewport: VIEWPORT,
		colorScheme: "dark",
	});
	await page.addInitScript({ path: path.join(__dirname, "preview-init.js") });
	await page.addInitScript({ path: path.join(__dirname, "demo-data.js") });
	page.on("pageerror", (e) =>
		console.warn("pageerror:", e.message.slice(0, 160)),
	);
	await page.goto(URL, { waitUntil: "networkidle" });
	await page.waitForTimeout(1500);
	const skip = page.getByText("Skip Setup");
	if (await skip.count()) {
		await skip.first().click();
		await page.waitForTimeout(800);
	}
	// The CLI install panel is noise in a screenshot.
	const cli = page.getByText("CLI Tools", { exact: true });
	if (await cli.count()) {
		await cli.first().click();
		await page.waitForTimeout(300);
	}
	return page;
}

/** Opens a sidebar view, its group first when it is folded. */
async function openView(page, label, group) {
	if (group) {
		await page.getByText(group, { exact: true }).first().click();
		await page.waitForTimeout(300);
	}
	const candidates = page.getByText(label, { exact: false });
	for (let i = 0; i < (await candidates.count()); i++) {
		const box = await candidates.nth(i).boundingBox();
		if (box && box.x < 256) {
			await candidates.nth(i).click();
			await page.waitForTimeout(500);
			// Leaving the board while a task runs asks first.
			const dontAsk = page.getByText("Don't ask again during this session");
			if (await dontAsk.count()) {
				await dontAsk.click();
				await page.getByText("Continue in the background").click();
			}
			await page.waitForTimeout(2500);
			return;
		}
	}
	throw new Error(`sidebar item not found: ${label}`);
}

const SHOTS = {
	kanban: (page) => page.waitForTimeout(2500),
	"task-detail": async (page) => {
		await page.getByText("One-page checkout", { exact: true }).first().click();
		await page.waitForTimeout(1500);
		await page
			.getByText(/^Subtasks \(/)
			.first()
			.click();
		await page.waitForTimeout(1200);
	},
	dashboard: (page) => openView(page, "Dashboard"),
	insights: (page) => openView(page, "Insights", "Explore"),
	ideation: (page) => openView(page, "Ideation", "Explore"),
	roadmap: (page) => openView(page, "Roadmap", "Planning"),
};

(async () => {
	const only = process.argv.slice(2);
	const vite = startPreview();
	try {
		await waitForPreview();
		// WORKPILOT_E2E_CHROMIUM: a Chromium already on the machine (as for the E2E suites).
		const browser = await chromium.launch(
			process.env.WORKPILOT_E2E_CHROMIUM
				? { executablePath: process.env.WORKPILOT_E2E_CHROMIUM }
				: {},
		);
		for (const [name, go] of Object.entries(SHOTS)) {
			if (only.length && !only.includes(name)) continue;
			const page = await openApp(browser);
			await go(page);
			await page.mouse.move(1100, 1070); // no hover state in the picture
			await page.waitForTimeout(400);
			await page.screenshot({ path: path.join(OUT, `${name}.png`) });
			console.log(`saved ${name}.png`);
			await page.close();
		}
		await browser.close();
	} finally {
		vite.kill();
	}
})().catch((error) => {
	console.error(error);
	process.exit(1);
});
