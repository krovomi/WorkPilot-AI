/**
 * The Agent Time Travel store: what it asks the main process for (checkpoints,
 * forks, decision scores), what it keeps of each answer, and what a refusal
 * leaves on screen.
 *
 * @vitest-environment jsdom
 */
import type { Checkpoint, ForkSession } from "@shared/types/time-travel";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTimeTravelStore } from "../time-travel-store";

const api = {
	generateTimeTravelCheckpoints: vi.fn(),
	getTimeTravelCheckpoints: vi.fn(),
	addTimeTravelCheckpoint: vi.fn(),
	deleteTimeTravelCheckpoint: vi.fn(),
	forkTimeTravelSession: vi.fn(),
	listTimeTravelForks: vi.fn(),
	getTimeTravelForkContext: vi.fn(),
	deleteTimeTravelFork: vi.fn(),
	scoreTimeTravelDecisions: vi.fn(),
	getTimeTravelDecisionScores: vi.fn(),
	getTimeTravelDecisionHeatmap: vi.fn(),
};

const INITIAL = useTimeTravelStore.getState();
const store = () => useTimeTravelStore.getState();

const cp = (id: string, step: number) =>
	({ id, step_index: step }) as unknown as Checkpoint;
const fork = (id: string) => ({ fork_id: id }) as unknown as ForkSession;

beforeEach(() => {
	useTimeTravelStore.setState(INITIAL, true);
	for (const fn of Object.values(api)) fn.mockReset();
	(window as unknown as { electronAPI: typeof api }).electronAPI = api;
});

describe("checkpoints", () => {
	it("generates the checkpoints of a session", async () => {
		api.generateTimeTravelCheckpoints.mockResolvedValue({
			success: true,
			checkpoints: [cp("a", 1)],
		});
		await store().generateCheckpoints("s1");
		expect(api.generateTimeTravelCheckpoints).toHaveBeenCalledWith("s1");
		expect(store()).toMatchObject({ checkpoints: [cp("a", 1)], checkpointsLoading: false });
	});

	it("shows why generation was refused, or failed", async () => {
		api.generateTimeTravelCheckpoints.mockResolvedValueOnce({ success: false, error: "no session" });
		await store().generateCheckpoints("s1");
		expect(store()).toMatchObject({ error: "no session", checkpointsLoading: false });

		api.generateTimeTravelCheckpoints.mockResolvedValueOnce({ success: false });
		await store().generateCheckpoints("s1");
		expect(store().error).toBe("Failed to generate checkpoints");

		api.generateTimeTravelCheckpoints.mockResolvedValueOnce({ success: true });
		await store().generateCheckpoints("s1");
		expect(store().checkpoints).toEqual([]);

		api.generateTimeTravelCheckpoints.mockRejectedValueOnce(new Error("down"));
		await store().generateCheckpoints("s1");
		expect(store()).toMatchObject({ error: "down", checkpointsLoading: false });
	});

	it("reads the stored checkpoints, empty when refused", async () => {
		api.getTimeTravelCheckpoints.mockResolvedValueOnce({ success: true, checkpoints: [cp("a", 1)] });
		await store().fetchCheckpoints("s1");
		expect(store().checkpoints).toEqual([cp("a", 1)]);

		api.getTimeTravelCheckpoints.mockResolvedValueOnce({ success: false });
		await store().fetchCheckpoints("s1");
		expect(store()).toMatchObject({ checkpoints: [], checkpointsLoading: false });

		api.getTimeTravelCheckpoints.mockResolvedValueOnce({ success: true });
		await store().fetchCheckpoints("s1");
		expect(store().checkpoints).toEqual([]);

		api.getTimeTravelCheckpoints.mockRejectedValueOnce(new Error("down"));
		await store().fetchCheckpoints("s1");
		expect(store()).toMatchObject({ error: "down", checkpointsLoading: false });
	});

	it("inserts a manual checkpoint in step order", async () => {
		useTimeTravelStore.setState({ checkpoints: [cp("a", 1), cp("c", 9)] });
		api.addTimeTravelCheckpoint.mockResolvedValue({ success: true, checkpoint: cp("b", 4) });
		await store().addManualCheckpoint("s1", 4, "here", "why");
		expect(api.addTimeTravelCheckpoint).toHaveBeenCalledWith("s1", 4, "here", "why");
		expect(store().checkpoints.map((c) => c.id)).toEqual(["a", "b", "c"]);
	});

	it("adds nothing when the checkpoint was refused, and shows a failure", async () => {
		api.addTimeTravelCheckpoint.mockResolvedValueOnce({ success: false });
		await store().addManualCheckpoint("s1", 4);
		expect(store().checkpoints).toEqual([]);

		api.addTimeTravelCheckpoint.mockRejectedValueOnce(new Error("down"));
		await store().addManualCheckpoint("s1", 4);
		expect(store().error).toBe("down");
	});

	it("removes a deleted checkpoint and unselects it", async () => {
		useTimeTravelStore.setState({
			checkpoints: [cp("a", 1), cp("b", 2)],
			selectedCheckpoint: cp("a", 1),
		});
		api.deleteTimeTravelCheckpoint.mockResolvedValue({ success: true });
		await store().deleteCheckpoint("s1", "a");
		expect(api.deleteTimeTravelCheckpoint).toHaveBeenCalledWith("s1", "a");
		expect(store().checkpoints).toEqual([cp("b", 2)]);
		expect(store().selectedCheckpoint).toBeNull();
	});

	it("keeps the selection when another checkpoint is deleted", async () => {
		const b = cp("b", 2);
		useTimeTravelStore.setState({ checkpoints: [cp("a", 1), b], selectedCheckpoint: b });
		api.deleteTimeTravelCheckpoint.mockResolvedValue({ success: true });
		await store().deleteCheckpoint("s1", "a");
		expect(store().selectedCheckpoint).toBe(b);
	});

	it("keeps a checkpoint the main process could not delete", async () => {
		useTimeTravelStore.setState({ checkpoints: [cp("a", 1)] });
		api.deleteTimeTravelCheckpoint.mockResolvedValueOnce({ success: false, error: "Checkpoint not found" });
		await store().deleteCheckpoint("s1", "a");
		expect(store().checkpoints).toEqual([cp("a", 1)]);
		expect(store().error).toBe("Checkpoint not found");

		api.deleteTimeTravelCheckpoint.mockResolvedValueOnce({ success: false });
		await store().deleteCheckpoint("s1", "a");
		expect(store().error).toBe("Failed to delete checkpoint");

		api.deleteTimeTravelCheckpoint.mockRejectedValueOnce(new Error("down"));
		await store().deleteCheckpoint("s1", "a");
		expect(store().checkpoints).toEqual([cp("a", 1)]);
		expect(store().error).toBe("down");
	});

	it("selects a checkpoint", () => {
		store().selectCheckpoint(cp("a", 1));
		expect(store().selectedCheckpoint).toEqual(cp("a", 1));
	});
});

describe("forks", () => {
	it("forks from a checkpoint with the chosen engine and closes the form", async () => {
		useTimeTravelStore.setState({ forks: [fork("old")], forkFormVisible: true, forkFormCheckpointId: "a" });
		api.forkTimeTravelSession.mockResolvedValue({ success: true, fork: fork("new") });
		const result = await store().forkSession("s1", "a", {
			modifiedPrompt: "try again",
			forkProvider: "openai",
			forkModel: "gpt",
		});
		expect(api.forkTimeTravelSession).toHaveBeenCalledWith("s1", {
			checkpoint_id: "a",
			modified_prompt: "try again",
			additional_instructions: "",
			fork_provider: "openai",
			fork_model: "gpt",
			fork_base_url: "",
		});
		expect(result).toEqual(fork("new"));
		expect(store()).toMatchObject({
			forks: [fork("new"), fork("old")],
			forkFormVisible: false,
			forkFormCheckpointId: null,
		});
	});

	it("sends every option it was given", async () => {
		api.forkTimeTravelSession.mockResolvedValue({ success: true, fork: fork("f") });
		await store().forkSession("s1", "a", {
			additionalInstructions: "be careful",
			forkBaseUrl: "http://localhost:11434",
		});
		expect(api.forkTimeTravelSession.mock.calls[0][1]).toMatchObject({
			modified_prompt: "",
			additional_instructions: "be careful",
			fork_base_url: "http://localhost:11434",
		});
	});

	it("shows why a fork was refused or failed", async () => {
		api.forkTimeTravelSession.mockResolvedValueOnce({ success: false, error: "no checkpoint" });
		expect(await store().forkSession("s1", "a", {})).toBeNull();
		expect(store().error).toBe("no checkpoint");

		api.forkTimeTravelSession.mockResolvedValueOnce({ success: true });
		expect(await store().forkSession("s1", "a", {})).toBeNull();
		expect(store().error).toBe("Failed to create fork");

		api.forkTimeTravelSession.mockRejectedValueOnce(new Error("down"));
		expect(await store().forkSession("s1", "a", {})).toBeNull();
		expect(store().error).toBe("down");
	});

	it("lists forks, empty when refused", async () => {
		api.listTimeTravelForks.mockResolvedValueOnce({ success: true, forks: [fork("f")] });
		await store().fetchForks("s1");
		expect(api.listTimeTravelForks).toHaveBeenCalledWith("s1");
		expect(store()).toMatchObject({ forks: [fork("f")], forksLoading: false });

		api.listTimeTravelForks.mockResolvedValueOnce({ success: true });
		await store().fetchForks();
		expect(store().forks).toEqual([]);

		useTimeTravelStore.setState({ forks: [fork("f")] });
		api.listTimeTravelForks.mockResolvedValueOnce({ success: false });
		await store().fetchForks();
		expect(store().forks).toEqual([]);

		api.listTimeTravelForks.mockRejectedValueOnce(new Error("down"));
		await store().fetchForks();
		expect(store()).toMatchObject({ error: "down", forksLoading: false });
	});

	it("reads the context of a fork, keeping the last one when refused", async () => {
		const context = { fork_id: "f" };
		api.getTimeTravelForkContext.mockResolvedValueOnce({ success: true, context });
		await store().fetchForkContext("f");
		expect(store().forkContext).toEqual(context);

		api.getTimeTravelForkContext.mockResolvedValueOnce({ success: false });
		await store().fetchForkContext("f");
		expect(store().forkContext).toEqual(context);

		api.getTimeTravelForkContext.mockRejectedValueOnce(new Error("down"));
		await store().fetchForkContext("f");
		expect(store().error).toBe("down");
	});

	it("removes a deleted fork with its selection and context", async () => {
		useTimeTravelStore.setState({
			forks: [fork("a"), fork("b")],
			selectedFork: fork("a"),
			forkContext: { fork_id: "a" } as never,
		});
		api.deleteTimeTravelFork.mockResolvedValue({ success: true });
		await store().deleteFork("a");
		expect(store()).toMatchObject({ forks: [fork("b")], selectedFork: null, forkContext: null });
	});

	it("keeps the selection and context of another fork", async () => {
		const b = fork("b");
		const context = { fork_id: "b" } as never;
		useTimeTravelStore.setState({ forks: [fork("a"), b], selectedFork: b, forkContext: context });
		api.deleteTimeTravelFork.mockResolvedValue({ success: true });
		await store().deleteFork("a");
		expect(store().selectedFork).toBe(b);
		expect(store().forkContext).toBe(context);
	});

	it("keeps a fork the main process could not delete", async () => {
		useTimeTravelStore.setState({ forks: [fork("a")] });
		api.deleteTimeTravelFork.mockResolvedValueOnce({ success: false, error: "Fork not found" });
		await store().deleteFork("a");
		expect(store().forks).toEqual([fork("a")]);
		expect(store().error).toBe("Fork not found");

		api.deleteTimeTravelFork.mockResolvedValueOnce({ success: false });
		await store().deleteFork("a");
		expect(store().error).toBe("Failed to delete fork");

		api.deleteTimeTravelFork.mockRejectedValueOnce(new Error("down"));
		await store().deleteFork("a");
		expect(store().forks).toEqual([fork("a")]);
		expect(store().error).toBe("down");
	});

	it("selecting a fork drops the previous context", () => {
		useTimeTravelStore.setState({ forkContext: { fork_id: "x" } as never });
		store().selectFork(fork("a"));
		expect(store()).toMatchObject({ selectedFork: fork("a"), forkContext: null });
	});

	it("opens and closes the fork form on a checkpoint", () => {
		store().openForkForm("a");
		expect(store()).toMatchObject({ forkFormVisible: true, forkFormCheckpointId: "a" });
		store().closeForkForm();
		expect(store()).toMatchObject({ forkFormVisible: false, forkFormCheckpointId: null });
	});
});

describe("decision scoring", () => {
	it("scores the decisions of a session", async () => {
		api.scoreTimeTravelDecisions.mockResolvedValueOnce({ success: true, scores: [{ step_index: 1 }] });
		await store().scoreDecisions("s1");
		expect(store()).toMatchObject({ decisionScores: [{ step_index: 1 }], decisionScoresLoading: false });

		api.scoreTimeTravelDecisions.mockResolvedValueOnce({ success: true });
		await store().scoreDecisions("s1");
		expect(store().decisionScores).toEqual([]);
	});

	it("shows why scoring was refused or failed", async () => {
		api.scoreTimeTravelDecisions.mockResolvedValueOnce({ success: false, error: "too short" });
		await store().scoreDecisions("s1");
		expect(store()).toMatchObject({ error: "too short", decisionScoresLoading: false });

		api.scoreTimeTravelDecisions.mockResolvedValueOnce({ success: false });
		await store().scoreDecisions("s1");
		expect(store().error).toBe("Failed to score decisions");

		api.scoreTimeTravelDecisions.mockRejectedValueOnce(new Error("down"));
		await store().scoreDecisions("s1");
		expect(store()).toMatchObject({ error: "down", decisionScoresLoading: false });
	});

	it("reads the stored scores, empty when refused", async () => {
		api.getTimeTravelDecisionScores.mockResolvedValueOnce({ success: true, scores: [{ step_index: 2 }] });
		await store().fetchDecisionScores("s1");
		expect(store().decisionScores).toEqual([{ step_index: 2 }]);

		api.getTimeTravelDecisionScores.mockResolvedValueOnce({ success: true });
		await store().fetchDecisionScores("s1");
		expect(store().decisionScores).toEqual([]);

		useTimeTravelStore.setState({ decisionScores: [{ step_index: 2 }] as never });
		api.getTimeTravelDecisionScores.mockResolvedValueOnce({ success: false });
		await store().fetchDecisionScores("s1");
		expect(store()).toMatchObject({ decisionScores: [], decisionScoresLoading: false });

		api.getTimeTravelDecisionScores.mockRejectedValueOnce(new Error("down"));
		await store().fetchDecisionScores("s1");
		expect(store()).toMatchObject({ error: "down", decisionScoresLoading: false });
	});

	it("reads the decision heatmap, none when refused", async () => {
		const heatmap = { files: [] };
		api.getTimeTravelDecisionHeatmap.mockResolvedValueOnce({ success: true, heatmap });
		await store().fetchDecisionHeatmap("s1");
		expect(store()).toMatchObject({ decisionHeatmap: heatmap, decisionHeatmapLoading: false });

		api.getTimeTravelDecisionHeatmap.mockResolvedValueOnce({ success: false });
		await store().fetchDecisionHeatmap("s1");
		expect(store()).toMatchObject({ decisionHeatmap: null, decisionHeatmapLoading: false });

		api.getTimeTravelDecisionHeatmap.mockRejectedValueOnce(new Error("down"));
		await store().fetchDecisionHeatmap("s1");
		expect(store()).toMatchObject({ error: "down", decisionHeatmapLoading: false });
	});
});

it("reset returns to an empty store", () => {
	useTimeTravelStore.setState({ checkpoints: [cp("a", 1)], forks: [fork("f")], error: "x" });
	store().reset();
	expect(store()).toMatchObject({ checkpoints: [], forks: [], error: null });
});
