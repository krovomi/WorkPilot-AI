/**
 * The IPC of « Interroger le tableau » revalidates what the renderer sends
 * (S6): a project id it knows, a bounded question, a bounded conversation.
 * The tickets are always the project's own, read here. « Vérifier une idée »
 * gets the same checks for its bounded idea.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../../shared/constants/ipc";

const state = vi.hoisted(() => ({
	handlers: new Map<string, (...args: unknown[]) => unknown>(),
	projects: new Map<string, { id: string; path: string }>(),
	tasks: [] as unknown[],
	server: new Set<string>(),
	oneShot: vi.fn(),
	semanticOptions: [] as unknown[],
	semantic: vi.fn(),
	rankingsOptions: [] as unknown[],
	rankings: vi.fn(),
	mode: "auto",
	sourceCalls: [] as unknown[][],
	sources: [] as unknown[],
}));

vi.mock("electron", () => ({
	ipcMain: {
		handle: (channel: string, fn: (...args: unknown[]) => unknown) => state.handlers.set(channel, fn),
	},
}));
vi.mock("../../project-store", () => ({
	projectStore: {
		getProject: (id: string) => state.projects.get(id),
		getTasks: () => state.tasks,
	},
}));
vi.mock("../../server-projects", () => ({ getServerProject: (id: unknown) => (state.server.has(id as string) ? {} : undefined) }));
vi.mock("../../app-language", () => ({ getAppLanguage: () => "fr" }));
vi.mock("../../oneshot-llm", () => ({ runOneShotLLM: state.oneShot }));
vi.mock("../../board-ask/sources", () => ({
	readBoardSourcesSetting: () => ["roadmap", "history"],
	readBoardSources: async (...args: unknown[]) => {
		state.sourceCalls.push(args);
		return state.sources;
	},
}));
vi.mock("../../board-ask/semantic-search", () => ({
	readSemanticMode: () => state.mode,
	createSemanticSearch: (options: { mode: string }) => {
		state.semanticOptions.push(options);
		return options.mode === "off" ? undefined : state.semantic;
	},
	createSemanticRankings: (options: { mode: string }) => {
		state.rankingsOptions.push(options);
		return options.mode === "off" ? undefined : state.rankings;
	},
}));

import {
	handleBoardAsk,
	handleBoardIdea,
	parseBoardAskRequest,
	parseBoardIdeaRequest,
	registerBoardAskHandlers,
} from "../board-ask-handlers";

beforeEach(() => {
	state.projects = new Map([["p1", { id: "p1", path: "/projects/one" }]]);
	state.tasks = [
		{
			id: "t1",
			title: "Export CSV",
			description: "",
			status: "done",
			subtasks: [],
			createdAt: new Date("2026-11-01T00:00:00Z"),
			updatedAt: new Date("2026-11-01T00:00:00Z"),
		},
	];
	state.server = new Set();
	state.oneShot.mockReset();
	state.oneShot.mockResolvedValue(null);
	state.semanticOptions = [];
	state.semantic.mockReset();
	state.semantic.mockResolvedValue(null);
	state.rankingsOptions = [];
	state.rankings.mockReset();
	state.rankings.mockResolvedValue(null);
	state.mode = "auto";
	state.sourceCalls = [];
	state.sources = [];
});

describe("parseBoardAskRequest", () => {
	it.each([
		[null, "Invalid request"],
		[[], "Invalid request"],
		[{ projectId: "", question: "q" }, "Invalid project id"],
		[{ projectId: "x".repeat(201), question: "q" }, "Invalid project id"],
		[{ projectId: "p1", question: "   " }, "Invalid question"],
		[{ projectId: "p1", question: "q".repeat(1001) }, "Invalid question"],
		[{ projectId: "p1", question: 4 }, "Invalid question"],
		[{ projectId: "p1", question: "q", history: "x" }, "Invalid conversation"],
		[{ projectId: "p1", question: "q", history: Array.from({ length: 21 }, () => ({ question: "a", answer: "b" })) }, "Invalid conversation"],
		[{ projectId: "p1", question: "q", history: [null] }, "Invalid conversation"],
		[{ projectId: "p1", question: "q", history: [{ question: "a", answer: 3 }] }, "Invalid conversation"],
		[{ projectId: "p1", question: "q", history: [{ question: "a", answer: "b".repeat(4001) }] }, "Invalid conversation"],
	])("refuses %j", (raw, error) => {
		expect(parseBoardAskRequest(raw)).toBe(error);
	});

	it("keeps the last turns of the conversation only, and drops unknown fields", () => {
		const history = Array.from({ length: 6 }, (_, i) => ({ question: `q${i}`, answer: `a${i}`, extra: true }));
		expect(parseBoardAskRequest({ projectId: "p1", question: " Q ", history, specDir: "/etc" })).toEqual({
			projectId: "p1",
			question: "Q",
			history: history.slice(2).map(({ question, answer }) => ({ question, answer })),
		});
	});
});

describe("handleBoardAsk", () => {
	it("refuses an unknown project and a server board", async () => {
		expect(await handleBoardAsk({ projectId: "nope", question: "q" })).toEqual({ success: false, error: "Unknown project" });
		state.server.add("p1");
		expect(await handleBoardAsk({ projectId: "p1", question: "q" })).toEqual({ success: false, error: "server_project" });
		expect(state.oneShot).not.toHaveBeenCalled();
	});

	it("asks the active provider in the project's folder and answers by keywords without it", async () => {
		registerBoardAskHandlers();
		const handler = state.handlers.get(IPC_CHANNELS.BOARD_ASK);
		const result = (await handler?.({}, { projectId: "p1", question: "export csv" })) as {
			success: boolean;
			data: { mode: string; matches: { taskId: string }[] };
		};
		expect(result.success).toBe(true);
		expect(result.data.mode).toBe("keywords");
		expect(result.data.matches.map((m) => m.taskId)).toEqual(["t1"]);
		expect(state.oneShot).toHaveBeenCalledWith(
			expect.objectContaining({ projectDir: "/projects/one", debugLabel: "BoardAskUnderstand" }),
		);
		expect(state.oneShot.mock.calls[0]?.[0]).not.toHaveProperty("provider");
	});

	it("ranks by meaning with the mode of the settings, in the project's folder", async () => {
		state.mode = "local";
		state.semantic.mockResolvedValue({
			source: { kind: "local", provider: "ollama", model: "bge-m3" },
			scores: [{ id: "t1", score: 0.8 }],
			indexed: 1,
			total: 1,
		});
		const result = await handleBoardAsk({ projectId: "p1", question: "exportación" });
		expect(state.semanticOptions).toEqual([{ projectDir: "/projects/one", mode: "local" }]);
		expect(result.success && result.data?.mode).toBe("semantic");
		expect(result.success && result.data?.semantic).toEqual({
			kind: "local",
			provider: "ollama",
			model: "bge-m3",
			indexed: 1,
			total: 1,
		});
	});

	it("asks no embeddings model when it is turned off, or when the caller says so", async () => {
		state.mode = "off";
		const off = await handleBoardAsk({ projectId: "p1", question: "export csv" });
		expect(off.success && off.data?.semantic).toBeUndefined();
		const none = await handleBoardAsk({ projectId: "p1", question: "export csv" }, undefined, null);
		expect(none.success && none.data?.mode).toBe("keywords");
		expect(state.semantic).not.toHaveBeenCalled();
	});
});

describe("parseBoardIdeaRequest", () => {
	it.each([
		[null, "Invalid request"],
		[["p1"], "Invalid request"],
		[{ projectId: 3, idea: "x" }, "Invalid project id"],
		[{ projectId: "x".repeat(201), idea: "x" }, "Invalid project id"],
		[{ projectId: "p1" }, "Invalid idea"],
		[{ projectId: "p1", idea: "  \n " }, "Invalid idea"],
		[{ projectId: "p1", idea: "i".repeat(6001) }, "Invalid idea"],
	])("refuses %j", (raw, error) => {
		expect(parseBoardIdeaRequest(raw)).toBe(error);
	});

	it("keeps the project id and the trimmed idea only", () => {
		expect(parseBoardIdeaRequest({ projectId: "p1", idea: " Export CSV \n", tasks: [{ id: "forged" }] })).toEqual({
			projectId: "p1",
			idea: "Export CSV",
		});
	});
});

describe("handleBoardIdea", () => {
	it("refuses a bad request, an unknown project and a server board", async () => {
		expect(await handleBoardIdea({ projectId: "p1", idea: "" })).toEqual({ success: false, error: "Invalid idea" });
		expect(await handleBoardIdea({ projectId: "nope", idea: "export" })).toEqual({
			success: false,
			error: "Unknown project",
		});
		state.server.add("p1");
		expect(await handleBoardIdea({ projectId: "p1", idea: "export" })).toEqual({
			success: false,
			error: "server_project",
		});
		expect(state.oneShot).not.toHaveBeenCalled();
	});

	it("checks the idea against the project's tickets with the active provider, through its channel", async () => {
		registerBoardAskHandlers();
		const handler = state.handlers.get(IPC_CHANNELS.BOARD_ASK_CHECK_IDEA);
		const result = (await handler?.({}, { projectId: "p1", idea: "Export CSV of the users" })) as {
			success: boolean;
			data: { mode: string; requirements: { verdict: string; matches: { taskId: string }[] }[] };
		};
		expect(result.success).toBe(true);
		expect(result.data.mode).toBe("keywords");
		expect(result.data.requirements).toHaveLength(1);
		expect(result.data.requirements[0]?.verdict).toBe("unknown");
		expect(result.data.requirements[0]?.matches.map((m) => m.taskId)).toEqual(["t1"]);
		expect(state.oneShot).toHaveBeenCalledWith(
			expect.objectContaining({ projectDir: "/projects/one", debugLabel: "BoardIdeaSplit" }),
		);
		expect(state.rankingsOptions).toEqual([{ projectDir: "/projects/one", mode: "auto" }]);
	});

	it("ranks no meaning when it is turned off, or when the caller says so", async () => {
		state.mode = "off";
		const off = await handleBoardIdea({ projectId: "p1", idea: "Export CSV" });
		expect(off.success && off.data?.semantic).toBeUndefined();
		const complete = vi.fn(async () => null);
		const none = await handleBoardIdea({ projectId: "p1", idea: "Export CSV" }, complete, null);
		expect(none.success && none.data?.mode).toBe("keywords");
		expect(complete).toHaveBeenCalled();
		expect(state.rankings).not.toHaveBeenCalled();
	});
});

describe("the other sources", () => {
	const roadmap = {
		id: "roadmap:f1",
		title: "Export CSV per role",
		description: "",
		spec: "",
		subtasks: [],
		files: [],
		state: "planned",
		archived: false,
		kind: "roadmap",
	};

	it("are read in the project's folder with the sources of the settings, for a question and an idea", async () => {
		state.sources = [roadmap];
		const asked = await handleBoardAsk({ projectId: "p1", question: "export csv role" }, undefined, null);
		expect(asked.success && asked.data?.matches.map((m) => [m.taskId, m.kind])).toEqual([
			["roadmap:f1", "roadmap"],
			["t1", undefined],
		]);
		const checked = await handleBoardIdea({ projectId: "p1", idea: "Export CSV per role" }, undefined, null);
		expect(checked.success && checked.data?.searched).toBe(2);
		expect(state.sourceCalls).toEqual([
			["/projects/one", state.tasks, ["roadmap", "history"]],
			["/projects/one", state.tasks, ["roadmap", "history"]],
		]);
	});
});
