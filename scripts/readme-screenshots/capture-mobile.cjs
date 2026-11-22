#!/usr/bin/env node
/**
 * Captures the phone app's screenshot strip of the README
 * (.github/assets/screenshots/mobile.png): four screens, each in another of
 * the app's colour themes and modes, captioned, at the phone's own
 * proportions (390 × 844 points, an iPhone 14 screen without the browser's
 * bars), never stretched.
 *
 * It serves the app's web bundle and answers its server calls with the invented
 * data below (Playwright routes): nothing real is contacted, no account needed.
 * The theme comes from the account's preferences (`/users/me/preferences`),
 * as it does on a real phone.
 *
 *   (cd apps/mobile && pnpm install && EXPO_OFFLINE=1 pnpm run export:web)
 *   node scripts/readme-screenshots/capture-mobile.cjs
 *
 * SCREENS=1 also keeps each screen alone (mobile-<name>.png) in OUT.
 */
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const REPO = path.resolve(__dirname, "..", "..");
const FRONTEND = path.join(REPO, "apps", "frontend");
const MOBILE = path.join(REPO, "apps", "mobile");
// The mobile project's Playwright (its E2E suite), else the desktop's.
const { chromium } = require(
	require.resolve("@playwright/test", { paths: [MOBILE, FRONTEND] }),
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
		"019-search-part1",
		"Typo-tolerant product search (1/2): fuzzy index",
		"in_progress",
		"feature",
		1,
		3,
		6,
		"Bob Durand",
		// A part of an automatic split (apps/backend/task_split/).
		{
			group: {
				id: "019-search",
				title: "Typo-tolerant product search",
				index: 1,
				total: 2,
			},
		},
	),
	card(
		"022-rate-limit",
		"Rate-limit the public API",
		"in_progress",
		"bug_fix",
		3,
		4,
		14,
		"Chloé Petit",
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

const approvals = {
	criticality: "standard",
	criticalitySource: "assessed",
	needed: 1,
	count: 1,
	roles: [],
	missingRoles: [],
	approvals: [{ by: "Alice Martin", for: null, at: iso(500), roles: [] }],
	complete: true,
	approved: true,
};

function answer(url, method, prefs) {
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
				my_role: "owner",
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
	if (p.endsWith("/steering")) return { messages: [] };
	if (p === "/users/me/preferences") return prefs;
	if (/\/api\/board\/cards\/[^/]+\/approvals$/.test(p)) return approvals;
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

/** Every file of the web bundle, by its URL path ("/_expo/static/js/web/…"). */
function bundleFiles(dir, prefix = "") {
	const files = new Map();
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const url = `${prefix}/${entry.name}`;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			for (const [u, f] of bundleFiles(full, url)) files.set(u, f);
		} else {
			files.set(url, full);
		}
	}
	return files;
}

/**
 * Serves the bundle on localhost only. A request is looked up among the
 * bundle's own files, never joined to a path; anything else gets index.html,
 * whose router takes the path.
 */
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
	const files = bundleFiles(DIST);
	const index = path.join(DIST, "index.html");
	return http
		.createServer((req, res) => {
			const file =
				files.get(decodeURIComponent(req.url.split("?")[0])) ?? index;
			res.writeHead(200, {
				"content-type": types[path.extname(file)] || "application/octet-stream",
			});
			fs.createReadStream(file).pipe(res);
		})
		.listen(APP_PORT, "127.0.0.1");
}

const PHONE = { width: 390, height: 844 };

/** The four screens of the strip, each in a theme of its own. */
const SHOTS = [
	{
		name: "board",
		caption: "Board",
		theme: "Default · light",
		prefs: { theme: "light", colorTheme: "default" },
	},
	{
		name: "card",
		caption: "Card",
		theme: "Default · dark",
		prefs: { theme: "dark", colorTheme: "default" },
	},
	{
		name: "dashboard",
		caption: "Dashboard",
		theme: "Ocean · light",
		prefs: { theme: "light", colorTheme: "ocean" },
	},
	{
		name: "settings",
		caption: "Appearance",
		theme: "Forest · dark",
		prefs: { theme: "dark", colorTheme: "forest" },
	},
];

/**
 * Lays the phone screens side by side, in rounded frames of the phone's own
 * proportions, each with its caption, as one picture.
 */
async function strip(browser, shots) {
	const gap = 36;
	const pad = 48;
	const width =
		pad * 2 + shots.length * (PHONE.width + 16) + (shots.length - 1) * gap;
	const page = await browser.newPage({
		viewport: { width, height: 1040 },
		deviceScaleFactor: 2,
	});
	const frames = shots
		.map(
			({ png, shot }) => `<figure>
				<div class="phone"><img src="data:image/png;base64,${png.toString("base64")}"></div>
				<figcaption><b>${shot.caption}</b><span>${shot.theme}</span></figcaption>
			</figure>`,
		)
		.join("");
	await page.setContent(`<!doctype html><style>
		body { margin: 0; background: #111116; display: flex; gap: ${gap}px; padding: ${pad}px ${pad}px 36px;
			font-family: -apple-system, "Segoe UI", Roboto, sans-serif; }
		figure { margin: 0; display: flex; flex-direction: column; align-items: center; gap: 18px; }
		.phone { border: 8px solid #2a2a31; border-radius: 52px; overflow: hidden;
			width: ${PHONE.width}px; height: ${PHONE.height}px; box-shadow: 0 0 0 1px #3a3a44; }
		.phone img { width: ${PHONE.width}px; height: ${PHONE.height}px; display: block; }
		figcaption { display: flex; flex-direction: column; align-items: center; gap: 4px; color: #e6e6e6; }
		figcaption b { font-size: 20px; }
		figcaption span { font-size: 15px; color: #9aa3ab; }
	</style>${frames}`);
	const body = await page.locator("body").boundingBox();
	await page.screenshot({
		path: path.join(OUT, "mobile.png"),
		clip: { x: 0, y: 0, width, height: Math.ceil(body.height) },
	});
	await page.close();
}

/** A phone signed in to the invented server, in `prefs`'s theme. */
async function signedInPhone(browser, prefs) {
	const context = await browser.newContext({
		viewport: PHONE,
		screen: PHONE,
		deviceScaleFactor: 2,
		isMobile: true,
		hasTouch: true,
		locale: "en-US",
		colorScheme: prefs.theme === "dark" ? "dark" : "light",
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
		const body = answer(req.url(), req.method(), prefs);
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
	await page.goto(`http://127.0.0.1:${APP_PORT}/`);
	await page.getByLabel("Server address").fill(SERVER);
	await page.getByLabel("Email").fill(user.email);
	await page.getByLabel("Password").fill("demo-password");
	await page.getByRole("button", { name: "Sign in", exact: true }).click();
	await page
		.getByRole("button", { name: "acme-storefront" })
		.waitFor({ timeout: 30_000 });
	return { context, page };
}

/** Opens the project's board on its "In Progress" column. */
async function openBoard(page) {
	await page.getByRole("button", { name: "acme-storefront" }).click();
	await page
		.getByRole("tab", { name: /In Progress/ })
		.click({ timeout: 30_000 });
	await page.waitForTimeout(1200);
}

/** Brings the phone to the screen of `name`. */
async function show(page, name) {
	if (name === "settings") {
		await page.getByRole("button", { name: "Settings" }).click();
		await page
			.getByText("Appearance", { exact: false })
			.first()
			.scrollIntoViewIfNeeded();
		await page
			.getByText("Color theme", { exact: false })
			.first()
			.scrollIntoViewIfNeeded();
		return;
	}
	await openBoard(page);
	if (name === "card") {
		await page.getByRole("button", { name: "One-page checkout" }).click();
	} else if (name === "dashboard") {
		await page.getByRole("tab", { name: "Dashboard" }).click();
	}
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
		const shots = [];
		for (const shot of SHOTS) {
			const { context, page } = await signedInPhone(browser, shot.prefs);
			await show(page, shot.name);
			await page.waitForTimeout(1800);
			const png = await page.screenshot();
			if (process.env.SCREENS)
				fs.writeFileSync(path.join(OUT, `mobile-${shot.name}.png`), png);
			shots.push({ png, shot });
			await context.close();
		}
		await strip(browser, shots);
		console.log("saved mobile.png");
	} finally {
		await browser.close();
		server.close();
	}
})().catch((error) => {
	console.error(error);
	process.exit(1);
});
