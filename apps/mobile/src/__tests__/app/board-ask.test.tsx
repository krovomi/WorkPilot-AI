import { act, fireEvent, screen } from "expo-router/testing-library";
import { historyOf } from "../../board-ask/types";
import { type Call, fakeServer, openApp, reply, restoreFetch } from "../../../test-support/fake-server";

const READ = ["task.read", "board.read"];

afterEach(() => {
	restoreFetch();
	jest.useRealTimers();
	jest.restoreAllMocks();
});

function job(status: string, error: string | null = null) {
	return { id: "j1", feature: "board_ask", status, started_by: "u1", started_at: null, finished_at: null, error };
}

const RESULT = {
	answer: "Yes, the admin page was redone [1].",
	mode: "ai",
	searched: 12,
	matches: [
		{ taskId: "001-admin", title: "Admin page", state: "done", coverage: "full", reason: "It was redone." },
		{ taskId: "roadmap:f1", title: "Audit log", state: "planned", kind: "roadmap", coverage: "partial", archived: true },
		{ taskId: "idea:i1", title: "Admin dark mode", state: "abandoned", kind: "idea", coverage: "related" },
	],
};

async function tick() {
	await act(async () => {
		jest.advanceTimersByTime(3_000);
	});
}

describe("ask the board", () => {
	it("is a page of the More tab for who may read the board", async () => {
		fakeServer({ "GET /projects/p1": { id: "p1", name: "P" } }, READ);
		await openApp("/projects/p1/more");
		expect(await screen.findByText("Ask the board")).toBeTruthy();
	});

	it("asks, waits for the answer, opens a card and follows up with the conversation", async () => {
		jest.useFakeTimers();
		let status = "queued";
		let asked = 0;
		const server = fakeServer(
			{
				"POST /api/board/ask": () => {
					asked += 1;
					status = "running";
					return { job: job("queued") };
				},
				"GET /api/board/ask/jobs/j1": () =>
					status === "running" ? { job: job("running"), result: null } : { job: job("succeeded"), result: RESULT },
				"GET /api/board/cards/001-admin": reply(404),
			},
			READ,
		);
		await openApp("/projects/p1/ask");
		expect(await screen.findByText(/Ask about the board in any language/)).toBeTruthy();
		const send = screen.getByLabelText("Ask");
		expect(send.props.accessibilityState.disabled).toBe(true);
		await fireEvent.changeText(screen.getByLabelText("Your question"), "  Comment a été revue la page d'admin ?  ");
		await fireEvent.press(screen.getByLabelText("Ask"));
		expect(await screen.findByText("Looking for « Comment a été revue la page d'admin ? »…")).toBeTruthy();
		const first = server.called("POST /api/board/ask")[0];
		expect(first.query.get("project_id")).toBe("p1");
		expect(first.body).toEqual({ question: "Comment a été revue la page d'admin ?", language: "en", history: [] });

		await tick();
		expect(screen.queryByText("Yes, the admin page was redone [1].")).toBeNull();
		status = "succeeded";
		await tick();
		expect(await screen.findByText("Yes, the admin page was redone [1].")).toBeTruthy();
		expect(screen.getByText("[1] Admin page")).toBeTruthy();
		expect(screen.getByText("Already done")).toBeTruthy();
		expect(screen.getByText("It was redone.")).toBeTruthy();
		expect(screen.getByText("Roadmap")).toBeTruthy();
		expect(screen.getByText("Partly")).toBeTruthy();
		expect(screen.getByText("Archived")).toBeTruthy();
		expect(screen.getByText("Idea")).toBeTruthy();
		expect(screen.getByText("Related")).toBeTruthy();
		expect(screen.getByText("Abandoned")).toBeTruthy();
		expect(screen.getByText("12 tickets searched")).toBeTruthy();

		// A follow-up carries the turn before it.
		expect(screen.getByLabelText("Your question").props.placeholder).toBe("A follow-up question");
		await fireEvent.changeText(screen.getByLabelText("Your question"), "and the login?");
		await fireEvent.press(screen.getByLabelText("Ask"));
		expect(server.called("POST /api/board/ask")[1].body).toEqual({
			question: "and the login?",
			language: "en",
			history: [{ question: "Comment a été revue la page d'admin ?", answer: RESULT.answer }],
		});
		expect(asked).toBe(2);

		// Only a card opens; a roadmap feature does nothing.
		await fireEvent.press(screen.getAllByLabelText("Audit log")[0]);
		await fireEvent.press(screen.getAllByLabelText("Admin page")[0]);
		await act(async () => {
			jest.advanceTimersByTime(10);
		});
		expect(server.called("GET /api/board/cards/001-admin").length).toBeGreaterThan(0);
	});

	it("says when only keywords answered, or nothing related", async () => {
		jest.useFakeTimers();
		let result: unknown = { answer: "", mode: "keywords", searched: 1, matches: [{ taskId: "001-a", title: "A", state: "in_review" }] };
		fakeServer(
			{
				"POST /api/board/ask": { job: job("queued") },
				"GET /api/board/ask/jobs/j1": () => ({ job: job("succeeded"), result }),
			},
			READ,
		);
		await openApp("/projects/p1/ask");
		await fireEvent.changeText(await screen.findByLabelText("Your question"), "admin");
		await fireEvent.press(screen.getByLabelText("Ask"));
		await tick();
		expect(await screen.findByText("No model answered: these tickets share words with the question.")).toBeTruthy();
		expect(screen.getByText("In review")).toBeTruthy();
		expect(screen.getByText("1 ticket searched")).toBeTruthy();

		result = { answer: "", mode: "keywords", searched: 0, matches: [] };
		await fireEvent.changeText(screen.getByLabelText("Your question"), "admin");
		await fireEvent.press(screen.getByLabelText("Ask"));
		await tick();
		expect(await screen.findByText("No ticket relates to this question.")).toBeTruthy();
	});

	it("shows why a question got no answer, and a stopped one quietly", async () => {
		jest.useFakeTimers();
		let answer: unknown = { job: job("failed", "The provider refused"), result: null };
		const server = fakeServer(
			{
				"POST /api/board/ask": { job: job("queued") },
				"GET /api/board/ask/jobs/j1": () => answer,
				"POST /api/board/ask/jobs/j1/cancel": { cancelled: true },
			},
			READ,
		);
		await openApp("/projects/p1/ask");
		const ask = async () => {
			await fireEvent.changeText(screen.getByLabelText("Your question"), "admin");
			await fireEvent.press(screen.getByLabelText("Ask"));
		};
		await screen.findByLabelText("Your question");
		await ask();
		await tick();
		expect(await screen.findByText("The provider refused")).toBeTruthy();

		answer = { job: job("succeeded"), result: null };
		await ask();
		await tick();
		expect(await screen.findByText("The server gave no answer. Try again.")).toBeTruthy();

		answer = { job: job("running"), result: null };
		await ask();
		await fireEvent.press(await screen.findByLabelText("Stop"));
		expect(server.called("POST /api/board/ask/jobs/j1/cancel")).toHaveLength(1);
		answer = { job: job("cancelled"), result: null };
		await tick();
		expect(screen.queryByLabelText("Stop")).toBeNull();
		expect(screen.queryByText("The server gave no answer. Try again.")).toBeNull();
	});

	it("shows a refused question, a lost answer and a refused stop", async () => {
		jest.useFakeTimers();
		let asking: unknown = reply(409, { detail: "busy" });
		const reading = reply(500, { detail: "down" });
		const server = fakeServer(
			{
				"POST /api/board/ask": () => asking,
				"GET /api/board/ask/jobs/j1": (_call: Call) => reading,
				"POST /api/board/ask/jobs/j1/cancel": reply(403),
			},
			READ,
		);
		await openApp("/projects/p1/ask");
		await fireEvent.changeText(await screen.findByLabelText("Your question"), "admin");
		await fireEvent.press(screen.getByLabelText("Ask"));
		expect(server.called("POST /api/board/ask")).toHaveLength(1);
		expect(screen.queryByLabelText("Stop")).toBeNull();

		asking = { job: job("queued") };
		await fireEvent.press(screen.getByLabelText("Ask"));
		await fireEvent.press(await screen.findByLabelText("Stop"));
		expect(await screen.findByText("You don't have the rights for this action.")).toBeTruthy();
		await tick();
		// The answer could not be read: the question is no longer awaited.
		expect(screen.queryByLabelText("Stop")).toBeNull();
	});

	it("keeps the four latest turns, each answer bounded, for a follow-up", () => {
		const turn = (i: number) => ({
			id: i,
			question: `q${i}`,
			result: { answer: "a".repeat(5000), matches: [], mode: "ai" as const, searched: 0 },
		});
		const history = historyOf([0, 1, 2, 3, 4].map(turn));
		expect(history.map((h) => h.question)).toEqual(["q1", "q2", "q3", "q4"]);
		expect(history[0].answer).toHaveLength(4000);
	});
});
