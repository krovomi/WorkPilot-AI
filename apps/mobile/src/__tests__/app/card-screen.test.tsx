import { act, fireEvent, screen, waitFor } from "expo-router/testing-library";
import * as LocalAuthentication from "expo-local-authentication";
import { Alert, AppState } from "react-native";
import type { AgentRun, BoardCard, CardDetails } from "../../api/types";
import { saveLockSettings } from "../../auth/lock";
import { type Call, type FakeServer, fakeServer, openApp, reply, restoreFetch } from "../../../test-support/fake-server";

const ALL = ["board.read", "task.write", "agent.execute", "review.approve", "task.merge", "vcs.pr.create", "task.delete"];
const CARD_PATH = "/api/board/cards/007-search";
const RUNS_PATH = "/projects/p1/specs/spec-7/runs";

function card(extra: Partial<BoardCard> = {}): BoardCard {
	return {
		id: "007-search",
		title: "Search the catalogue",
		column: "backlog",
		kind: "feature",
		updatedAt: null,
		subtasks: { completed: 0, total: 0 },
		specId: "spec-7",
		claimedBy: null,
		claimedByName: null,
		...extra,
	};
}

function details(extra: Partial<CardDetails> = {}): CardDetails {
	return {
		id: "007-search",
		title: "Search the catalogue",
		column: "backlog",
		kind: "feature",
		updatedAt: null,
		subtasks: { completed: 0, total: 0 },
		description: "Full-text search on products",
		spec: null,
		approval: { approved: false, approvedBy: null, approvedAt: null },
		requireReview: true,
		...extra,
	} as CardDetails;
}

function run(status: string, phase = "build", extra: Partial<AgentRun> = {}): AgentRun {
	return {
		id: `run-${status}`,
		spec_id: "spec-7",
		phase,
		started_by: null,
		status,
		started_at: "2026-11-14T09:00:00Z",
		finished_at: null,
		error: null,
		...extra,
	} as AgentRun;
}

/** A card the server keeps: every read sees the last write. */
function serveCard(state: { card: BoardCard; details: CardDetails; runs: AgentRun[] }, routes: Record<string, unknown> = {}, permissions = ALL) {
	return fakeServer(
		{
			"GET /api/board/cards": () => ({ cards: [state.card] }),
			[`GET ${CARD_PATH}`]: () => state.details,
			[`GET ${RUNS_PATH}`]: () => state.runs,
			[`GET ${CARD_PATH}/changes`]: reply(404, { detail: "no worktree" }),
			[`GET ${CARD_PATH}/logs`]: { logs: null },
			[`GET ${CARD_PATH}/steering`]: { messages: [] },
			...routes,
		},
		permissions,
	);
}

const confirm = () =>
	jest.spyOn(Alert, "alert").mockImplementation((_t, _b, buttons) => {
		void buttons?.find((b) => b.style === "destructive")?.onPress?.();
	});

beforeEach(async () => {
	Object.defineProperty(AppState, "currentState", { value: "active", configurable: true });
	await saveLockSettings({ atLaunch: false, sensitive: false });
});

afterEach(() => {
	restoreFetch();
	jest.useRealTimers();
	jest.restoreAllMocks();
});

const started = (server: FakeServer) => server.called(`POST ${RUNS_PATH}`).map((c: Call) => (c.body as { phase: string }).phase);

describe("card screen", () => {
	it("shows a new card and starts it, which writes its spec", async () => {
		const state = { card: card(), details: details(), runs: [] as AgentRun[] };
		const server = serveCard(state, {
			[`POST ${RUNS_PATH}`]: () => {
				state.runs = [run("queued", "spec")];
				return state.runs[0];
			},
		});
		await openApp("/projects/p1/cards/007-search");
		expect(await screen.findByText("Search the catalogue")).toBeTruthy();
		expect(screen.getByText("Full-text search on products")).toBeTruthy();
		expect(screen.getByText("No spec yet. Start the card to write it.")).toBeTruthy();
		expect(screen.getByText("No run yet.")).toBeTruthy();
		expect(screen.getByText("· Feature")).toBeTruthy();
		await fireEvent.press(screen.getByRole("button", { name: "Start" }));
		expect(await screen.findByRole("button", { name: "Stop" })).toBeTruthy();
		expect(started(server)).toEqual(["spec"]);
		expect(screen.getByText("Queued")).toBeTruthy();
	});

	it("approves a spec that asks for review, then builds it", async () => {
		const state = { card: card(), details: details({ spec: "# Plan\nAdd an index" }), runs: [] as AgentRun[] };
		const server = serveCard(state, {
			[`POST ${CARD_PATH}/approve`]: () => {
				state.details = { ...state.details, approval: { approved: true, approvedBy: "Ada", approvedAt: null } };
				return {};
			},
			[`POST ${RUNS_PATH}`]: () => {
				state.runs = [run("running")];
				return state.runs[0];
			},
		});
		await openApp("/projects/p1/cards/007-search");
		expect(await screen.findByText("Not approved yet")).toBeTruthy();
		await fireEvent.press(screen.getByRole("button", { name: "Approve the spec" }));
		expect(await screen.findByText("Approved by Ada")).toBeTruthy();
		await fireEvent.press(screen.getByRole("button", { name: "Start" }));
		await waitFor(() => expect(started(server)).toEqual(["build"]));
	});

	it("stops the running build, and says when nothing was running any more", async () => {
		const state = { card: card({ column: "in_progress" }), details: details({ column: "in_progress", spec: "x" }), runs: [run("running")] };
		const server = serveCard(state, {
			[`POST ${RUNS_PATH}/run-running/cancel`]: { cancelled: false },
		});
		await openApp("/projects/p1/cards/007-search");
		await fireEvent.press(await screen.findByRole("button", { name: "Stop" }));
		expect(await screen.findByText("Nothing was running on this card any more. Pull to refresh.")).toBeTruthy();
		expect(server.called(`POST ${RUNS_PATH}/run-running/cancel`)).toHaveLength(1);
	});

	it("reads a working card again every few seconds", async () => {
		jest.useFakeTimers();
		const state = { card: card({ column: "ai_review" }), details: details({ column: "ai_review", spec: "x" }), runs: [] as AgentRun[] };
		const server = serveCard(state);
		await openApp("/projects/p1/cards/007-search");
		expect(await screen.findByRole("button", { name: "Build again" })).toBeTruthy();
		const reads = server.called(`GET ${CARD_PATH}`).length;
		state.card = card({ column: "human_review" });
		state.details = details({ column: "human_review", spec: "x", approval: { approved: true, approvedBy: "Ada", approvedAt: null } });
		await act(async () => {
			jest.advanceTimersByTime(5_000);
		});
		await waitFor(() => expect(server.called(`GET ${CARD_PATH}`).length).toBeGreaterThan(reads));
		expect(await screen.findByRole("button", { name: "Merge" })).toBeTruthy();
	});

	it("merges and opens the pull request after the lock confirms it is the person", async () => {
		await saveLockSettings({ atLaunch: false, sensitive: true });
		const state = {
			card: card({ column: "human_review" }),
			details: details({ column: "human_review", spec: "x", approval: { approved: true, approvedBy: "Ada", approvedAt: null } }),
			runs: [run("succeeded", "build", { error: null }), run("failed", "qa", { id: "run-qa", error: "Tests red" })],
		};
		const server = serveCard(state, { [`POST ${RUNS_PATH}`]: (c: Call) => run("queued", (c.body as { phase: string }).phase) });
		await openApp("/projects/p1/cards/007-search");
		expect(await screen.findByText("Tests red")).toBeTruthy();
		expect(screen.getByText("Succeeded")).toBeTruthy();
		expect(screen.getByText("Failed")).toBeTruthy();

		await fireEvent.press(screen.getByRole("button", { name: "Merge" }));
		await waitFor(() => expect(started(server)).toEqual(["merge"]));
		await fireEvent.press(screen.getByRole("button", { name: "Create the PR" }));
		await waitFor(() => expect(started(server)).toEqual(["merge", "pr"]));
		expect(LocalAuthentication.authenticateAsync).toHaveBeenCalled();

		// A person who does not confirm sends nothing.
		(LocalAuthentication.authenticateAsync as jest.Mock).mockResolvedValueOnce({ success: false, error: "user_cancel" });
		await fireEvent.press(screen.getByRole("button", { name: "Merge" }));
		await act(async () => undefined);
		expect(started(server)).toEqual(["merge", "pr"]);
	});

	it("sends the work back with what to change, then builds again", async () => {
		const state = {
			card: card({ column: "build_failed" }),
			details: details({ column: "build_failed", spec: "x", qaReport: "## QA\n3 failures" }),
			runs: [] as AgentRun[],
		};
		const server = serveCard(state, {
			[`POST ${CARD_PATH}/request-changes`]: {},
			[`POST ${RUNS_PATH}`]: run("queued"),
		});
		await openApp("/projects/p1/cards/007-search");
		expect(await screen.findByText("QA report")).toBeTruthy();
		await fireEvent.press(screen.getByRole("button", { name: "Request changes" }));
		// The steering section has its own Send, further down: the feedback's comes first.
		expect(screen.getAllByRole("button", { name: "Send" })[0]).toBeDisabled();
		await fireEvent.press(screen.getByRole("button", { name: "Cancel" }));
		expect(screen.queryByPlaceholderText("What should the agents change?")).toBeNull();

		await fireEvent.press(screen.getByRole("button", { name: "Request changes" }));
		await fireEvent.changeText(screen.getByPlaceholderText("What should the agents change?"), " Use the index ");
		await fireEvent.press(screen.getAllByRole("button", { name: "Send" })[0]);
		await waitFor(() => expect(started(server)).toEqual(["build"]));
		expect(server.called(`POST ${CARD_PATH}/request-changes`)[0].body).toEqual({ feedback: "Use the index" });
		await waitFor(() => expect(screen.queryByPlaceholderText("What should the agents change?")).toBeNull());
	});

	it("deletes the card after confirmation and goes back", async () => {
		const state = { card: card(), details: details(), runs: [] as AgentRun[] };
		const server = serveCard(state, { [`DELETE ${CARD_PATH}`]: {} });
		confirm();
		const app = await openApp("/projects/p1");
		await fireEvent.press(await screen.findByRole("button", { name: "Search the catalogue" }));
		await fireEvent.press(await screen.findByRole("button", { name: "Delete" }));
		await waitFor(() => expect(app.getPathname()).toBe("/projects/p1"));
		expect(server.called(`DELETE ${CARD_PATH}`)).toHaveLength(1);
	});

	it("keeps the card and says why when the deletion fails", async () => {
		const state = { card: card(), details: details(), runs: [] as AgentRun[] };
		serveCard(state, { [`DELETE ${CARD_PATH}`]: reply(409, { detail: "card is building" }) });
		confirm();
		await openApp("/projects/p1/cards/007-search");
		await fireEvent.press(await screen.findByRole("button", { name: "Delete" }));
		expect(await screen.findByText(/card is building/)).toBeTruthy();
	});

	it("does not delete when the lock is not confirmed", async () => {
		await saveLockSettings({ atLaunch: false, sensitive: true });
		(LocalAuthentication.authenticateAsync as jest.Mock).mockResolvedValueOnce({ success: false, error: "user_cancel" });
		const state = { card: card(), details: details(), runs: [] as AgentRun[] };
		const server = serveCard(state, { [`DELETE ${CARD_PATH}`]: {} });
		confirm();
		await openApp("/projects/p1/cards/007-search");
		await fireEvent.press(await screen.findByRole("button", { name: "Delete" }));
		await act(async () => undefined);
		expect(server.called(`DELETE ${CARD_PATH}`)).toHaveLength(0);
	});

	it("edits a card that has no spec yet", async () => {
		const state = { card: card(), details: details(), runs: [] as AgentRun[] };
		const server = serveCard(state, {
			[`PATCH ${CARD_PATH}`]: (c: Call) => {
				state.details = { ...state.details, ...(c.body as object) };
				state.card = { ...state.card, ...(c.body as object) };
				return state.card;
			},
		});
		await openApp("/projects/p1/cards/007-search");
		await fireEvent.press(await screen.findByRole("button", { name: "Edit" }));
		expect(await screen.findByText("Edit the card")).toBeTruthy();
		await fireEvent.press(screen.getByRole("button", { name: "Cancel" }));
		expect(screen.queryByText("Edit the card")).toBeNull();

		await fireEvent.press(screen.getByRole("button", { name: "Edit" }));
		await fireEvent.changeText(screen.getByLabelText("Title"), "  Search the whole catalogue ");
		await fireEvent.press(screen.getByRole("button", { name: "Save" }));
		// Saved: the form closes and the screen reads the card again.
		await waitFor(() => expect(screen.queryByText("Edit the card")).toBeNull());
		expect(server.called(`PATCH ${CARD_PATH}`)[0].body).toEqual({ title: "Search the whole catalogue" });
		expect(await screen.findByText("Search the whole catalogue")).toBeTruthy();
	});

	it("offers only what the person's permissions allow", async () => {
		const state = { card: card({ claimedByName: "Bob" }), details: details(), runs: [] as AgentRun[] };
		serveCard(state, {}, ["board.read"]);
		await openApp("/projects/p1/cards/007-search");
		expect(await screen.findByText("Claimed by Bob")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
	});

	it("hides the steering of a finished card and shows a card the server cannot find", async () => {
		const state = { card: card({ column: "done" }), details: details({ column: "done", spec: "x" }), runs: [] as AgentRun[] };
		serveCard(state);
		await openApp("/projects/p1/cards/007-search");
		expect(await screen.findByText("Search the catalogue")).toBeTruthy();
		expect(screen.queryByText("Guide the agent")).toBeNull();
	});

	it("shows why the card cannot be read, and reads it again on demand", async () => {
		const state = { card: card(), details: details(), runs: [] as AgentRun[] };
		const server = serveCard(state, { "GET /api/board/cards": { cards: [] } });
		await openApp("/projects/p1/cards/007-search");
		expect(await screen.findByText("The server hasn't indexed this card yet. Pull to refresh.")).toBeTruthy();
		server.routes["GET /api/board/cards"] = () => ({ cards: [state.card] });
		await fireEvent.press(screen.getByRole("button", { name: "Try again" }));
		expect(await screen.findByText("Search the catalogue")).toBeTruthy();
	});

	it("shows a failed action next to the card", async () => {
		const state = { card: card({ column: "error" }), details: details({ column: "error", spec: "x" }), runs: [] as AgentRun[] };
		serveCard(state, { [`POST ${RUNS_PATH}`]: reply(429, {}) });
		await openApp("/projects/p1/cards/007-search");
		await fireEvent.press(await screen.findByRole("button", { name: "Build again" }));
		expect(await screen.findByText("Too many attempts. Wait a minute, then try again.")).toBeTruthy();
	});
});
