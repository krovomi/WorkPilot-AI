import { fireEvent, screen, waitFor, within } from "expo-router/testing-library";
import { Alert, AppState } from "react-native";
import { confirmAlerts } from "../../../test-support/admin-fixtures";
import { fakeServer, openApp, reply, restoreFetch } from "../../../test-support/fake-server";

/**
 * The governance of a server project on the phone (#353): read from the
 * server by project id, the calls its agents wait on answered there, its kill
 * switch; each button only where the server's `may` allows it.
 */

const ALL = ["board.read", "audit.read", "review.approve", "agent.cancel"];
const ROUTE = "GET /api/features/governance";

const REPORT = {
	governance: {
		source: "workpilot.policy.yaml",
		schedule: { timezone: "Europe/Paris", allowedHours: ["08:00-19:00"], days: ["mon", "tue"], openNow: true },
		files: { forbidden: ["secrets/**"], requiresReview: ["infra/**"], reviewers: ["security"] },
		budget: { maxTokensPerHour: 200000, maxTokensPerTask: 50000 },
		loopDetection: { maxSameToolCall: 5 },
	},
	errors: [],
	tokensLastHour: 1200,
	metrics: { blocked24h: 1, breakerTrips7d: 0 },
	events: [
		{
			id: "e1",
			at: "2026-11-20T10:00:00Z",
			task: "001-a",
			tool: "Write",
			target: "infra/main.tf",
			decision: "approved",
			rules: ["files.requires_review:infra/**"],
			approvedBy: "Ada <u-1> [security]",
		},
		{ decision: "deny", target: "rm -rf /" },
		{ id: "e3", decision: "something new" },
	],
	pending: [
		{
			id: "0123456789ab",
			at: "2026-11-20T10:05:00Z",
			rules: ["files.requires_review:infra/**"],
			tool: "Write",
			target: { kind: "file", summary: "infra/net.tf" },
			task: "002-b",
		},
	],
	agents: { mine: 1, project: 3 },
	may: { approve: true, stop: true, stopProject: true, export: true },
};

afterEach(() => {
	restoreFetch();
	jest.restoreAllMocks();
});

describe("governance", () => {
	it("is linked from the board for someone who may read the audit trail", async () => {
		// The app is in the foreground, as on a phone that just opened it.
		Object.defineProperty(AppState, "currentState", { value: "active", configurable: true });
		fakeServer(
			{ "GET /api/board/cards": { cards: [] }, "GET /projects/p1": { id: "p1", name: "Shop", forge: null }, [ROUTE]: REPORT },
			ALL,
		);
		const app = await openApp("/projects/p1");
		expect(await screen.findAllByText("No card here.")).toBeTruthy();
		await fireEvent.press(screen.getByText("Governance"));
		await waitFor(() => expect(app.getPathname()).toBe("/projects/p1/governance"));
	});

	it("shows the policy, who approves, the waiting calls, the agents and the decisions", async () => {
		const server = fakeServer({ [ROUTE]: REPORT }, ALL);
		await openApp("/projects/p1/governance");
		expect(await screen.findByText("Open now")).toBeTruthy();
		expect(server.called(ROUTE)[0].query.get("project_id")).toBe("p1");
		expect(screen.getByText("08:00-19:00 (Europe/Paris), mon, tue")).toBeTruthy();
		expect(screen.getByText("secrets/**")).toBeTruthy();
		expect(screen.getByTestId("governance-approver").props.children).toMatch(/roles: security\./);
		expect(screen.getByText("1,200 of 200,000 tokens in the last hour")).toBeTruthy();
		expect(screen.getByText("At most 50,000 tokens per task")).toBeTruthy();
		expect(screen.getByText("Pauses an agent after 5 identical tool calls")).toBeTruthy();
		expect(screen.getByText("Running on the server: 1 yours, 3 in all")).toBeTruthy();
		expect(screen.getByText("1 call waiting for an approval")).toBeTruthy();
		const request = screen.getByTestId("governance-request");
		expect(within(request).getByText("Write · infra/net.tf")).toBeTruthy();
		expect(within(request).getByText(/^002-b · /)).toBeTruthy();
		expect(screen.getByText("approved by Ada <u-1> [security]")).toBeTruthy();
		expect(screen.getByText("Write · infra/main.tf")).toBeTruthy();
		expect(screen.getByText("Refused")).toBeTruthy();
		expect(screen.getByText("rm -rf /")).toBeTruthy();
		// A decision the app has no word for is left out.
		expect(screen.queryByText(/something new/)).toBeNull();
		expect(screen.getByText("1 agent action stopped in the last 24 h")).toBeTruthy();
		expect(screen.getByText("0 circuit-breaker trips in the last 7 days")).toBeTruthy();
	});

	it("approves in the person's name, then reads again", async () => {
		const server = fakeServer(
			{ [ROUTE]: REPORT, "POST /api/features/governance/approvals/0123456789ab": { answer: { decision: "approved" } } },
			ALL,
		);
		await openApp("/projects/p1/governance");
		await fireEvent.press(await screen.findByRole("button", { name: "Approve" }));
		expect(await screen.findByText(/^Approved in your name/)).toBeTruthy();
		const [call] = server.called("POST /api/features/governance/approvals/0123456789ab");
		expect(call.body).toEqual({ approved: true });
		expect(call.query.get("project_id")).toBe("p1");
		await waitFor(() => expect(server.called(ROUTE)).toHaveLength(2));
	});

	it("names the roles the policy asks for when the server refuses an approval", async () => {
		const answers = [reply(403, { detail: "asks one of these roles" }), { answer: { decision: "refused" } }];
		const server = fakeServer(
			{ [ROUTE]: REPORT, "POST /api/features/governance/approvals/0123456789ab": () => answers.shift() },
			ALL,
		);
		await openApp("/projects/p1/governance");
		await fireEvent.press(await screen.findByRole("button", { name: "Approve" }));
		expect(await screen.findByText("The policy asks one of these roles to approve: security.")).toBeTruthy();
		await fireEvent.press(screen.getByRole("button", { name: "Refuse" }));
		expect(await screen.findByText("Refused: the agent keeps being denied this call.")).toBeTruthy();
		expect(server.called("POST /api/features/governance/approvals/0123456789ab")[1].body).toEqual({ approved: false });
	});

	it("says a refusal in the person's words when the policy names no role", async () => {
		const report = { ...REPORT, governance: { ...REPORT.governance, files: { forbidden: [], requiresReview: ["infra/**"] } } };
		fakeServer(
			{ [ROUTE]: report, "POST /api/features/governance/approvals/0123456789ab": reply(403, { detail: "no" }) },
			ALL,
		);
		await openApp("/projects/p1/governance");
		expect(await screen.findByText(/^Approved by any member of the project/)).toBeTruthy();
		expect(screen.getAllByText("None").length).toBe(1);
		await fireEvent.press(screen.getByRole("button", { name: "Approve" }));
		expect(await screen.findByText("You don't have the rights for this action.")).toBeTruthy();
	});

	it("stops the person's agents, and everyone's only after a confirmation", async () => {
		const server = fakeServer(
			{ [ROUTE]: REPORT, "POST /api/features/governance/stop": { stoppedRuns: 2, stoppedJobs: 1 } },
			ALL,
		);
		await openApp("/projects/p1/governance");
		await fireEvent.press(await screen.findByRole("button", { name: "Stop my agents" }));
		expect(await screen.findByText("3 agents stopped. Their cards can be started again.")).toBeTruthy();
		expect(server.called("POST /api/features/governance/stop")[0].body).toEqual({ scope: "mine" });

		const cancelled = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
		await fireEvent.press(screen.getByRole("button", { name: "Stop every agent of the project" }));
		expect(cancelled).toHaveBeenCalledWith("Stop every agent of the project?", expect.any(String), expect.any(Array));
		expect(server.called("POST /api/features/governance/stop")).toHaveLength(1);
		cancelled.mockRestore();

		confirmAlerts();
		await fireEvent.press(screen.getByRole("button", { name: "Stop every agent of the project" }));
		await waitFor(() => expect(server.called("POST /api/features/governance/stop")).toHaveLength(2));
		expect(server.called("POST /api/features/governance/stop")[1].body).toEqual({ scope: "project" });
	});

	it("says when stopping failed", async () => {
		fakeServer({ [ROUTE]: REPORT, "POST /api/features/governance/stop": reply(500, { detail: "Boom" }) }, ALL);
		await openApp("/projects/p1/governance");
		await fireEvent.press(await screen.findByRole("button", { name: "Stop my agents" }));
		expect(await screen.findByText("Something went wrong: Boom")).toBeTruthy();
	});

	it("offers no action the server does not allow, and says what the policy leaves out", async () => {
		fakeServer(
			{
				[ROUTE]: {
					...REPORT,
					governance: {
						schedule: { timezone: "UTC", allowedHours: ["09:00-17:00"], days: ["mon"], openNow: false },
						files: { forbidden: [], requiresReview: [] },
						budget: null,
					},
					tokensLastHour: undefined,
					pending: [{ id: "0123456789ab", target: { summary: "rm x" } }],
					events: [],
					metrics: undefined,
					may: { approve: false, stop: false, stopProject: false, export: false },
				},
			},
			["board.read", "audit.read"],
		);
		await openApp("/projects/p1/governance");
		expect(await screen.findByText("Closed now")).toBeTruthy();
		expect(screen.getAllByText("None")).toHaveLength(2);
		expect(screen.queryByTestId("governance-approver")).toBeNull();
		expect(screen.getByText("No token limit")).toBeTruthy();
		expect(screen.getByText("rm x")).toBeTruthy();
		expect(screen.getByText("No decision yet.")).toBeTruthy();
		expect(screen.getByText("0 agent actions stopped in the last 24 h")).toBeTruthy();
		for (const name of ["Approve", "Refuse", "Stop my agents", "Stop every agent of the project"]) {
			expect(screen.queryByRole("button", { name })).toBeNull();
		}
	});

	it("says when the project has no policy, or a refused one, and nothing waits", async () => {
		const base = { ...REPORT, pending: undefined, events: undefined };
		fakeServer({ [ROUTE]: { ...base, governance: null, errors: undefined } }, ALL);
		await openApp("/projects/p1/governance");
		expect(await screen.findByText("workpilot.policy.yaml sets no hours, files or token budget.")).toBeTruthy();
		expect(screen.getByText("No call is waiting for an approval.")).toBeTruthy();
		expect(screen.getByText("0 calls waiting for an approval")).toBeTruthy();
		restoreFetch();

		fakeServer({ [ROUTE]: { ...base, governance: null, errors: ["schedule.timezone: unknown zone"] } }, ALL);
		await openApp("/projects/p1/governance");
		expect(await screen.findByText("schedule.timezone: unknown zone")).toBeTruthy();
		expect(screen.getByText(/^workpilot.policy.yaml is refused/)).toBeTruthy();
		expect(screen.queryByText("workpilot.policy.yaml sets no hours, files or token budget.")).toBeNull();
	});

	it("says when the server cannot be read", async () => {
		fakeServer({ [ROUTE]: reply(403, { detail: "Missing permission: audit.read" }) }, ALL);
		await openApp("/projects/p1/governance");
		expect(await screen.findByText("You don't have the rights for this action.")).toBeTruthy();
		expect(screen.queryByText("Policy")).toBeNull();
	});
});
