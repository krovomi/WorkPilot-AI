#!/usr/bin/env node
/**
 * Captures the phone app's screenshot strip of the README
 * (.github/assets/screenshots/mobile.png).
 *
 * It serves the app's web bundle and answers its server calls with the invented
 * data below (Playwright routes): nothing real is contacted, no account needed.
 *
 *   (cd apps/mobile && pnpm install && EXPO_OFFLINE=1 pnpm run export:web)
 *   node scripts/readme-screenshots/capture-mobile.cjs
 */
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const REPO = path.resolve(__dirname, "..", "..");
const FRONTEND = path.join(REPO, "apps", "frontend");
const { chromium, devices } = require(
	require.resolve("@playwright/test", { paths: [FRONTEND] }),
);

const DIST =
	process.env.MOBILE_DIST || path.join(REPO, "apps", "mobile", "dist");
const OUT =
	process.env.OUT || path.join(REPO, ".github", "assets", "screenshots");
const APP_PORT = Number(process.env.MOBILE_PORT || 3000);
const SERVER = "https://workpilot.example.com";
const PROJECT = "p-storefront";
const iso = (minAgo) => new Date(Date.now() - minAgo * 60_000).toISOString();

const card = (
	id,
	title,
	column,
	kind,
	done,
	total,
	minAgo,
	who,
	extra = {},
) => ({
	id,
	title,
	column,
	kind,
	updatedAt: iso(minAgo),
	subtasks: { completed: done, total },
	specId: id,
	claimedBy: who ? `u-${who}` : null,
	claimedByName: who,
	...extra,
});
const cards = [
	card(
		"014-passkeys",
		"Sign in with passkeys",
		"backlog",
		"feature",
		0,
		0,
		2880,
		null,
	),
	card(
		"015-dark-mode",
		"Dark mode for the storefront",
		"backlog",
		"feature",
		0,
		0,
		1440,
		null,
	),
	card(
		"016-n-plus-one",
		"Fix N+1 queries on order history",
		"queue",
		"bug_fix",
		0,
		0,
		300,
		null,
	),
	card(
		"018-checkout",
		"One-page checkout",
		"in_progress",
		"feature",
		2,
		5,
		2,
		"Alice Martin",
	),
	card(
		"019-search",
		"Typo-tolerant product search",
		"in_progress",
		"feature",
		1,
		3,
		6,
		"Bob Durand",
	),
	card(
		"020-csv-export",
		"Export reports as CSV",
		"ai_review",
		"feature",
		2,
		2,
		10,
		"Alice Martin",
	),
	card(
		"021-a11y",
		"Keyboard navigation in the cart",
		"human_review",
		"refactoring",
		2,
		2,
		40,
		"Bob Durand",
		{ reviewReason: "completed" },
	),
	card(
		"012-invoices",
		"PDF invoices by email",
		"done",
		"feature",
		2,
		2,
		1440,
		"Alice Martin",
	),
];
const spec = `## Goal
Merge shipping, payment and review into a single checkout step.

## Acceptance criteria
- Inline validation on every field
- Delivery date shown before payment
- Stripe Payment Element, no redirect
- E2E test of a full purchase`;
const details = {
	...cards[3],
	description:
		"Merge shipping, payment and review into a single step with inline validation.",
	spec,
	qaReport: null,
	approval: {
		approved: true,
		approvedBy: "Alice Martin",
		approvedAt: iso(500),
	},
	requireReview: true,
};
const runs = [
	{
		id: "r3",
		spec_id: "018-checkout",
		phase: "build",
		started_by: "Alice Martin",
		model: "claude-sonnet",
		status: "running",
		started_at: iso(38),
		finished_at: null,
		error: null,
	},
	{
		id: "r2",
		spec_id: "018-checkout",
		phase: "spec",
		started_by: "Alice Martin",
		model: "claude-opus",
		status: "succeeded",
		started_at: iso(52),
		finished_at: iso(40),
		error: null,
	},
];
const user = {
	id: "u-alice",
	email: "alice@example.com",
	display_name: "Alice Martin",
	role: "member",
};
const org = { id: "o-acme", name: "Acme", slug: "acme", my_role: "admin" };

function answer(url, method) {
	const u = new URL(url);
	const p = u.pathname;
	if (p === "/auth/config")
		return { local_enabled: true, entra_enabled: false };
	if (p === "/auth/login" || p === "/auth/refresh" || p === "/auth/switch-org")
		return {
			access_token: "demo",
			refresh_token: "demo",
			expires_in: 3600,
			user,
		};
	if (p === "/auth/me/permissions")
		return {
			user_id: user.id,
			is_platform_admin: false,
			org_id: org.id,
			org_role: "admin",
			permissions: [
				"task.read",
				"task.write",
				"insight.read",
				"vcs.read",
				"analytics.read",
				"project.read",
			],
			organizations: [org],
		};
	if (p === "/projects")
		return [
			{
				id: PROJECT,
				org_id: org.id,
				name: "acme-storefront",
				repo_url: "https://example.com/acme/storefront.git",
				default_branch: "main",
				my_role: "admin",
				forge: "github",
			},
			{
				id: "p-api",
				org_id: org.id,
				name: "acme-api",
				repo_url: "https://example.com/acme/api.git",
				default_branch: "main",
				my_role: "member",
				forge: "github",
			},
		];
	if (p.startsWith("/projects/") && p.includes("/runs")) return runs;
	if (p.startsWith("/projects/"))
		return {
			id: PROJECT,
			org_id: org.id,
			name: "acme-storefront",
			repo_url: "",
			default_branch: "main",
			my_role: "admin",
		};
	if (p === "/api/board/cards") return { cards };
	if (p === "/api/board/stream") return { url: null };
	if (/\/api\/board\/cards\/[^/]+\/changes$/.test(p))
		return {
			exists: true,
			branch: "workpilot/018-checkout",
			baseBranch: "main",
			commitCount: 4,
			filesChanged: 6,
			additions: 412,
			deletions: 87,
			files: [],
		};
	if (/\/api\/board\/cards\/[^/]+\/logs$/.test(p)) return { logs: null };
	if (/\/api\/board\/cards\/[^/]+$/.test(p)) return details;
	if (p.endsWith("/workspace/dashboard"))
		return {
			snapshot: {
				tasks_by_status: { completed: 47, in_progress: 5, pending: 16 },
				qa_first_pass_rate: 87.2,
				qa_avg_score: 8.6,
				total_tokens: 18420000,
				tokens_by_provider: {
					anthropic: 11200000,
					openai: 4100000,
					google: 2300000,
				},
				total_cost: 142.37,
				cost_by_model: {
					"claude-sonnet": 71.2,
					"claude-opus": 38.9,
					"gpt-5": 21.4,
				},
				merge_auto_count: 39,
				merge_manual_count: 8,
			},
		};
	if (p.endsWith("/workspace/costs"))
		return {
			summary: {
				total_cost: 96.4,
				cost_by_provider: { anthropic: 70.1, openai: 26.3 },
				cost_by_model: {},
				total_tokens: 12400000,
				tokens_input: 9100000,
				tokens_output: 3300000,
				period_days: 30,
				daily_avg: 3.21,
				trend_pct: -12,
			},
		};
	if (p.endsWith("/workspace/sessions")) return { sessions: [] };
	if (method !== "GET") return {};
	return null;
}

function serveDist() {
	const types = {
		".html": "text/html",
		".js": "text/javascript",
		".css": "text/css",
		".json": "application/json",
		".png": "image/png",
		".ico": "image/x-icon",
		".ttf": "font/ttf",
	};
	return http
		.createServer((req, res) => {
			let file = path.join(DIST, decodeURIComponent(req.url.split("?")[0]));
			if (
				!file.startsWith(DIST) ||
				!fs.existsSync(file) ||
				fs.statSync(file).isDirectory()
			) {
				file = path.join(DIST, "index.html"); // the app's own router takes the path
			}
			res.writeHead(200, {
				"content-type": types[path.extname(file)] || "application/octet-stream",
			});
			fs.createReadStream(file).pipe(res);
		})
		.listen(APP_PORT);
}

/** Lays the phone screens side by side, in rounded frames, as one picture. */
async function strip(browser, shots) {
	const page = await browser.newPage({
		viewport: { width: 1780, height: 1249 },
	});
	const frames = shots
		.map(
			(png) =>
				`<div class="phone"><img src="data:image/png;base64,${png.toString("base64")}"></div>`,
		)
		.join("");
	await page.setContent(`<!doctype html><style>
		body { margin: 0; background: #111116; display: flex; gap: 40px; padding: 40px; }
		.phone { border: 6px solid #34343c; border-radius: 54px; overflow: hidden; width: 540px; height: 1169px; }
		.phone img { width: 100%; height: 100%; display: block; }
	</style>${frames}`);
	await page.screenshot({ path: path.join(OUT, "mobile.png") });
	await page.close();
}

(async () => {
	if (!fs.existsSync(path.join(DIST, "index.html"))) {
		throw new Error(
			`no web bundle in ${DIST}: run "pnpm run export:web" in apps/mobile first`,
		);
	}
	const server = serveDist();
	// WORKPILOT_E2E_CHROMIUM: a Chromium already on the machine (as for the E2E suites).
	const browser = await chromium.launch(
		process.env.WORKPILOT_E2E_CHROMIUM
			? { executablePath: process.env.WORKPILOT_E2E_CHROMIUM }
			: {},
	);
	try {
		const context = await browser.newContext({
			...devices["iPhone 14"],
			locale: "en-US",
			colorScheme: "light",
		});
		await context.route(`${SERVER}/**`, async (route) => {
			const req = route.request();
			const cors = { "access-control-allow-origin": "*" };
			if (req.method() === "OPTIONS") {
				return route.fulfill({
					status: 204,
					headers: {
						...cors,
						"access-control-allow-headers": "*",
						"access-control-allow-methods": "*",
					},
				});
			}
			const body = answer(req.url(), req.method());
			if (body === null)
				console.warn("not in the demo data:", req.method(), req.url());
			return route.fulfill({
				status: 200,
				contentType: "application/json",
				headers: cors,
				body: JSON.stringify(body ?? {}),
			});
		});
		const page = await context.newPage();
		page.on("pageerror", (e) =>
			console.warn("pageerror:", e.message.slice(0, 160)),
		);
		await page.goto(`http://localhost:${APP_PORT}/`);
		await page.getByLabel("Server address").fill(SERVER);
		await page.getByLabel("Email").fill(user.email);
		await page.getByLabel("Password").fill("demo-password");
		await page.getByRole("button", { name: "Sign in", exact: true }).click();
		await page
			.getByRole("button", { name: "acme-storefront" })
			.click({ timeout: 30_000 });
		await page
			.getByRole("tab", { name: /In Progress/ })
			.click({ timeout: 30_000 });
		await page.waitForTimeout(1500);
		const board = await page.screenshot();
		await page.getByRole("button", { name: "One-page checkout" }).click();
		await page.waitForTimeout(2000);
		const card = await page.screenshot();
		await page.mouse.click(26, 32); // the header's back arrow
		await page.waitForTimeout(1500);
		await page.getByText("Dashboard", { exact: true }).first().click();
		await page.waitForTimeout(2000);
		const dashboard = await page.screenshot();
		await strip(browser, [board, card, dashboard]);
		console.log("saved mobile.png");
	} finally {
		await browser.close();
		server.close();
	}
})().catch((error) => {
	console.error(error);
	process.exit(1);
});
