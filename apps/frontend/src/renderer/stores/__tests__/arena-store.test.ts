/**
 * Model Arena: a battle streams its answers, ends in a vote, and keeps its
 * history and analytics. Its events reach the store for the life of the
 * window, so a battle that ends while the dialog is closed is not lost.
 *
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { openArenaDialog, setupArenaListeners, useArenaStore } from "../arena-store";

type Listener = (event: unknown) => void;
const listeners = new Map<string, Listener>();
let api: Record<string, ReturnType<typeof vi.fn>>;
const INITIAL = useArenaStore.getState();

const participant = (label: string, contenderId = `m-${label}`) =>
	({ label, contenderId, output: "", status: "waiting" }) as never;
const battle = (id = "b1") =>
	({ id, taskType: "coding", prompt: "p", participants: [participant("A"), participant("B")], status: "running" }) as never;

beforeEach(() => {
	listeners.clear();
	useArenaStore.setState(INITIAL, true);
	const on = (name: string) =>
		vi.fn((callback: Listener) => {
			listeners.set(name, callback);
			return vi.fn(() => listeners.delete(name));
		});
	api = {
		arenaVote: vi.fn().mockResolvedValue({ success: true }),
		arenaGetBattles: vi.fn().mockResolvedValue({ success: true, data: [{ id: "old" }] }),
		arenaGetAnalytics: vi.fn().mockResolvedValue({ success: true, data: { totalBattles: 3 } }),
		onArenaBattleProgress: on("progress"),
		onArenaBattleResult: on("result"),
		onArenaBattleComplete: on("complete"),
		onArenaBattleError: on("error"),
	};
	(window as unknown as { electronAPI: unknown }).electronAPI = api;
});

const state = () => useArenaStore.getState();
const labels = () => state().activeBattle?.participants.map((p) => [p.label, p.status, p.output]);

describe("the dialog", () => {
	it("opens without the last error, and closes", () => {
		state().setError("old");
		openArenaDialog();
		expect(state()).toMatchObject({ isOpen: true, error: null });
		state().closeDialog();
		expect(state().isOpen).toBe(false);
	});
});

describe("battle events", () => {
	it("streams each answer, records its result, then opens the vote", () => {
		setupArenaListeners();
		state().setActiveBattle(battle());
		listeners.get("progress")?.({ battleId: "b1", label: "A", chunk: "Hel" });
		listeners.get("progress")?.({ battleId: "b1", label: "A", chunk: "lo" });
		expect(labels()).toEqual([
			["A", "running", "Hello"],
			["B", "waiting", ""],
		]);

		listeners.get("result")?.({ battleId: "b1", label: "A", output: "Hello!", tokensUsed: 5, costUsd: 0.1, durationMs: 9 });
		listeners.get("result")?.({ battleId: "b1", label: "B", output: "", error: "timeout" });
		expect(state().activeBattle?.participants).toMatchObject([
			{ status: "completed", output: "Hello!", tokensUsed: 5, costUsd: 0.1, durationMs: 9 },
			{ status: "error", error: "timeout" },
		]);

		const finals = [participant("A"), participant("B")];
		listeners.get("complete")?.({ battleId: "b1", participants: finals });
		expect(state().activeBattle).toMatchObject({ status: "voting", participants: finals });
		expect(state().activeBattle?.completedAt).toEqual(expect.any(Number));
	});

	it("ends a battle that failed, instead of leaving it running", () => {
		setupArenaListeners();
		state().setActiveBattle(battle());
		listeners.get("error")?.({ battleId: "b1", error: "provider down" });
		expect(state()).toMatchObject({ activeBattle: { status: "error" }, error: "provider down" });
	});

	it("ignores the events of another battle, or with no battle at all", () => {
		setupArenaListeners();
		for (const name of ["progress", "result", "complete", "error"]) {
			listeners.get(name)?.({ battleId: "b1", label: "A", chunk: "x", participants: [] });
		}
		expect(state().activeBattle).toBeNull();

		state().setActiveBattle(battle("b2"));
		const before = state().activeBattle;
		for (const name of ["progress", "result", "complete", "error"]) {
			listeners.get(name)?.({ battleId: "b1", label: "A", chunk: "x", participants: [], error: "e" });
		}
		expect(state().activeBattle).toBe(before);
		expect(state().error).toBeNull();
	});

	it("drops its four listeners on teardown", () => {
		const teardown = setupArenaListeners();
		expect(listeners.size).toBe(4);
		teardown();
		expect(listeners.size).toBe(0);
	});
});

describe("the vote", () => {
	it("records the winner, reveals the battle, moves it to the top of the history and refreshes analytics", async () => {
		state().setActiveBattle({ ...(battle() as object), status: "voting" } as never);
		useArenaStore.setState({ battles: [{ id: "b1" } as never, { id: "old" } as never] });
		await state().submitVote("b1", "B");
		expect(api.arenaVote).toHaveBeenCalledWith(
			expect.objectContaining({ battleId: "b1", winnerLabel: "B", winnerContenderId: "m-B", taskType: "coding" }),
		);
		expect(state().activeBattle).toMatchObject({ status: "completed", winnerLabel: "B", revealed: true });
		expect(state().battles.map((b) => b.id)).toEqual(["b1", "old"]);
		await vi.waitFor(() => expect(state().analytics).toEqual({ totalBattles: 3 }));
	});

	it("changes nothing when the vote is refused", async () => {
		state().setActiveBattle(battle());
		api.arenaVote.mockResolvedValueOnce({ success: false });
		await state().submitVote("b1", "A");
		expect(state().activeBattle?.status).toBe("running");
		expect(api.arenaGetAnalytics).not.toHaveBeenCalled();
	});

	it("votes only on the battle on screen, for one of its participants", async () => {
		await state().submitVote("b1", "A");
		state().setActiveBattle(battle());
		await state().submitVote("other", "A");
		await state().submitVote("b1", "D");
		expect(api.arenaVote).not.toHaveBeenCalled();
	});

	it("says why a vote could not be sent", async () => {
		state().setActiveBattle(battle());
		api.arenaVote.mockRejectedValueOnce(new Error("disk full"));
		await state().submitVote("b1", "A");
		expect(state().error).toBe("disk full");

		api.arenaVote.mockRejectedValueOnce("x");
		await state().submitVote("b1", "A");
		expect(state().error).toBe("Failed to submit vote");

		api.arenaVote = undefined as never;
		(window as unknown as { electronAPI: unknown }).electronAPI = { ...api, arenaVote: undefined };
		await state().submitVote("b1", "A");
		expect(state().error).toMatch(/restart the application/);
	});
});

describe("history and analytics", () => {
	it("loads both", async () => {
		await state().loadHistory();
		await state().loadAnalytics();
		expect(state()).toMatchObject({
			battles: [{ id: "old" }],
			analytics: { totalBattles: 3 },
			isLoadingHistory: false,
			isLoadingAnalytics: false,
		});
	});

	it("keeps what it had when the main process has nothing", async () => {
		useArenaStore.setState({ battles: [{ id: "kept" } as never] });
		api.arenaGetBattles.mockResolvedValueOnce({ success: false });
		api.arenaGetAnalytics.mockResolvedValueOnce({ success: true });
		await state().loadHistory();
		await state().loadAnalytics();
		expect(state()).toMatchObject({ battles: [{ id: "kept" }], analytics: null });
	});

	it("shows why the history failed, and stays quiet about analytics", async () => {
		api.arenaGetBattles.mockRejectedValueOnce(new Error("corrupt"));
		await state().loadHistory();
		expect(state()).toMatchObject({ error: "corrupt", isLoadingHistory: false });
		api.arenaGetBattles.mockRejectedValueOnce(0);
		await state().loadHistory();
		expect(state().error).toBe("Failed to load history");

		state().setError(null);
		api.arenaGetAnalytics.mockRejectedValueOnce(new Error("x"));
		await state().loadAnalytics();
		expect(state()).toMatchObject({ error: null, isLoadingAnalytics: false });
	});

	it("does nothing without the arena API", async () => {
		(window as unknown as { electronAPI: unknown }).electronAPI = {};
		await state().loadHistory();
		await state().loadAnalytics();
		expect(state()).toMatchObject({ battles: [], analytics: null, isLoadingHistory: false });
	});

	it("keeps the starting flag and the auto-routing choice", () => {
		state().setIsStartingBattle(true);
		state().setAutoRoutingEnabled(true);
		expect(state()).toMatchObject({ isStartingBattle: true, autoRoutingEnabled: true });
	});
});
