/**
 * The Pixel Office room as it follows the app: what each terminal, Kanban
 * task and swarm subtask is shown doing, the chime when one starts waiting or
 * fails, keyboard selection, and which preferences survive a restart.
 *
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SubtaskNode } from "../../../shared/types/swarm";
import type { Task } from "../../../shared/types/task";
import { onOfficeSignal, usePixelOfficeStore } from "../pixel-office-store";
import type { Terminal } from "../terminal-store";

const store = () => usePixelOfficeStore.getState();
const activityOf = (id: string) => store().agents.find((a) => a.id === id)?.activity;

function terminal(id: string, extra: Partial<Terminal> = {}): Terminal {
	return { id, title: id, status: "idle", cwd: "/repo", createdAt: new Date(0), isClaudeMode: false, ...extra };
}

function task(id: string, extra: Partial<Task> = {}): Task {
	return { id, title: id, status: "in_progress", subtasks: [], ...extra } as unknown as Task;
}

function node(id: string, state: SubtaskNode["state"], extra: Partial<SubtaskNode> = {}): SubtaskNode {
	return {
		id,
		phaseName: "p",
		description: `do ${id}`,
		filesToModify: [],
		filesToCreate: [],
		dependsOn: [],
		state,
		waveIndex: 0,
		worktreePath: null,
		error: null,
		retryCount: 0,
		durationSeconds: null,
		...extra,
	} as SubtaskNode;
}

beforeEach(() => {
	usePixelOfficeStore.setState({ agents: [], selectedAgentId: null, nextCharacterIndex: 0 });
});

describe("terminals", () => {
	it.each([
		[{ isClaudeBusy: true }, "typing"],
		[{ isClaudeMode: true, status: "claude-active" }, "waiting"],
		[{ status: "running" }, "running"],
		[{}, "idle"],
	] as const)("%o is shown %s", (extra, activity) => {
		store().syncAll([terminal("t", extra as Partial<Terminal>)], []);
		expect(activityOf("t")).toBe(activity);
	});

	it("shortens a long title on the canvas and keeps it whole in the bubble", () => {
		const title = "x".repeat(50);
		store().syncAll([terminal("t", { title })], []);
		const [shown] = store().agents;
		expect(shown.name).toHaveLength(40);
		expect(shown.name.endsWith("…")).toBe(true);
		expect(shown.fullName).toBe(title);
	});
});

describe("Kanban tasks", () => {
	it.each([
		[{ status: "backlog" }, "pending"],
		[{ status: "error" }, "exited"],
		[{ status: "human_review" }, "waiting"],
		[{}, "running"],
		[{ executionProgress: { phase: "planning" } }, "reading"],
		[{ executionProgress: { phase: "coding" } }, "typing"],
		[{ executionProgress: { phase: "qa_review" } }, "reading"],
		[{ executionProgress: { phase: "qa_fixing" } }, "typing"],
		[{ executionProgress: { phase: "rate_limit_paused" } }, "waiting"],
		[{ executionProgress: { phase: "auth_failure_paused" } }, "waiting"],
		[{ executionProgress: { phase: "complete" } }, "idle"],
		[{ executionProgress: { phase: "failed" } }, "exited"],
		[{ executionProgress: { phase: "idle" } }, "running"],
	] as const)("%o is shown %s", (extra, activity) => {
		store().syncAll([], [task("k", extra as Partial<Task>)]);
		expect(activityOf("task:k")).toBe(activity);
	});

	it("leaves out the tasks that are done or not started on the board", () => {
		store().syncAll([], [task("a", { status: "done" }), task("b", { status: "pr_created" } as never)]);
		expect(store().agents).toEqual([]);
	});

	it("shows the board's percent, and a backlog task in the queue rather than at a desk", () => {
		const subtasks = [{ status: "completed" }, { status: "pending" }] as never;
		store().syncAll(
			[],
			[
				task("half", { subtasks, executionProgress: { phase: "coding", overallProgress: 10, currentSubtask: "s2" } as never }),
				task("todo", { status: "backlog" }),
			],
		);
		const [half, todo] = store().agents;
		expect(half).toMatchObject({ type: "task", progress: 50, currentSubtask: "s2", isClaudeMode: true, taskId: "half" });
		expect(todo).toMatchObject({ seatIndex: -1, waitingIndex: 0, isClaudeMode: false });
	});

	it("keeps an agent's character and desk across syncs", () => {
		store().syncAll([terminal("t")], [task("k")]);
		const before = store().agents.find((a) => a.id === "task:k");
		store().syncAll([terminal("t")], [task("k", { title: "renamed" })]);
		const after = store().agents.find((a) => a.id === "task:k");
		expect(after).toMatchObject({ characterIndex: before?.characterIndex, seatIndex: before?.seatIndex, fullName: "renamed" });
		expect(store().nextCharacterIndex).toBe(2);
	});
});

describe("swarm subtasks", () => {
	it.each([
		["pending", "pending"],
		["queued", "pending"],
		["running", "typing"],
		["completed", "idle"],
		["failed", "exited"],
		["retrying", "running"],
		["skipped", "exited"],
		["unknown", "waiting"],
	] as const)("a %s subtask is shown %s", (state, activity) => {
		store().syncSwarmAgents({ s1: node("s1", state as never) });
		expect(activityOf("swarm:s1")).toBe(activity);
	});

	it("names a subtask by its description, or its id", () => {
		store().syncSwarmAgents({ s1: node("s1", "running", { waveIndex: 2 }), s2: node("s2", "running", { description: "" }) });
		expect(store().agents.map((a) => a.fullName)).toEqual(["do s1", "s2"]);
		expect(store().agents[0]).toMatchObject({ swarmWaveIndex: 2, swarmSubtaskId: "s1", isClaudeMode: true });
	});

	it("keeps the swarm when terminals and tasks sync, and the rest when the swarm does", () => {
		store().syncAll([terminal("t")], []);
		store().syncSwarmAgents({ s1: node("s1", "running") });
		store().syncAll([terminal("t"), terminal("u")], []);
		expect(store().agents.map((a) => a.id).sort()).toEqual(["swarm:s1", "t", "u"]);
		store().syncSwarmAgents({ s1: node("s1", "completed"), s2: node("s2", "running") });
		expect(store().agents.map((a) => a.id).sort()).toEqual(["swarm:s1", "swarm:s2", "t", "u"]);
		const seats = store().agents.map((a) => a.seatIndex).sort();
		expect(seats).toEqual([0, 1, 2, 3]);
	});

	it("clears the swarm desks, and changes nothing when there is no swarm", () => {
		store().syncAll([terminal("t")], []);
		const agents = store().agents;
		store().clearSwarmAgents();
		expect(store().agents).toBe(agents);
		store().syncSwarmAgents({ s1: node("s1", "running") });
		store().clearSwarmAgents();
		expect(store().agents.map((a) => a.id)).toEqual(["t"]);
	});

	it("chimes when a running subtask fails, not when a queued one is skipped", () => {
		const heard = vi.fn();
		const off = onOfficeSignal(heard);
		store().syncAll([terminal("t")], []);
		store().syncSwarmAgents({ s1: node("s1", "running"), s2: node("s2", "pending") });
		store().syncSwarmAgents({ s1: node("s1", "failed"), s2: node("s2", "skipped") });
		off();
		expect(heard).toHaveBeenCalledOnce();
		expect(heard).toHaveBeenCalledWith("failed", expect.objectContaining({ id: "swarm:s1" }));
	});
});

describe("signals", () => {
	it("a listener that throws does not stop the others or the sync", () => {
		const offBad = onOfficeSignal(() => {
			throw new Error("audio context closed");
		});
		const heard = vi.fn();
		const off = onOfficeSignal(heard);
		store().syncAll([], [task("k", { executionProgress: { phase: "coding" } as never })]);
		store().syncAll([], [task("k", { status: "human_review" })]);
		offBad();
		off();
		expect(heard).toHaveBeenCalledWith("needs-input", expect.objectContaining({ id: "task:k" }));
		expect(activityOf("task:k")).toBe("waiting");
	});
});

describe("selection and settings", () => {
	it("cycles through the seated agents in desk order", () => {
		expect(store().cycleSelection(1)).toBeNull();
		store().syncAll([terminal("a"), terminal("b"), terminal("c")], [task("q", { status: "backlog" })]);
		expect(store().cycleSelection(1)).toBe("a");
		expect(store().cycleSelection(1)).toBe("b");
		expect(store().cycleSelection(-1)).toBe("a");
		expect(store().cycleSelection(-1)).toBe("c");
		store().selectAgent(null);
		expect(store().cycleSelection(-1)).toBe("c");
		expect(store().selectedAgentId).toBe("c");
	});

	it("updates one preference at a time", () => {
		store().updateSettings({ zoom: 4 });
		expect(store().settings).toMatchObject({ zoom: 4, soundEnabled: false });
	});

	it("persists only the preferences, filling the missing ones with defaults", async () => {
		store().syncAll([terminal("t")], []);
		store().updateSettings({ soundEnabled: true });
		const saved = JSON.parse(localStorage.getItem("pixel-office-settings") ?? "{}");
		expect(saved.state).toEqual({ settings: expect.objectContaining({ soundEnabled: true }) });

		localStorage.setItem("pixel-office-settings", JSON.stringify({ state: { settings: { zoom: 5 } }, version: 0 }));
		await usePixelOfficeStore.persist.rehydrate();
		expect(store().settings).toEqual({
			zoom: 5,
			showGrid: false,
			soundEnabled: false,
			autoAssignSeats: true,
			calmMode: false,
		});

		localStorage.setItem("pixel-office-settings", JSON.stringify({ state: null, version: 0 }));
		await usePixelOfficeStore.persist.rehydrate();
		expect(store().settings.zoom).toBe(3);
	});
});
