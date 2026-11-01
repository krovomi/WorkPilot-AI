// Demo data for the README screenshots. Runs in the page before the app,
// after preview-init.js, and only replaces what the browser mock returns.
// Everything here is invented: the "acme-storefront" project, its people and
// its numbers.
(() => {
	const now = Date.now();
	const min = 60_000;
	const hour = 60 * min;
	const day = 24 * hour;
	const ago = (ms) => new Date(now - ms);
	const PROJECT = "mock-project-1";
	try {
		localStorage.setItem("usageProvider", "anthropic");
	} catch {
		/* storage unavailable */
	}
	const ok = (data) => async () => ({ success: true, data });

	const sub = (id, title, status, files = []) => ({
		id,
		title,
		description: title,
		status,
		files,
	});

	const tasks = [
		{
			id: "t-01",
			specId: "014-passkeys",
			title: "Sign in with passkeys",
			description:
				"Add WebAuthn passkeys next to email/password, with recovery codes and device management.",
			status: "backlog",
			subtasks: [],
			logs: [],
			metadata: {
				category: "feature",
				priority: "high",
				complexity: "large",
				impact: "high",
				sourceType: "roadmap",
			},
			createdAt: ago(2 * day),
			updatedAt: ago(2 * day),
		},
		{
			id: "t-02",
			specId: "015-dark-mode",
			title: "Dark mode for the storefront",
			description:
				"Theme tokens, a system-aware toggle and persisted preference across sessions.",
			status: "backlog",
			subtasks: [],
			logs: [],
			metadata: {
				category: "ui_ux",
				priority: "medium",
				complexity: "medium",
				impact: "medium",
				sourceType: "ideation",
			},
			createdAt: ago(1 * day),
			updatedAt: ago(1 * day),
		},
		{
			id: "t-03",
			specId: "016-n-plus-one",
			title: "Fix N+1 queries on order history",
			description:
				"Order history issues one query per line item. Batch-load products and cache prices.",
			status: "queue",
			subtasks: [],
			logs: [],
			metadata: {
				category: "performance",
				priority: "high",
				complexity: "small",
				impact: "high",
				sourceType: "insights",
			},
			createdAt: ago(5 * hour),
			updatedAt: ago(5 * hour),
		},
		{
			id: "t-04",
			specId: "017-rate-limit",
			title: "Rate-limit the public API",
			description:
				"Token bucket per API key, 429 with Retry-After, and a usage header on every response.",
			status: "queue",
			subtasks: [],
			logs: [],
			metadata: {
				category: "security",
				priority: "urgent",
				complexity: "medium",
				impact: "high",
				sourceType: "github",
				githubIssueNumber: 482,
			},
			createdAt: ago(3 * hour),
			updatedAt: ago(3 * hour),
		},
		{
			id: "t-05",
			specId: "018-checkout",
			title: "One-page checkout",
			description:
				"Merge shipping, payment and review into a single step with inline validation.",
			status: "in_progress",
			subtasks: [
				sub("s1", "Checkout state machine", "completed", [
					"src/checkout/machine.ts",
				]),
				sub("s2", "Address autocomplete", "completed", [
					"src/checkout/Address.tsx",
				]),
				sub("s3", "Stripe Payment Element", "in_progress", [
					"src/checkout/Payment.tsx",
				]),
				sub("s4", "Order review and confirmation", "pending"),
				sub("s5", "E2E tests", "pending"),
			],
			logs: [
				"[INFO] Planner produced 5 subtasks",
				"[INFO] Coder working on subtask 3/5",
			],
			executionProgress: {
				phase: "coding",
				phaseProgress: 55,
				overallProgress: 52,
			},
			metadata: {
				category: "feature",
				priority: "high",
				complexity: "large",
				impact: "critical",
				sourceType: "roadmap",
			},
			createdAt: ago(9 * hour),
			updatedAt: ago(2 * min),
		},
		{
			id: "t-06",
			specId: "019-search",
			title: "Typo-tolerant product search",
			description:
				"Fuzzy matching and synonyms on the catalogue search, with highlighted results.",
			status: "in_progress",
			subtasks: [
				sub("s1", "Search index schema", "completed", ["src/search/index.ts"]),
				sub("s2", "Fuzzy matcher", "in_progress", ["src/search/fuzzy.ts"]),
				sub("s3", "Result highlighting", "pending"),
			],
			logs: ["[INFO] Coder working on subtask 2/3"],
			executionProgress: {
				phase: "coding",
				phaseProgress: 30,
				overallProgress: 38,
			},
			metadata: {
				category: "feature",
				priority: "medium",
				complexity: "medium",
				impact: "high",
			},
			createdAt: ago(7 * hour),
			updatedAt: ago(6 * min),
		},
		{
			id: "t-07",
			specId: "020-csv-export",
			title: "Export reports as CSV",
			description:
				"Let merchants download any report table as CSV, quoting and separators handled.",
			status: "ai_review",
			subtasks: [
				sub("s1", "CSV serializer", "completed", ["src/lib/csv.ts"]),
				sub("s2", "Download action", "completed", [
					"src/reports/ReportTable.tsx",
				]),
			],
			logs: ["[INFO] QA review started"],
			executionProgress: {
				phase: "qa_review",
				phaseProgress: 60,
				overallProgress: 90,
			},
			metadata: {
				category: "feature",
				priority: "medium",
				complexity: "small",
				impact: "medium",
			},
			createdAt: ago(12 * hour),
			updatedAt: ago(10 * min),
		},
		{
			id: "t-08",
			specId: "021-a11y",
			title: "Keyboard navigation in the cart",
			description:
				"Focus order, visible focus rings and ARIA live updates when quantities change.",
			status: "human_review",
			subtasks: [
				sub("s1", "Focus management", "completed"),
				sub("s2", "Live regions", "completed"),
			],
			logs: ["[INFO] QA approved, awaiting human review"],
			executionProgress: {
				phase: "complete",
				phaseProgress: 100,
				overallProgress: 100,
			},
			metadata: {
				category: "ui_ux",
				priority: "medium",
				complexity: "small",
				impact: "medium",
				sourceType: "ideation",
			},
			createdAt: ago(1 * day),
			updatedAt: ago(40 * min),
		},
		{
			id: "t-09",
			specId: "012-invoices",
			title: "PDF invoices by email",
			description:
				"Generate a PDF invoice when an order ships and attach it to the confirmation email.",
			status: "done",
			subtasks: [
				sub("s1", "Invoice template", "completed"),
				sub("s2", "Mailer hook", "completed"),
			],
			logs: ["[INFO] Merged"],
			executionProgress: {
				phase: "complete",
				phaseProgress: 100,
				overallProgress: 100,
			},
			metadata: {
				category: "feature",
				priority: "medium",
				complexity: "medium",
				impact: "medium",
				prUrl: "https://example.com/pr/131",
			},
			createdAt: ago(3 * day),
			updatedAt: ago(1 * day),
		},
		{
			id: "t-10",
			specId: "013-deps",
			title: "Upgrade to React 19",
			description:
				"Bump React, migrate deprecated APIs and fix the three failing snapshot tests.",
			status: "done",
			subtasks: [
				sub("s1", "Dependency bump", "completed"),
				sub("s2", "API migration", "completed"),
			],
			logs: ["[INFO] Merged"],
			executionProgress: {
				phase: "complete",
				phaseProgress: 100,
				overallProgress: 100,
			},
			metadata: {
				category: "infrastructure",
				priority: "low",
				complexity: "medium",
				impact: "medium",
			},
			createdAt: ago(4 * day),
			updatedAt: ago(2 * day),
		},
	].map((t) => ({ projectId: PROJECT, ...t }));

	// --- Roadmap -------------------------------------------------------------
	const feat = (
		id,
		title,
		description,
		phaseId,
		status,
		priority,
		complexity,
		impact,
		extra = {},
	) => ({
		id,
		title,
		description,
		rationale: description,
		priority,
		complexity,
		impact,
		phaseId,
		dependencies: [],
		status,
		acceptanceCriteria: [],
		userStories: [],
		...extra,
	});
	const features = [
		feat(
			"f1",
			"One-page checkout",
			"Shipping, payment and review in one step.",
			"p1",
			"in_progress",
			"must",
			"high",
			"high",
			{ linkedSpecId: "018-checkout" },
		),
		feat(
			"f2",
			"PDF invoices",
			"Invoice attached to the shipping email.",
			"p1",
			"done",
			"must",
			"medium",
			"medium",
		),
		feat(
			"f3",
			"Typo-tolerant search",
			"Fuzzy matching and synonyms on the catalogue.",
			"p1",
			"in_progress",
			"should",
			"medium",
			"high",
		),
		feat(
			"f4",
			"Passkeys",
			"Password-less sign-in with WebAuthn.",
			"p2",
			"planned",
			"should",
			"high",
			"high",
		),
		feat(
			"f5",
			"Wishlists",
			"Save items and share a list with a link.",
			"p2",
			"planned",
			"could",
			"low",
			"medium",
			{ votes: 128, source: { provider: "canny" } },
		),
		feat(
			"f6",
			"Rate limiting",
			"Per-key quotas on the public API.",
			"p2",
			"planned",
			"must",
			"medium",
			"high",
		),
		feat(
			"f7",
			"Dark mode",
			"System-aware theme for the storefront.",
			"p2",
			"under_review",
			"could",
			"medium",
			"medium",
			{ votes: 87, source: { provider: "canny" } },
		),
		feat(
			"f8",
			"Subscriptions",
			"Recurring orders with pause and skip.",
			"p3",
			"under_review",
			"should",
			"high",
			"high",
			{ votes: 214, source: { provider: "canny" } },
		),
		feat(
			"f9",
			"Multi-currency",
			"Prices and checkout in 12 currencies.",
			"p3",
			"under_review",
			"could",
			"high",
			"high",
		),
		feat(
			"f10",
			"Merchant mobile app",
			"Orders and stock from the phone.",
			"p3",
			"under_review",
			"could",
			"high",
			"medium",
		),
	];
	const roadmap = {
		id: "rm-1",
		projectId: PROJECT,
		projectName: "acme-storefront",
		version: "1.0",
		vision:
			"The fastest way for independent brands to sell online, from first product to first million.",
		targetAudience: {
			primary: "Independent e-commerce brands",
			secondary: ["Agencies", "Marketplace sellers"],
		},
		phases: [
			{
				id: "p1",
				name: "Foundation",
				description: "Conversion basics",
				order: 1,
				status: "in_progress",
				features: ["f1", "f2", "f3"],
				milestones: [],
			},
			{
				id: "p2",
				name: "Trust & retention",
				description: "Accounts, security and loyalty",
				order: 2,
				status: "planned",
				features: ["f4", "f5", "f6", "f7"],
				milestones: [],
			},
			{
				id: "p3",
				name: "Scale",
				description: "New markets and channels",
				order: 3,
				status: "planned",
				features: ["f8", "f9", "f10"],
				milestones: [],
			},
		],
		features,
		status: "active",
		createdAt: ago(10 * day),
		updatedAt: ago(1 * hour),
	};

	// --- Ideation ------------------------------------------------------------
	const idea = (id, type, title, description, extra) => ({
		id,
		type,
		title,
		description,
		rationale: description,
		status: "draft",
		createdAt: ago(3 * hour),
		...extra,
	});
	const ideation = {
		id: "ide-1",
		projectId: PROJECT,
		config: {
			enabledTypes: [
				"code_improvements",
				"ui_ux_improvements",
				"security_hardening",
				"performance_optimizations",
				"code_quality",
			],
			includeRoadmapContext: true,
			includeKanbanContext: true,
			maxIdeasPerType: 5,
		},
		ideas: [
			idea(
				"i1",
				"security_hardening",
				"Rotate session tokens on privilege change",
				"Session IDs survive a role upgrade, which allows fixation after an admin grants rights.",
				{
					category: "authentication",
					severity: "high",
					affectedFiles: ["src/auth/session.ts"],
					currentRisk: "Session fixation",
					remediation: "Regenerate the session on role change",
				},
			),
			idea(
				"i2",
				"performance_optimizations",
				"Lazy-load product images below the fold",
				"The category page downloads 4.2 MB of images before first paint.",
				{
					category: "network",
					impact: "high",
					affectedAreas: ["CategoryPage"],
					expectedImprovement: "-60% LCP bytes",
					implementation: "loading=lazy + srcset",
					estimatedEffort: "small",
				},
			),
			idea(
				"i3",
				"code_improvements",
				"Reuse the address validator in account settings",
				"Checkout already validates postcodes per country; settings re-implements a weaker copy.",
				{
					buildsUpon: ["Checkout"],
					estimatedEffort: "trivial",
					affectedFiles: ["src/account/Address.tsx"],
					existingPatterns: ["validators/"],
				},
			),
			idea(
				"i4",
				"ui_ux_improvements",
				"Show delivery date before payment",
				"Shoppers abandon when the delivery estimate only appears after payment.",
				{
					category: "usability",
					affectedComponents: ["Checkout"],
					currentState: "Date shown on confirmation",
					proposedChange: "Show it on the shipping step",
					userBenefit: "Fewer abandoned carts",
				},
			),
			idea(
				"i5",
				"code_quality",
				"Split the 1,400-line OrderService",
				"OrderService mixes pricing, tax and fulfilment, which makes every change risky.",
				{
					category: "large_files",
					severity: "major",
					affectedFiles: ["src/orders/OrderService.ts"],
					currentState: "1,412 lines",
					proposedChange: "Extract pricing and tax modules",
					estimatedEffort: "medium",
					breakingChange: false,
				},
			),
			idea(
				"i6",
				"security_hardening",
				"Pin third-party checkout scripts with SRI",
				"Two payment scripts load without integrity hashes.",
				{
					category: "dependencies",
					severity: "medium",
					affectedFiles: ["public/index.html"],
					currentRisk: "Supply-chain injection",
					remediation: "Add integrity attributes",
				},
			),
			idea(
				"i7",
				"performance_optimizations",
				"Cache tax rates per region",
				"Tax rates are fetched on every cart update.",
				{
					category: "caching",
					impact: "medium",
					affectedAreas: ["/api/cart"],
					expectedImprovement: "-180 ms per update",
					implementation: "LRU with 1 h TTL",
					estimatedEffort: "small",
				},
			),
			idea(
				"i8",
				"ui_ux_improvements",
				"Empty cart suggestions",
				"An empty cart is a dead end; suggest recently viewed items.",
				{
					category: "interaction",
					affectedComponents: ["Cart"],
					currentState: "Blank page",
					proposedChange: "Recently viewed carousel",
					userBenefit: "More recovered sessions",
				},
			),
		],
		projectContext: {
			existingFeatures: ["Checkout", "Catalogue"],
			techStack: ["TypeScript", "React", "Node.js", "PostgreSQL"],
			plannedFeatures: ["Passkeys"],
		},
		generatedAt: ago(3 * hour),
		updatedAt: ago(3 * hour),
	};

	// --- Insights ------------------------------------------------------------
	const insightsSession = {
		id: "session-1",
		projectId: PROJECT,
		title: "Why is checkout slow?",
		messages: [
			{
				id: "m1",
				role: "user",
				content: "Checkout feels slow on mobile. Where does the time go?",
				timestamp: ago(32 * min),
			},
			{
				id: "m2",
				role: "assistant",
				timestamp: ago(31 * min),
				toolsUsed: [
					{ name: "Grep", input: "fetchTaxRates", timestamp: ago(31 * min) },
					{
						name: "Read",
						input: "src/cart/useCart.ts",
						timestamp: ago(31 * min),
					},
					{ name: "Read", input: "src/api/cart.ts", timestamp: ago(31 * min) },
				],
				content:
					"Three things stand out on the checkout path:\n\n" +
					"1. **Tax rates are fetched on every cart update** (`src/cart/useCart.ts:48`). Each quantity change triggers `fetchTaxRates()`, about 180 ms on a 4G connection.\n" +
					"2. **The Stripe script blocks rendering**: it is loaded synchronously in `index.html` instead of on the payment step.\n" +
					"3. **Order history runs one query per line item** (`src/api/orders.ts:112`), so returning customers wait longer.\n\n" +
					"Caching tax rates per region is the quickest win. I can turn it into a task.",
				suggestedTask: {
					title: "Cache tax rates per region",
					description:
						"Cache fetchTaxRates() results per region with a 1 h TTL and invalidate on admin change.",
					metadata: {
						category: "performance",
						complexity: "small",
						impact: "high",
					},
				},
			},
		],
		createdAt: ago(32 * min),
		updatedAt: ago(31 * min),
	};
	const insightsSessions = [
		{
			id: "session-1",
			projectId: PROJECT,
			title: "Why is checkout slow?",
			messageCount: 2,
			createdAt: ago(32 * min),
			updatedAt: ago(31 * min),
		},
		{
			id: "session-2",
			projectId: PROJECT,
			title: "How does the order pipeline work?",
			messageCount: 9,
			createdAt: ago(3 * hour),
			updatedAt: ago(3 * hour),
		},
		{
			id: "session-3",
			projectId: PROJECT,
			title: "Security review of auth",
			messageCount: 14,
			createdAt: ago(1 * day),
			updatedAt: ago(1 * day),
		},
		{
			id: "session-4",
			projectId: PROJECT,
			title: "Plan the search rewrite",
			messageCount: 6,
			createdAt: ago(3 * day),
			updatedAt: ago(3 * day),
		},
	];

	// --- Dashboard -----------------------------------------------------------
	const snapshot = {
		tasks_by_status: { completed: 47, in_progress: 5, pending: 16, failed: 2 },
		avg_completion_by_complexity: {
			trivial: 420,
			small: 1080,
			medium: 2460,
			large: 6120,
			complex: 11880,
		},
		qa_first_pass_rate: 87.2,
		qa_avg_score: 8.6,
		total_tokens: 18_420_000,
		tokens_by_provider: {
			anthropic: 11_200_000,
			openai: 4_100_000,
			google: 2_300_000,
			ollama: 820_000,
		},
		total_cost: 142.37,
		cost_by_model: {
			"claude-sonnet": 71.2,
			"claude-opus": 38.9,
			"gpt-5": 21.4,
			"gemini-pro": 10.87,
		},
		merge_auto_count: 39,
		merge_manual_count: 8,
	};

	const projects = [
		{
			id: PROJECT,
			name: "acme-storefront",
			path: "/home/demo/acme-storefront",
			autoBuildPath: "/home/demo/acme-storefront/.workpilot",
		},
		{
			id: "mock-project-2",
			name: "acme-api",
			path: "/home/demo/acme-api",
			autoBuildPath: "/home/demo/acme-api/.workpilot",
		},
	];

	window.__DEMO_OVERRIDES__ = Object.assign(window.__DEMO_OVERRIDES__ || {}, {
		getTasks: async (projectId) => ({
			success: true,
			data: tasks.filter((t) => t.projectId === projectId),
		}),
		getRoadmap: ok(roadmap),
		getIdeation: ok(ideation),
		getInsightsSession: ok(insightsSession),
		listInsightsSessions: ok(insightsSessions),
		requestUsageUpdate: async () => ({
			success: true,
			data: {
				sessionPercent: 34,
				weeklyPercent: 21,
				profileId: "default",
				profileName: "Work",
				sessionResetTimestamp: new Date(now + 3 * hour).toISOString(),
				weeklyResetTimestamp: new Date(now + 4 * day).toISOString(),
				fetchedAt: new Date(),
				limitType: "session",
				usageWindows: {
					sessionWindowLabel: "5-hour",
					weeklyWindowLabel: "7-day",
				},
			},
		}),
		getDashboardSnapshot: async () => ({ success: true, snapshot }),
		__wrap: {
			getProjects: (r) => {
				if (!r || !Array.isArray(r.data)) return r;
				return {
					...r,
					data: r.data.map((p) => ({
						...p,
						...(projects.find((x) => x.id === p.id) || {}),
					})),
				};
			},
		},
	});
})();
