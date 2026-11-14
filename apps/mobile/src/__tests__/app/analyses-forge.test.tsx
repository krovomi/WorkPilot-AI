import { act, fireEvent, screen, waitFor } from "expo-router/testing-library";
import { Alert } from "react-native";
import { type Call, type FakeServer, fakeServer, openApp, reply, restoreFetch } from "../../../test-support/fake-server";

const READ = ["board.read", "analytics.read", "vcs.read"];
const RUN = [...READ, "agent.execute", "agent.cancel"];
const VCS = [...READ, "vcs.write", "vcs.pr.merge", "agent.execute"];

afterEach(() => {
	restoreFetch();
	jest.useRealTimers();
	jest.restoreAllMocks();
});

describe("analyses", () => {
	const SAVED = {
		analysis: "accessibility",
		finished_at: "2026-11-12T10:00:00Z",
		run_by: "Ada",
		report: {
			score: 72.5,
			passed: true,
			summary: { total_issues: 3 },
			issues: [
				{ title: "Missing alt", severity: "high", file: "Home.tsx" },
				{ message: "Low contrast", level: "medium", description: "Low contrast" },
				...Array.from({ length: 20 }, (_, i) => ({ title: `Extra ${i}` })),
			],
		},
	};

	it("lists the five analyses and opens one", async () => {
		fakeServer({ "GET /api/features/analyses/tech-debt/report": { report: null } }, RUN);
		const app = await openApp("/projects/p1/analyses");
		expect(await screen.findByText("Accessibility")).toBeTruthy();
		for (const title of ["Translations", "Documentation drift", "Flaky tests", "Technical debt"]) {
			expect(screen.getByText(title)).toBeTruthy();
		}
		await fireEvent.press(screen.getByRole("button", { name: /Technical debt/ }));
		await waitFor(() => expect(app.getPathname()).toBe("/projects/p1/analyses/tech-debt"));
		expect(await screen.findByText("Never run on this project.")).toBeTruthy();
	});

	it("shows the last report: its figures and its lists, cut at 20 items", async () => {
		fakeServer({ "GET /api/features/analyses/accessibility/report": { report: JSON.stringify(SAVED) } }, RUN);
		await openApp("/projects/p1/analyses/accessibility");
		expect(await screen.findByText(/^Last run /)).toBeTruthy();
		expect(screen.getByText("72.50")).toBeTruthy();
		expect(screen.getByText("✓")).toBeTruthy();
		expect(screen.getByText("Summary · Total issues")).toBeTruthy();
		expect(screen.getByText("Issues (22)")).toBeTruthy();
		expect(screen.getByText("Missing alt")).toBeTruthy();
		expect(screen.getByText("high")).toBeTruthy();
		expect(screen.getByText("Home.tsx")).toBeTruthy();
		expect(screen.getByText("And 2 more on the desktop.")).toBeTruthy();
	});

	it("runs an analysis, follows its output and reads the report when it ends", async () => {
		jest.useFakeTimers();
		let saved: string | null = null;
		const server = fakeServer(
			{
				"GET /api/features/analyses/i18n/report": () => ({ report: saved }),
				"POST /api/features/analyses/i18n/jobs": { id: "job-a", feature: "analyses", status: "queued" },
				"GET /api/features/analyses/i18n/jobs/job-a": () =>
					saved
						? { id: "job-a", status: "succeeded", lines: [], next: 0 }
						: { id: "job-a", status: "running", lines: ["Scanning src", "I18N_RESULT: {}", "{\"x\":1}"], next: 3 },
			},
			RUN,
		);
		await openApp("/projects/p1/analyses/i18n");
		await fireEvent.press(await screen.findByRole("button", { name: "Generate" }));
		expect(await screen.findByText("An agent is working on it…")).toBeTruthy();
		await act(async () => {
			jest.advanceTimersByTime(3_000);
		});
		// The result lines are not progress: the last human line shows.
		expect(await screen.findByText("Scanning src")).toBeTruthy();

		saved = JSON.stringify({ ...SAVED, analysis: "i18n", report: { missing_keys: ["a.b", "c.d"] } });
		await act(async () => {
			jest.advanceTimersByTime(3_000);
		});
		expect(await screen.findByText("Missing keys (2)")).toBeTruthy();
		expect(screen.getByText("a.b")).toBeTruthy();
		expect(server.called("POST /api/features/analyses/i18n/jobs")).toHaveLength(1);
	});

	it("follows a run already going when the screen opens, keeps polling through an error, and stops it", async () => {
		jest.useFakeTimers();
		let polls = 0;
		const server = fakeServer(
			{
				"GET /api/features/analyses/doc-drift/report": { report: null, job: { id: "job-d", status: "running" } },
				"GET /api/features/analyses/doc-drift/jobs/job-d": () => {
					polls += 1;
					return polls === 1 ? reply(500, {}) : { id: "job-d", status: "running", lines: [], next: 0 };
				},
				"POST /api/features/analyses/doc-drift/jobs/job-d/cancel": { cancelled: true },
			},
			RUN,
		);
		await openApp("/projects/p1/analyses/doc-drift");
		expect(await screen.findByText("An agent is working on it…")).toBeTruthy();
		await act(async () => {
			jest.advanceTimersByTime(6_000);
		});
		await waitFor(() => expect(polls).toBeGreaterThanOrEqual(2));
		expect(screen.getByText("An agent is working on it…")).toBeTruthy();
		await fireEvent.press(screen.getByRole("button", { name: "Stop" }));
		await waitFor(() => expect(server.called("POST /api/features/analyses/doc-drift/jobs/job-d/cancel")).toHaveLength(1));
	});

	it("says an analysis is unknown, and shows a report that cannot be read", async () => {
		fakeServer({ "GET /api/features/analyses/flaky-tests/report": reply(500, { detail: "no clone" }) }, RUN);
		await openApp("/projects/p1/analyses/not-a-kind");
		expect(await screen.findByText("Unknown analysis.")).toBeTruthy();
		restoreFetch();
		fakeServer({ "GET /api/features/analyses/flaky-tests/report": reply(500, { detail: "no clone" }) }, RUN);
		await openApp("/projects/p1/analyses/flaky-tests");
		expect(await screen.findByText(/no clone/)).toBeTruthy();
	});
});

const relayed = (status: number, body: unknown) => reply(200, { status, body });

/** A GitHub reached through the server's relay: answers keyed by `METHOD endpoint`. */
function github(answers: Record<string, unknown>, permissions = VCS, routes: Record<string, unknown> = {}): FakeServer {
	const relay = (call: Call) => {
		const { method, endpoint, body } = call.body as { method: string; endpoint: string; body?: unknown };
		const answer = answers[`${method} ${endpoint}`];
		// The server relays the forge's status and body inside a 200.
		if (typeof answer === "function") return relayed(200, answer(body));
		return answer === undefined ? relayed(404, { message: "Not Found" }) : relayed(200, answer);
	};
	return fakeServer(
		{
			"GET /projects/p1": { id: "p1", name: "Shop", repo_url: "https://github.com/acme/shop", default_branch: "main", forge: "github" },
			"POST /api/features/forge/github/read": relay,
			"POST /api/features/forge/github/write": relay,
			"GET /api/features/forge/github/reviews": { reviews: {} },
			...routes,
		},
		permissions,
	);
}

const REPO = "/repos/acme/shop";

describe("forge", () => {
	const PULLS = {
		data: {
			repository: {
				pullRequests: {
					nodes: [
						{ number: 41, title: "Add search", state: "OPEN", author: { login: "bob" }, headRefName: "feat/search", baseRefName: "develop", updatedAt: "2026-11-13T09:00:00Z" },
					],
				},
			},
		},
	};

	it("lists the pull requests, then the issues without pull requests, and opens an issue", async () => {
		github(
			{
				[`GET ${REPO}/issues?state=open&per_page=50`]: [
					{ number: 7, title: "Crash on login", state: "open", user: { login: "carol" }, created_at: "2026-11-01T00:00:00Z" },
					{ number: 41, title: "Add search", pull_request: {} },
				],
				[`GET ${REPO}/issues/7`]: { number: 7, title: "Crash on login", body: "", state: "open", user: { login: "carol" } },
				[`GET ${REPO}/issues/7/comments?per_page=100`]: [],
			},
			VCS,
			{ "POST /api/features/forge/github/pulls": relayed(200, PULLS) },
		);
		const app = await openApp("/projects/p1/forge");
		expect(await screen.findByText("#41 Add search")).toBeTruthy();
		expect(screen.getByText(/bob · feat\/search → develop/)).toBeTruthy();
		await fireEvent.press(screen.getByRole("tab", { name: "Issues" }));
		expect(await screen.findByText("#7 Crash on login")).toBeTruthy();
		expect(screen.queryByText("#41 Add search")).toBeNull();
		await fireEvent.press(screen.getByRole("button", { name: /Crash on login/ }));
		await waitFor(() => expect(app.getPathname()).toBe("/projects/p1/forge/issues/7"));
		expect(await screen.findByText("No description.")).toBeTruthy();
	});

	it("says nothing is open, and that a project off any forge has no forge page", async () => {
		github({}, VCS, { "POST /api/features/forge/github/pulls": relayed(200, { data: {} }) });
		await openApp("/projects/p1/forge");
		expect(await screen.findByText("Nothing open.")).toBeTruthy();
		restoreFetch();

		fakeServer({ "GET /projects/p1": { id: "p1", name: "Shop", repo_url: "x", default_branch: "main", forge: null } }, VCS);
		await openApp("/projects/p1/forge");
		expect(await screen.findByText("This project's repository is not on a forge the server serves.")).toBeTruthy();
	});

	it("shows the forge's refusal of the list", async () => {
		github({}, VCS, { "POST /api/features/forge/github/pulls": relayed(401, {}) });
		await openApp("/projects/p1/forge");
		expect(await screen.findByText("Your session has ended. Sign in again.")).toBeTruthy();
	});

	it("reads an issue and comments on it with the person's token", async () => {
		let comments = [{ id: 1, user: { login: "carol" }, body: "Seen on iOS", created_at: "2026-11-02T00:00:00Z" }];
		const server = github({
			[`GET ${REPO}/issues/7`]: { number: 7, title: "Crash on login", body: "Steps: open the app", state: "open", user: { login: "carol" }, created_at: "2026-11-01T00:00:00Z" },
			[`GET ${REPO}/issues/7/comments?per_page=100`]: () => comments,
			[`POST ${REPO}/issues/7/comments`]: (body: { body: string }) => {
				comments = [...comments, { id: 2, user: { login: "ada" }, body: body.body, created_at: "2026-11-14T00:00:00Z" }];
				return {};
			},
		});
		await openApp("/projects/p1/forge/issues/7");
		expect(await screen.findByText("Steps: open the app")).toBeTruthy();
		expect(screen.getByText("Comments (1)")).toBeTruthy();
		await fireEvent.changeText(screen.getByLabelText("Your comment"), "  Fixed in #41  ");
		await fireEvent.press(screen.getByRole("button", { name: "Comment" }));
		expect(await screen.findByText("Fixed in #41")).toBeTruthy();
		const write = server.called("POST /api/features/forge/github/write")[0];
		expect(write.body).toEqual({ method: "POST", endpoint: `${REPO}/issues/7/comments`, body: { body: "Fixed in #41" } });
	});

	it("keeps the comment and says why GitHub refused it", async () => {
		github({
			[`GET ${REPO}/issues/7`]: { number: 7, title: "Crash on login", body: "Steps", state: "open", user: { login: "carol" } },
			[`GET ${REPO}/issues/7/comments?per_page=100`]: [],
		});
		await openApp("/projects/p1/forge/issues/7");
		await fireEvent.changeText(await screen.findByLabelText("Your comment"), "Fixed");
		await fireEvent.press(screen.getByRole("button", { name: "Comment" }));
		expect(await screen.findByText(/Not Found/)).toBeTruthy();
		expect(screen.getByLabelText("Your comment").props.value).toBe("Fixed");
	});

	it("shows why an issue cannot be read", async () => {
		github({});
		await openApp("/projects/p1/forge/issues/9");
		expect(await screen.findByText(/Not Found/)).toBeTruthy();
	});

	const PULL = {
		number: 41,
		title: "Add search",
		body: "Adds a search box",
		state: "open",
		user: { login: "bob" },
		head: { ref: "feat/search", sha: "abc1234" },
		base: { ref: "develop" },
		mergeable: true,
	};

	function pullServer(extra: Record<string, unknown> = {}, permissions = VCS, routes: Record<string, unknown> = {}) {
		return github(
			{
				[`GET ${REPO}/pulls/41`]: PULL,
				[`GET ${REPO}/pulls/41/files?per_page=100`]: [
					{ filename: "src/search.ts", additions: 30, deletions: 2, patch: "@@ -1 +1 @@\n-a\n+b" },
					{ filename: "README.md", additions: 1, deletions: 0 },
				],
				[`GET ${REPO}/issues/41/comments?per_page=100`]: [],
				[`GET ${REPO}/commits/abc1234/check-runs?per_page=100`]: {
					check_runs: [
						{ status: "completed", conclusion: "success" },
						{ status: "completed", conclusion: "failure" },
						{ status: "in_progress" },
					],
				},
				...extra,
			},
			permissions,
			routes,
		);
	}

	it("shows a pull request: state, branches, checks, description and changes", async () => {
		pullServer();
		await openApp("/projects/p1/forge/pulls/41");
		expect(await screen.findByText("Add search")).toBeTruthy();
		expect(screen.getByText("Open · bob · feat/search → develop")).toBeTruthy();
		expect(screen.getByText("Checks: 1 passed, 1 failed, 1 pending")).toBeTruthy();
		expect(screen.getByText("Adds a search box")).toBeTruthy();
		expect(screen.getByText("Not reviewed yet.")).toBeTruthy();
		expect(screen.getByText("src/search.ts")).toBeTruthy();
	});

	it("merges an open pull request after confirmation", async () => {
		let merged = false;
		const server = pullServer({
			[`GET ${REPO}/pulls/41`]: () => (merged ? { ...PULL, state: "closed", merged: true } : PULL),
			[`PUT ${REPO}/pulls/41/merge`]: () => {
				merged = true;
				return {};
			},
		});
		jest.spyOn(Alert, "alert").mockImplementation((title, _b, buttons) => {
			expect(title).toBe("Merge #41?");
			void buttons?.find((b) => b.text === "Merge")?.onPress?.();
		});
		await openApp("/projects/p1/forge/pulls/41");
		await fireEvent.press(await screen.findByRole("button", { name: "Merge" }));
		expect(await screen.findByText(/^Merged · bob/)).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Merge" })).toBeNull();
		expect(server.called("POST /api/features/forge/github/write").some((c) => (c.body as { method: string }).method === "PUT")).toBe(true);
		// A merged pull request takes no comment.
		expect(screen.queryByLabelText("Your comment")).toBeNull();
	});

	it("shows a refused merge, and offers no merge without the permissions or when GitHub says it conflicts", async () => {
		pullServer({ [`PUT ${REPO}/pulls/41/merge`]: undefined });
		jest.spyOn(Alert, "alert").mockImplementation((_t, _b, buttons) => {
			void buttons?.find((b) => b.text === "Merge")?.onPress?.();
		});
		await openApp("/projects/p1/forge/pulls/41");
		await fireEvent.press(await screen.findByRole("button", { name: "Merge" }));
		expect(await screen.findByText(/Not Found/)).toBeTruthy();
		restoreFetch();

		pullServer({ [`GET ${REPO}/pulls/41`]: { ...PULL, mergeable: false } });
		await openApp("/projects/p1/forge/pulls/41");
		expect(await screen.findByRole("button", { name: "Merge" })).toBeDisabled();
		restoreFetch();

		pullServer({}, READ);
		await openApp("/projects/p1/forge/pulls/41");
		expect(await screen.findByText("Add search")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Merge" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Run the AI review" })).toBeNull();
	});

	it("runs the AI review, follows its job and shows the saved review", async () => {
		jest.useFakeTimers();
		let review: string | null = null;
		const server = pullServer({}, VCS, {
			"GET /api/features/forge/github/reviews": () => ({ reviews: { "41": review } }),
			"POST /api/features/forge/github/reviews/jobs": { id: "rev-1", status: "queued" },
			"GET /api/features/forge/github/reviews/jobs/rev-1": () =>
				review ? { id: "rev-1", status: "succeeded", lines: [], next: 0 } : { id: "rev-1", status: "running", lines: [], next: 0 },
		});
		await openApp("/projects/p1/forge/pulls/41");
		await fireEvent.press(await screen.findByRole("button", { name: "Run the AI review" }));
		expect(await screen.findByText("An agent is working on it…")).toBeTruthy();
		expect(server.called("POST /api/features/forge/github/reviews/jobs")[0].body).toEqual({ number: 41, followup: false });

		review = JSON.stringify({
			verdict: "needs_revision",
			summary: "Two issues",
			findings: [
				{ id: "f1", severity: "high", title: "SQL injection", description: "Use parameters", file: "src/search.ts", line: 12 },
				{ severity: "low", title: "Typo", description: "searh", file: "README.md" },
				{ severity: "medium", title: "" },
			],
		});
		await act(async () => {
			jest.advanceTimersByTime(3_000);
		});
		expect(await screen.findByText("Needs revision")).toBeTruthy();
		expect(screen.getByText("HIGH · src/search.ts:12")).toBeTruthy();
		expect(screen.getByText("LOW · README.md")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Review what changed since" })).toBeTruthy();
	});

	it("says why the review run failed or was refused", async () => {
		jest.useFakeTimers();
		pullServer({}, VCS, {
			"POST /api/features/forge/github/reviews/jobs": { id: "rev-2", status: "queued" },
			"GET /api/features/forge/github/reviews/jobs/rev-2": { id: "rev-2", status: "failed", error: "no token", lines: [], next: 0 },
		});
		await openApp("/projects/p1/forge/pulls/41");
		await fireEvent.press(await screen.findByRole("button", { name: "Run the AI review" }));
		await act(async () => {
			jest.advanceTimersByTime(3_000);
		});
		expect(await screen.findByText("The last run failed. no token")).toBeTruthy();
		restoreFetch();
		jest.useRealTimers();

		pullServer({}, VCS, { "POST /api/features/forge/github/reviews/jobs": reply(403, {}) });
		await openApp("/projects/p1/forge/pulls/41");
		await fireEvent.press(await screen.findByRole("button", { name: "Run the AI review" }));
		expect(await screen.findByText("You don't have the rights for this action.")).toBeTruthy();
	});

	it("shows why a pull request cannot be read, and a check list that cannot", async () => {
		github({});
		await openApp("/projects/p1/forge/pulls/41");
		expect(await screen.findByText(/Not Found/)).toBeTruthy();
		restoreFetch();

		pullServer({ [`GET ${REPO}/commits/abc1234/check-runs?per_page=100`]: undefined });
		await openApp("/projects/p1/forge/pulls/41");
		expect(await screen.findByText("Add search")).toBeTruthy();
		expect(screen.queryByText(/^Checks:/)).toBeNull();
	});
});
