import type { Api } from "../api/endpoints";
import type { AgentRun, BoardCard, CardDetails } from "../api/types";
import { allowedActions, availableActions, sendBack, startCard, stopCard } from "../board/actions";
import { groupByColumn } from "../board/columns";
import { initialColumn } from "../board/pickColumn";
import { BOARD_EVENTS, channelUrl, parseStreamEvent, reconnectDelay } from "../board/stream";

function card(overrides: Partial<BoardCard> = {}): BoardCard {
	return {
		id: "001-login",
		title: "Login",
		column: "backlog",
		kind: null,
		updatedAt: null,
		subtasks: { completed: 0, total: 0 },
		specId: "spec-1",
		claimedBy: null,
		claimedByName: null,
		...overrides,
	};
}

function details(overrides: Partial<CardDetails> = {}): CardDetails {
	const { specId: _s, claimedBy: _c, claimedByName: _n, ...base } = card();
	return {
		...base,
		description: "",
		spec: null,
		approval: { approved: false, approvedBy: null, approvedAt: null },
		requireReview: true,
		...overrides,
	};
}

function run(status: string): AgentRun {
	return {
		id: `run-${status}`,
		spec_id: "spec-1",
		phase: "build",
		started_by: null,
		model: null,
		status,
		started_at: "2026-11-01T10:00:00Z",
		finished_at: null,
		error: null,
	};
}

function fakeApi() {
	return {
		startRun: jest.fn(async () => run("queued")),
		approve: jest.fn(async () => ({})),
		runs: jest.fn(async () => [run("succeeded"), run("running")]),
		cancelRun: jest.fn(async () => ({ cancelled: true })),
		requestChanges: jest.fn(async () => ({})),
	};
}

describe("columns", () => {
	it("groups cards in board order and keeps the main columns when empty", () => {
		const groups = groupByColumn([card({ id: "a", column: "done" }), card({ id: "b", column: "build_failed" })]);
		expect(groups.map((g) => g.column)).toEqual([
			"backlog",
			"in_progress",
			"ai_review",
			"human_review",
			"build_failed",
			"done",
		]);
		expect(groups.find((g) => g.column === "done")?.cards.map((c) => c.id)).toEqual(["a"]);
	});

	it("opens on what waits for a person first", () => {
		expect(initialColumn(groupByColumn([card({ column: "in_progress" }), card({ id: "x", column: "human_review" })]))).toBe(
			"human_review",
		);
		expect(initialColumn(groupByColumn([card({ column: "done" })]))).toBe("done");
		expect(initialColumn(groupByColumn([]))).toBe("backlog");
	});
});

describe("availableActions", () => {
	it("offers start and delete on a fresh card", () => {
		expect(availableActions(card(), details(), [])).toEqual(["start", "delete"]);
	});

	it("offers only stop while an agent works", () => {
		expect(availableActions(card({ column: "in_progress" }), details(), [])).toEqual(["stop"]);
		expect(availableActions(card(), details(), [run("queued")])).toEqual(["stop"]);
	});

	it("asks for approval of a spec under review", () => {
		expect(availableActions(card({ column: "human_review" }), details({ spec: "# Spec" }), [])).toEqual([
			"approve",
			"start",
		]);
	});

	it("offers merge, PR and changes on reviewed work", () => {
		const reviewed = details({ spec: "# Spec", approval: { approved: true, approvedBy: "a", approvedAt: null } });
		expect(availableActions(card({ column: "human_review" }), reviewed, [])).toEqual([
			"merge",
			"createPr",
			"requestChanges",
		]);
	});

	it("offers nothing on a card the server has not indexed", () => {
		expect(availableActions(card({ specId: null }), details(), [])).toEqual([]);
	});

	it("hides what the person's permissions would refuse", () => {
		const can = (p: string) => p === "agent.execute";
		expect(allowedActions(["start", "approve", "merge", "stop", "delete"], can)).toEqual(["start", "stop"]);
	});
});

describe("card actions", () => {
	it("writes the spec first when the card has none", async () => {
		const api = fakeApi();
		await startCard(api as unknown as Api, "p1", card(), details());
		expect(api.startRun).toHaveBeenCalledWith("p1", "spec-1", "spec");
		expect(api.approve).not.toHaveBeenCalled();
	});

	it("approves a spec under review before building", async () => {
		const api = fakeApi();
		await startCard(api as unknown as Api, "p1", card(), details({ spec: "# Spec" }));
		expect(api.approve).toHaveBeenCalledWith("p1", "001-login");
		expect(api.startRun).toHaveBeenCalledWith("p1", "spec-1", "build");
	});

	it("builds directly when no review is asked", async () => {
		const api = fakeApi();
		await startCard(api as unknown as Api, "p1", card(), details({ spec: "# Spec", requireReview: false }));
		expect(api.approve).not.toHaveBeenCalled();
		expect(api.startRun).toHaveBeenCalledWith("p1", "spec-1", "build");
	});

	it("stops the running run", async () => {
		const api = fakeApi();
		expect(await stopCard(api as unknown as Api, "p1", card())).toBe(true);
		expect(api.cancelRun).toHaveBeenCalledWith("p1", "spec-1", "run-running");
	});

	it("sends the work back then builds, and refuses empty feedback", async () => {
		const api = fakeApi();
		await sendBack(api as unknown as Api, "p1", card(), "  Rename the button  ");
		expect(api.requestChanges).toHaveBeenCalledWith("p1", "001-login", "Rename the button");
		expect(api.startRun).toHaveBeenCalledWith("p1", "spec-1", "build");
		await expect(sendBack(api as unknown as Api, "p1", card(), "   ")).rejects.toThrow("feedback_required");
	});
});

describe("stream", () => {
	it("reads the server's events and ignores anything else", () => {
		expect(parseStreamEvent(JSON.stringify({ event_type: "spec_created", data: { spec: "001" } }))).toEqual({
			type: "spec_created",
			data: { spec: "001" },
		});
		expect(parseStreamEvent("not json")).toBeNull();
		expect(parseStreamEvent(JSON.stringify({ type: "x" }))).toBeNull();
		expect(parseStreamEvent("x".repeat(70_000))).toBeNull();
		expect(BOARD_EVENTS.has("spec_status_changed")).toBe(true);
	});

	it("names the project channel and backs off when it drops", () => {
		expect(channelUrl("wss://x.io:8765", "p/1")).toBe("wss://x.io:8765/stream/project%3Ap%2F1");
		expect([0, 1, 2, 3, 9].map(reconnectDelay)).toEqual([2000, 5000, 15000, 30000, 30000]);
	});
});
