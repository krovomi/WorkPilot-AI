import { act, fireEvent, screen, waitFor } from "expo-router/testing-library";
import { Alert } from "react-native";
import type { InsightSession } from "../../features/types";
import { type Call, fakeServer, openApp, reply, restoreFetch } from "../../../test-support/fake-server";

const READ = ["board.read", "insight.read", "analytics.read"];
const WRITE = [...READ, "insight.write", "agent.execute", "agent.cancel"];

afterEach(() => {
	restoreFetch();
	jest.useRealTimers();
	jest.restoreAllMocks();
});

describe("context", () => {
	const INDEX = {
		project_type: "monorepo",
		services: {
			api: { name: "api", path: "apps/api", language: "C#", framework: "ASP.NET Core", type: "unknown", default_port: 5000 },
			web: { path: "apps/web", language: "TypeScript" },
			broken: "not an object",
		},
		infrastructure: { docker_compose: "compose.yml", ci: true, dockerfile: false, unknown_key: "x" },
		conventions: { js_linting: ["biome", "eslint"], my_rule: "kept out" },
	};

	it("shows the project's index: type, services, infrastructure and conventions", async () => {
		fakeServer(
			{
				"GET /api/features/context/snapshot": {
					files: { "project_index.json": { content: JSON.stringify(INDEX), sha256: "x" } },
					job: null,
				},
			},
			WRITE,
		);
		await openApp("/projects/p1/context");
		expect(await screen.findByText("Project: monorepo")).toBeTruthy();
		expect(screen.getByText("2 services")).toBeTruthy();
		expect(screen.getByText("apps/api")).toBeTruthy();
		// "unknown" labels are left out; the port is shown.
		expect(screen.getByText("C# · ASP.NET Core · port 5000")).toBeTruthy();
		expect(screen.getByText("TypeScript")).toBeTruthy();
		expect(screen.getByText("Docker Compose")).toBeTruthy();
		expect(screen.getByText("compose.yml")).toBeTruthy();
		expect(screen.getByText("CI")).toBeTruthy();
		expect(screen.queryByText("Dockerfile")).toBeNull();
		expect(screen.getByText("biome, eslint")).toBeTruthy();
		expect(screen.queryByText("kept out")).toBeNull();
	});

	it("offers to generate the index when there is none", async () => {
		const server = fakeServer(
			{
				"GET /api/features/context/snapshot": { files: {}, job: null },
				"POST /api/features/context/jobs": { id: "j", feature: "context", status: "queued" },
			},
			WRITE,
		);
		await openApp("/projects/p1/context");
		expect(await screen.findByText(/hasn't been indexed yet/)).toBeTruthy();
		await fireEvent.press(screen.getByRole("button", { name: "Generate" }));
		await waitFor(() => expect(server.called("POST /api/features/context/jobs")).toHaveLength(1));
	});

	it("lists the memories, then searches them once the person pauses typing", async () => {
		jest.useFakeTimers();
		const server = fakeServer(
			{
				"GET /api/features/context/snapshot": { files: {}, job: null },
				"GET /api/features/context/memories": (call: Call) =>
					call.query.get("query")
						? { available: true, results: [] }
						: {
								available: true,
								memories: [
									{ id: "m1", type: "gotcha", timestamp: "2026-11-10T08:00:00Z", content: "Run migrations before tests" },
									{ id: "m2", type: "custom_kind", content: "Other" },
								],
							},
			},
			WRITE,
		);
		await openApp("/projects/p1/context");
		await fireEvent.press(await screen.findByRole("tab", { name: "Memories" }));
		expect(await screen.findByText("Run migrations before tests")).toBeTruthy();
		expect(screen.getByText(/^Gotcha · /)).toBeTruthy();
		expect(screen.getByText("custom_kind")).toBeTruthy();

		await fireEvent.changeText(screen.getByLabelText("Search the memories"), " cache ");
		await act(async () => {
			jest.advanceTimersByTime(400);
		});
		expect(await screen.findByText("No memory matches this search.")).toBeTruthy();
		const searched = server.called("GET /api/features/context/memories").at(-1);
		expect(searched?.query.get("query")).toBe("cache");
	});

	it("says when the project has no brain, or no memory yet", async () => {
		const server = fakeServer(
			{
				"GET /api/features/context/snapshot": { files: {}, job: null },
				"GET /api/features/context/memories": { available: false },
			},
			WRITE,
		);
		await openApp("/projects/p1/context");
		await fireEvent.press(await screen.findByRole("tab", { name: "Memories" }));
		expect(await screen.findByText(/No memories yet: the project's first build/)).toBeTruthy();
		server.routes["GET /api/features/context/memories"] = { available: true, memories: [] };
		await fireEvent.press(screen.getByRole("tab", { name: "Index" }));
		await fireEvent.press(screen.getByRole("tab", { name: "Memories" }));
		expect(await screen.findByText("No memories yet.")).toBeTruthy();
	});
});

describe("insights", () => {
	const SUMMARY = {
		id: "s1",
		title: "Where is auth handled?",
		messageCount: 2,
		createdAt: null,
		updatedAt: "2026-11-13T10:00:00Z",
		ownerId: "u1",
		ownerName: "Ada",
		mine: true,
	};
	const session = (extra: Partial<InsightSession> = {}): InsightSession => ({
		...SUMMARY,
		messages: [
			{ id: "q", role: "user", content: "Where is auth handled?" },
			{ id: "a", role: "assistant", content: "In AuthService.", suggestedTask: { title: "Add MFA" } },
		],
		jobId: null,
		...extra,
	});

	it("lists the conversations with who started them, and starts a new one", async () => {
		const server = fakeServer(
			{
				"GET /api/features/insights/sessions": [SUMMARY, { ...SUMMARY, id: "s2", title: "Bob's", mine: false, ownerName: "Bob" }],
				"POST /api/features/insights/sessions": session({ id: "s3", title: "New", messages: [] }),
				"GET /api/features/insights/sessions/s3": session({ id: "s3", title: "New", messages: [] }),
			},
			WRITE,
		);
		const app = await openApp("/projects/p1/insights");
		expect(await screen.findByText("Where is auth handled?")).toBeTruthy();
		expect(screen.getByText(/^You · 2 messages · /)).toBeTruthy();
		expect(screen.getByText(/^Bob · 2 messages · /)).toBeTruthy();
		await fireEvent.press(screen.getByRole("button", { name: "New conversation" }));
		await waitFor(() => expect(app.getPathname()).toBe("/projects/p1/insights/s3"));
		expect(server.called("POST /api/features/insights/sessions")).toHaveLength(1);
		expect(await screen.findByText("Ask your first question below.")).toBeTruthy();
	});

	it("is read only without insight.write, says there is none, and shows a refused creation", async () => {
		fakeServer({ "GET /api/features/insights/sessions": [] }, READ);
		await openApp("/projects/p1/insights");
		expect(await screen.findByText("No conversation yet.")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "New conversation" })).toBeNull();
		restoreFetch();

		fakeServer(
			{ "GET /api/features/insights/sessions": [], "POST /api/features/insights/sessions": reply(429, {}) },
			WRITE,
		);
		await openApp("/projects/p1/insights");
		await fireEvent.press(await screen.findByRole("button", { name: "New conversation" }));
		expect(await screen.findByText("Too many attempts. Wait a minute, then try again.")).toBeTruthy();
	});

	it("asks a question and reads the conversation until the answer lands", async () => {
		jest.useFakeTimers();
		let current = session();
		const server = fakeServer(
			{
				"GET /api/features/insights/sessions/s1": () => current,
				"POST /api/features/insights/sessions/s1/messages": (call: Call) => {
					current = {
						...current,
						jobId: "job-9",
						messages: [...current.messages, { id: "q2", role: "user", content: (call.body as { message: string }).message }],
					};
					return { job: { id: "job-9" }, session: current };
				},
			},
			WRITE,
		);
		await openApp("/projects/p1/insights/s1");
		expect(await screen.findByText("In AuthService.")).toBeTruthy();
		expect(screen.getByText("Suggested task: Add MFA")).toBeTruthy();
		const send = screen.getByRole("button", { name: "Send" });
		expect(send).toBeDisabled();
		await fireEvent.changeText(screen.getByLabelText("Your question"), "  And the tokens?  ");
		await fireEvent.press(screen.getByRole("button", { name: "Send" }));
		expect(await screen.findByText("The agent is writing its answer…")).toBeTruthy();
		expect(server.called("POST /api/features/insights/sessions/s1/messages")[0].body).toEqual({ message: "And the tokens?" });
		expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();

		current = {
			...current,
			jobId: null,
			messages: [...current.messages, { id: "a2", role: "assistant", content: "Refresh tokens rotate." }],
		};
		await act(async () => {
			jest.advanceTimersByTime(3_000);
		});
		expect(await screen.findByText("Refresh tokens rotate.")).toBeTruthy();
		expect(screen.queryByText("The agent is writing its answer…")).toBeNull();
	});

	it("shows a refused question, and deletes the conversation", async () => {
		const server = fakeServer(
			{
				"GET /api/features/insights/sessions": [SUMMARY],
				"GET /api/features/insights/sessions/s1": session(),
				"POST /api/features/insights/sessions/s1/messages": reply(409, { detail: "an answer is being written" }),
				"DELETE /api/features/insights/sessions/s1": { deleted: true },
			},
			WRITE,
		);
		jest.spyOn(Alert, "alert").mockImplementation((_t, _b, buttons) => {
			void buttons?.find((b) => b.style === "destructive")?.onPress?.();
		});
		const app = await openApp("/projects/p1/insights");
		await fireEvent.press(await screen.findByRole("button", { name: /Where is auth handled/ }));
		await fireEvent.changeText(await screen.findByLabelText("Your question"), "Again?");
		await fireEvent.press(screen.getByRole("button", { name: "Send" }));
		expect(await screen.findByText(/an answer is being written/)).toBeTruthy();
		await fireEvent.press(screen.getByRole("button", { name: "Delete the conversation" }));
		await waitFor(() => expect(app.getPathname()).toBe("/projects/p1/insights"));
		expect(server.called("DELETE /api/features/insights/sessions/s1")).toHaveLength(1);
	});

	it("keeps a conversation whose deletion fails, and lets others only read it", async () => {
		fakeServer(
			{
				"GET /api/features/insights/sessions/s1": session(),
				"DELETE /api/features/insights/sessions/s1": reply(403, {}),
			},
			WRITE,
		);
		jest.spyOn(Alert, "alert").mockImplementation((_t, _b, buttons) => {
			void buttons?.find((b) => b.style === "destructive")?.onPress?.();
		});
		await openApp("/projects/p1/insights/s1");
		await fireEvent.press(await screen.findByRole("button", { name: "Delete the conversation" }));
		expect(await screen.findByText("You don't have the rights for this action.")).toBeTruthy();
		restoreFetch();

		fakeServer({ "GET /api/features/insights/sessions/s1": session({ mine: false }) }, WRITE);
		await openApp("/projects/p1/insights/s1");
		expect(await screen.findByText("In AuthService.")).toBeTruthy();
		expect(screen.queryByLabelText("Your question")).toBeNull();
		expect(screen.queryByRole("button", { name: "Delete the conversation" })).toBeNull();
	});

	it("shows why a conversation cannot be read", async () => {
		fakeServer({ "GET /api/features/insights/sessions/s1": reply(500, { detail: "lost" }) }, WRITE);
		await openApp("/projects/p1/insights/s1");
		expect(await screen.findByText(/lost/)).toBeTruthy();
	});
});

describe("dashboard and sessions", () => {
	const SNAPSHOT = {
		tasks_by_status: { completed: 12, in_progress: 3, custom: 1 },
		qa_first_pass_rate: 66.6,
		qa_avg_score: 8.25,
		total_tokens: 1234567,
		tokens_by_provider: {},
		total_cost: 42.5,
		cost_by_model: {},
		merge_auto_count: 4,
		merge_manual_count: 2,
	};
	const COSTS = {
		total_cost: 12.3,
		cost_by_provider: {},
		cost_by_model: { "claude-sonnet": 10, "gpt-x": 2.3 },
		total_tokens: 50000,
		tokens_input: 40000,
		tokens_output: 10000,
		period_days: 30,
		daily_avg: 0.41,
		trend_pct: 12.4,
	};

	it("shows the cards by status, quality, spending and its trend, and opens the sessions", async () => {
		fakeServer(
			{
				"GET /api/features/workspace/dashboard": { snapshot: SNAPSHOT },
				"GET /api/features/workspace/costs": { summary: COSTS },
				"GET /api/features/workspace/sessions": {
					sessions: [
						{
							id: "r1",
							kind: "run",
							spec: "007-search",
							phase: "build",
							status: "failed",
							model: null,
							started_by: "Ada",
							started_at: "2026-11-14T09:00:00Z",
							finished_at: null,
							duration_seconds: 125,
							tokens: 10,
							cost: 0.5,
							error: "Tests red",
						},
						{
							id: "j1",
							kind: "job",
							spec: null,
							phase: "roadmap",
							status: "odd_status",
							model: null,
							started_by: null,
							started_at: null,
							finished_at: null,
							duration_seconds: null,
							tokens: null,
							cost: null,
							error: null,
						},
					],
				},
			},
			READ,
		);
		const app = await openApp("/projects/p1/dashboard");
		expect(await screen.findByText("Spending, last 30 days")).toBeTruthy();
		expect(screen.getByText("67 %")).toBeTruthy();
		expect(screen.getByText("8.3")).toBeTruthy();
		expect(screen.getByText("+12 %")).toBeTruthy();
		expect(screen.getByText("claude-sonnet")).toBeTruthy();
		expect(screen.getByText("Done")).toBeTruthy();

		await fireEvent.press(screen.getByRole("button", { name: "Sessions" }));
		await waitFor(() => expect(app.getPathname()).toBe("/projects/p1/sessions"));
		expect(await screen.findByText("Tests red")).toBeTruthy();
		expect(screen.getByText("Failed")).toBeTruthy();
		expect(screen.getByText("odd_status")).toBeTruthy();
		expect(screen.getByText(/^007 · /)).toBeTruthy();
	});

	it("says there is no card or session, shows a falling trend, and opens the analyses", async () => {
		fakeServer(
			{
				"GET /api/features/workspace/dashboard": { snapshot: { ...SNAPSHOT, tasks_by_status: {} } },
				"GET /api/features/workspace/costs": { summary: { ...COSTS, trend_pct: -5, cost_by_model: {} } },
				"GET /api/features/analyses/accessibility/report": { report: null },
			},
			READ,
		);
		const app = await openApp("/projects/p1/dashboard");
		expect(await screen.findByText("No card yet.")).toBeTruthy();
		expect(screen.getByText("-5 %")).toBeTruthy();
		await fireEvent.press(screen.getByRole("button", { name: "Analyses" }));
		await waitFor(() => expect(app.getPathname()).toBe("/projects/p1/analyses"));
	});

	it("shows no trend without a previous period, and a failed read", async () => {
		fakeServer(
			{
				"GET /api/features/workspace/dashboard": { snapshot: SNAPSHOT },
				"GET /api/features/workspace/costs": { summary: { ...COSTS, trend_pct: null } },
			},
			READ,
		);
		await openApp("/projects/p1/dashboard");
		await screen.findByText("Spending, last 30 days");
		expect(screen.queryByText("Against the period before")).toBeNull();
		restoreFetch();

		fakeServer({ "GET /api/features/workspace/dashboard": reply(500, { detail: "metrics off" }) }, READ);
		await openApp("/projects/p1/dashboard");
		expect(await screen.findByText(/metrics off/)).toBeTruthy();
	});

	it("says there is no session yet", async () => {
		fakeServer({ "GET /api/features/workspace/sessions": { sessions: [] } }, READ);
		await openApp("/projects/p1/sessions");
		expect(await screen.findByText("No session yet.")).toBeTruthy();
	});
});
