/**
 * The IPC of « Proposer le sprint » revalidates what the renderer sends (S6):
 * a known project, a sprint id, a variant from the closed list, a bounded
 * goal and capacity. The cards and the sprints are read here, never sent.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import type { Sprint, Task } from "../../../shared/types";

const state = vi.hoisted(() => ({
	handlers: new Map<string, (...args: unknown[]) => unknown>(),
	projects: new Map<string, { id: string; path: string }>(),
	tasks: [] as unknown[],
	sprints: [] as unknown[],
	server: new Set<string>(),
	remote: vi.fn(),
	serverSprints: vi.fn(),
	oneShot: vi.fn(),
}));

vi.mock("electron", () => ({
	ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => state.handlers.set(channel, fn) },
}));
vi.mock("../../project-store", () => ({
	projectStore: { getProject: (id: string) => state.projects.get(id), getTasks: () => state.tasks },
}));
vi.mock("../../server-projects", () => ({
	getServerProject: (id: unknown) => (state.server.has(id as string) ? { id, path: "/user-data/mirror" } : undefined),
}));
vi.mock("../../remote-board", () => ({ getRemoteTasks: state.remote }));
vi.mock("../../sprints/local-sprints", () => ({ readLocalSprints: async () => state.sprints }));
vi.mock("../../sprints/server-sprints", () => ({ listServerSprints: state.serverSprints }));
vi.mock("../../app-language", () => ({ getAppLanguage: () => "fr" }));
vi.mock("../../oneshot-llm", () => ({ runOneShotLLM: state.oneShot }));

import { handleProposeSprint, parseSprintProposalRequest, registerSprintProposalHandlers } from "../sprint-proposal-handlers";

const SPRINT = "sp-0000000a";
const NOW = () => new Date("2026-11-28T12:00:00Z").getTime();

function card(id: string, points: number, sprintId?: string): Task {
	return {
		id,
		specId: id,
		projectId: "p",
		title: `Card ${id}`,
		description: "",
		status: "backlog",
		subtasks: [],
		logs: [],
		createdAt: new Date("2026-11-27T12:00:00Z"),
		updatedAt: new Date("2026-11-27T12:00:00Z"),
		metadata: { smartEstimate: { complexityScore: points }, ...(sprintId ? { sprintId } : {}) },
	} as unknown as Task;
}

function sprint(extra: Partial<Sprint> = {}): Sprint {
	return { id: SPRINT, name: "S1", state: "planned", createdAt: "2026-11-20T10:00:00Z", ...extra } as Sprint;
}

beforeEach(() => {
	state.projects.clear();
	state.server.clear();
	state.projects.set("p", { id: "p", path: "/work/p" });
	state.tasks = [card("a", 5), card("b", 8), card("in", 4, SPRINT)];
	state.sprints = [sprint({ capacity: 10 })];
	state.remote.mockReset();
	state.serverSprints.mockReset();
	state.oneShot.mockReset();
});

describe("parseSprintProposalRequest", () => {
	it("refuses what the renderer may not send", () => {
		expect(parseSprintProposalRequest(null)).toBe("Invalid request");
		expect(parseSprintProposalRequest([])).toBe("Invalid request");
		expect(parseSprintProposalRequest({ projectId: "", sprintId: SPRINT })).toBe("Invalid project id");
		expect(parseSprintProposalRequest({ projectId: "x".repeat(201), sprintId: SPRINT })).toBe("Invalid project id");
		expect(parseSprintProposalRequest({ projectId: "p", sprintId: "../x" })).toBe("Invalid sprint id");
		expect(parseSprintProposalRequest({ projectId: "p", sprintId: SPRINT, variant: "all" })).toBe("Invalid variant");
		expect(parseSprintProposalRequest({ projectId: "p", sprintId: SPRINT, goal: 4 })).toBe("Invalid goal");
		expect(parseSprintProposalRequest({ projectId: "p", sprintId: SPRINT, goal: "x".repeat(501) })).toBe("Invalid goal");
		for (const capacity of ["10", 0, 1000, 2.5]) {
			expect(parseSprintProposalRequest({ projectId: "p", sprintId: SPRINT, capacity })).toBe("Invalid capacity");
		}
	});

	it("keeps a trimmed goal and a capacity, and defaults the variant", () => {
		expect(parseSprintProposalRequest({ projectId: "p", sprintId: SPRINT, goal: "  ", capacity: 12 })).toEqual({
			projectId: "p",
			sprintId: SPRINT,
			variant: "balanced",
			capacity: 12,
		});
		expect(parseSprintProposalRequest({ projectId: "p", sprintId: SPRINT, variant: "careful", goal: " But " })).toEqual({
			projectId: "p",
			sprintId: SPRINT,
			variant: "careful",
			goal: "But",
		});
	});
});

describe("handleProposeSprint", () => {
	it("proposes from a local project's cards, around what the sprint holds", async () => {
		const result = await handleProposeSprint({ projectId: "p", sprintId: SPRINT }, null, NOW);
		expect(result.success).toBe(true);
		expect(result.data).toMatchObject({ capacity: 10, committed: 4, points: 5, mode: "rules" });
		expect(result.data?.picks.map((pick) => pick.taskId)).toEqual(["a"]);
	});

	it("uses this proposal’s capacity over the sprint’s", async () => {
		const result = await handleProposeSprint({ projectId: "p", sprintId: SPRINT, capacity: 20 }, null, NOW);
		expect(result.data?.points).toBe(13);
	});

	it("asks the person's model in the project's folder", async () => {
		state.oneShot.mockResolvedValue('{"picks":[{"ref":"c2","reason":"Le plus gros"}],"summary":"Court."}');
		const result = await handleProposeSprint({ projectId: "p", sprintId: SPRINT, capacity: 20 }, undefined, NOW);
		expect(state.oneShot).toHaveBeenCalledWith(
			expect.objectContaining({ projectDir: "/work/p", debugLabel: "sprint-proposal", timeoutMs: 60_000 }),
		);
		expect(result.data).toMatchObject({ mode: "ai", summary: "Court." });
		expect(result.data?.picks[0]).toMatchObject({ note: "Le plus gros" });
	});

	it("reads a server project's cards and sprints from the server", async () => {
		state.server.add("srv");
		state.remote.mockResolvedValue({ success: true, data: [card("r", 3)] });
		state.serverSprints.mockResolvedValue({ success: true, data: [sprint()] });
		const result = await handleProposeSprint({ projectId: "srv", sprintId: SPRINT }, null, NOW);
		expect(state.serverSprints).toHaveBeenCalledWith("srv");
		expect(result.data).toMatchObject({ capacity: 20, committed: 0, points: 3 });
	});

	it("refuses an unreachable server, an unknown project or sprint, and a closed sprint", async () => {
		state.server.add("srv");
		state.remote.mockResolvedValue({ success: false, error: "offline" });
		state.serverSprints.mockResolvedValue({ success: true, data: [] });
		expect(await handleProposeSprint({ projectId: "srv", sprintId: SPRINT }, null, NOW)).toEqual({
			success: false,
			error: "server_unreachable",
		});
		expect(await handleProposeSprint({ projectId: "nope", sprintId: SPRINT }, null, NOW)).toEqual({
			success: false,
			error: "Unknown project",
		});
		expect(await handleProposeSprint({ projectId: "p", sprintId: "sp-0000000b" }, null, NOW)).toEqual({
			success: false,
			error: "not_found",
		});
		state.sprints = [sprint({ state: "closed" })];
		expect(await handleProposeSprint({ projectId: "p", sprintId: SPRINT }, null, NOW)).toEqual({
			success: false,
			error: "closed",
		});
		expect(await handleProposeSprint({ projectId: "p" }, null, NOW)).toEqual({
			success: false,
			error: "Invalid sprint id",
		});
	});

	it("registers its channel", async () => {
		registerSprintProposalHandlers();
		const handler = state.handlers.get(IPC_CHANNELS.SPRINTS_PROPOSE);
		state.oneShot.mockResolvedValue(null);
		const result = (await handler?.({}, { projectId: "p", sprintId: SPRINT })) as { success: boolean };
		expect(result.success).toBe(true);
	});
});
