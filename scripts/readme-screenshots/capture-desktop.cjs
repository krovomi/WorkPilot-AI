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

/** Opens a sidebar view: its space on the rail first, then its row in the panel. */
async function openView(page, label, group = "Workspace") {
	// Choosing the space already shown folds the panel: only choose another.
	const space = page.locator(`nav button[aria-label="${group}"]`).first();
	if ((await space.getAttribute("aria-pressed")) !== "true") {
		await space.click();
		await page.waitForTimeout(300);
	}
	const candidates = page.getByText(label, { exact: false });
	for (let i = 0; i < (await candidates.count()); i++) {
		const box = await candidates.nth(i).boundingBox();
		if (box && box.x < 300) {
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

// What the two Agent Terminals show (ANSI colours, as a pty would send them).
const C = {
	dim: "\x1b[2m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	cyan: "\x1b[36m",
	bold: "\x1b[1m",
	off: "\x1b[0m",
};
const TERMINAL_SESSIONS = [
	[
		`${C.dim}~/WorkPilot-AI/apps/backend${C.off}`,
		`${C.green}$${C.off} python run.py --spec 019 --project-dir ~/acme-storefront`,
		"",
		`${C.bold}${C.cyan}▸ Planner${C.off}  3 subtasks, 1 phase`,
		`  ${C.green}✓${C.off} 1.1 Build a trigram index of product names`,
		`  ${C.green}✓${C.off} 1.2 Add the synonyms table (sneakers ↔ trainers)`,
		`  ${C.yellow}●${C.off} 1.3 Rank results by edit distance`,
		"",
		`${C.bold}${C.cyan}▸ Coder${C.off}  src/search/fuzzy-index.ts`,
		`  ${C.dim}read${C.off}   src/search/catalog-search.ts`,
		`  ${C.dim}edit${C.off}   src/search/fuzzy-index.ts  ${C.green}+84${C.off} ${C.yellow}-6${C.off}`,
		`  ${C.dim}run${C.off}    pnpm vitest run src/search`,
		`  ${C.green}✓${C.off} 23 tests passed`,
		"",
		`${C.dim}tokens 41.2k · cache 78% · 3m 12s${C.off}`,
	],
	[
		`${C.dim}~/acme-storefront/.workpilot/worktrees/tasks/021-checkout${C.off}`,
		`${C.green}$${C.off} pnpm vitest run src/checkout`,
		"",
		` ${C.green}✓${C.off} src/checkout/payment-step.test.ts ${C.dim}(9 tests)${C.off}`,
		` ${C.green}✓${C.off} src/checkout/shipping-step.test.ts ${C.dim}(7 tests)${C.off}`,
		` ${C.green}✓${C.off} src/checkout/review-step.test.ts ${C.dim}(5 tests)${C.off}`,
		` ${C.green}✓${C.off} src/checkout/one-page-checkout.test.tsx ${C.dim}(12 tests)${C.off}`,
		"",
		` ${C.bold}Test Files${C.off}  ${C.green}4 passed${C.off} (4)`,
		` ${C.bold}     Tests${C.off}  ${C.green}33 passed${C.off} (33)`,
		` ${C.dim}  Duration  2.41s${C.off}`,
		"",
		`${C.green}$${C.off} `,
	],
];

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
	"visual-to-code": async (page) => {
		await openView(page, "Visual to Code", "Development");
		await page.getByText("Canvas", { exact: true }).first().click();
		await page.waitForTimeout(3000);
	},
	"import-design": (page) => openView(page, "Visual to Code", "Development"),
	"test-generation": (page) => openView(page, "Test Generation", "Development"),
	terminals: async (page) => {
		await openView(page, "Agent Terminals", "Agents");
		for (let i = 0; i < 2; i++) {
			await page.keyboard.press("Control+t");
			await page.waitForTimeout(1200);
		}
		await page.evaluate((sessions) => {
			const ids = window.__DEMO_TERMINALS__ || [];
			sessions.forEach((lines, i) => {
				if (ids[i])
					window.__DEMO_TERMINAL_OUTPUT__?.(ids[i], lines.join("\r\n"));
			});
		}, TERMINAL_SESSIONS);
		await page.waitForTimeout(1500);
	},
	settings: async (page) => {
		await page.getByText("Settings", { exact: true }).last().click();
		await page.waitForTimeout(2500);
	},
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
			// The activity pill counts the demo tasks left running: noise here.
			const hide = page.getByRole("button", { name: "Hide", exact: true });
			if (await hide.count()) await hide.last().click();
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
