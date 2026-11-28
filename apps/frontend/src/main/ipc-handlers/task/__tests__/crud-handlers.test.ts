/**
 * @vitest-environment node
 *
 * Listing, creating, updating, deleting and resetting tasks over IPC, on a
 * real project folder. A server project's cards go to the server. A task
 * created or edited from tracker HTML keeps plain text for the AI and the
 * HTML for display. An edit writes the plan, spec.md, metadata and
 * requirements, keeps text with `$` as text, and saves only attachments
 * that are images inside their folder. Delete and reset clean the worktree
 * and every spec copy, and refuse a running task. A thumbnail is only read
 * from the task's own spec folder.
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	projects: [] as Array<Record<string, unknown>>,
	tasks: new Map<string, unknown[]>(),
	serverProject: null as unknown,
	serverCard: null as unknown,
	env: {} as Record<string, string>,
	inline: vi.fn(async (html: string) => `${html}<!-- inlined -->`),
	title: vi.fn(async (): Promise<string | null> => "Generated title"),
	questions: vi.fn(async (): Promise<unknown> => [{ id: "q1", question: "Why?" }]),
	cleanup: vi.fn(async () => ({ success: true, warnings: [] as string[] }) as Record<string, unknown>),
	image: {
		empty: false,
		size: { width: 400, height: 100 },
		resized: null as unknown,
	},
	invalidate: vi.fn(),
	clearAll: vi.fn(),
	clearTask: vi.fn(),
	server: {
		create: vi.fn(async () => ({ success: true, data: "created on server" })),
		update: vi.fn(async () => ({ success: true, data: "updated on server" })),
		delete: vi.fn(async () => ({ success: true, data: "deleted on server" })),
		list: vi.fn(async () => ({ success: true, data: ["server task"] })),
	},
}));

vi.mock("electron", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	nativeImage: {
		createFromPath: (file: string) => ({
			isEmpty: () => state.image.empty,
			getSize: () => state.image.size,
			resize: (size: unknown) => {
				state.image.resized = size;
				return { toJPEG: () => Buffer.from(`jpeg of ${path.basename(file)}`) };
			},
		}),
	},
}));
vi.mock("../../../project-store", () => ({
	projectStore: {
		getProjects: () => state.projects,
		getProject: (id: string) => state.projects.find((p) => p.id === id),
		getTasks: (id: string) => state.tasks.get(id) ?? [],
		invalidateTasksCache: state.invalidate,
	},
}));
vi.mock("../../../server-projects", () => ({ getServerProject: () => state.serverProject }));
vi.mock("../../../remote-board", () => ({ getRemoteTasks: state.server.list }));
vi.mock("../../../server-board-actions", () => ({
	createServerCard: state.server.create,
	updateServerCard: state.server.update,
	deleteServerCard: state.server.delete,
	findServerCard: () => state.serverCard,
}));
vi.mock("../../../task-state-manager", () => ({
	taskStateManager: { clearAllTasks: state.clearAll, clearTask: state.clearTask },
}));
vi.mock("../../../title-generator", () => ({ titleGenerator: { generateTitle: state.title } }));
vi.mock("../../../spec-interview-service", () => ({
	specInterviewService: { generateQuestions: state.questions },
}));
vi.mock("../../../app-language", () => ({ getAppLanguage: () => "fr" }));
vi.mock("../../../project-env-file", () => ({ readProjectEnv: () => state.env }));
vi.mock("../../shared/azure-attachments", () => ({ inlineAzureDevOpsImages: state.inline }));
vi.mock("../../../utils/worktree-cleanup", () => ({ cleanupWorktree: state.cleanup }));

import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../../../shared/constants";
import type { Task } from "../../../../shared/types";
import { registerTaskCRUDHandlers } from "../crud-handlers";

type Result = { success: boolean; error?: string; data?: unknown };
const invoke = (channel: string, ...args: unknown[]): Promise<Result> =>
	(
		ipcMain as unknown as {
			invokeHandler: (c: string, e: unknown, ...a: unknown[]) => Promise<Result>;
		}
	).invokeHandler(channel, {}, ...args);

const agent = { running: false, isRunning: vi.fn(() => agent.running) };
registerTaskCRUDHandlers(agent as never);

let base = "";
let projectDir = "";
let specDir = "";

function addTask(over: Partial<Task> = {}): Task {
	const task = {
		id: "t1",
		specId: "001-x",
		title: "Old title",
		description: "Old description",
		status: "backlog",
		subtasks: [],
		metadata: {},
		...over,
	} as Task;
	state.tasks.set("p1", [task]);
	return task;
}

const read = (file: string) => JSON.parse(readFileSync(file, "utf-8"));
const write = (file: string, data: unknown) =>
	writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data), "utf-8");

let spies: Array<ReturnType<typeof vi.spyOn>> = [];
beforeEach(() => {
	base = mkdtempSync(path.join(tmpdir(), "task-crud-"));
	projectDir = path.join(base, "project");
	specDir = path.join(projectDir, ".workpilot", "specs", "001-x");
	mkdirSync(specDir, { recursive: true });
	state.projects = [{ id: "p1", path: projectDir, autoBuildPath: ".workpilot" }];
	state.tasks = new Map();
	state.serverProject = null;
	state.serverCard = null;
	state.env = {};
	state.image.empty = false;
	state.image.size = { width: 400, height: 100 };
	agent.running = false;
	vi.clearAllMocks();
	spies = [
		vi.spyOn(console, "warn").mockImplementation(() => undefined),
		vi.spyOn(console, "error").mockImplementation(() => undefined),
	];
});
afterEach(() => {
	for (const spy of spies) spy.mockRestore();
	rmSync(base, { recursive: true, force: true });
});

describe("TASK_LIST", () => {
	it("lists the project's tasks, from scratch on a forced refresh", async () => {
		const task = addTask();
		expect(await invoke(IPC_CHANNELS.TASK_LIST, "p1")).toEqual({ success: true, data: [task] });
		expect(state.invalidate).not.toHaveBeenCalled();
		await invoke(IPC_CHANNELS.TASK_LIST, "p1", { forceRefresh: true });
		expect(state.invalidate).toHaveBeenCalledWith("p1");
		expect(state.clearAll).toHaveBeenCalled();
	});

	it("asks the server for a server project", async () => {
		state.serverProject = { id: "srv" };
		expect(await invoke(IPC_CHANNELS.TASK_LIST, "srv")).toEqual({ success: true, data: ["server task"] });
	});
});

describe("TASK_CREATE", () => {
	const create = (...args: unknown[]) => invoke(IPC_CHANNELS.TASK_CREATE, ...args);

	it("creates a server card for a server project, and refuses an unknown one", async () => {
		state.serverProject = { id: "srv" };
		expect(await create("srv", "T", "D")).toEqual({ success: true, data: "created on server" });
		state.serverProject = null;
		expect(await create("nope", "T", "D")).toEqual({ success: false, error: "Project not found" });
	});

	it("creates a local task with the title given, as plain text", async () => {
		const result = await create("p1", "<b>Login</b>", "Users sign in");
		expect(result.success).toBe(true);
		const task = result.data as Task;
		expect(task.title).toMatch(/Login/);
		expect(task.title).not.toMatch(/</);
		expect(state.title).not.toHaveBeenCalled();
		expect(readdirSync(path.join(projectDir, ".workpilot", "specs")).sort()).toEqual(["001-x", task.specId].sort());
	});

	it("keeps tracker HTML for display and plain text for the AI, images inlined from Azure DevOps", async () => {
		state.env = { AZURE_DEVOPS_PAT: "pat-test-0000", AZURE_DEVOPS_ORG_URL: "https://dev.azure.com/org" };
		const html = "<p>Users <b>sign</b> in</p>";
		const result = await create("p1", "Login", html, { importSource: "azure-devops" });
		const task = result.data as Task;
		expect(state.inline).toHaveBeenCalledWith(html, "https://dev.azure.com/org", "pat-test-0000");
		const dir = path.join(projectDir, ".workpilot", "specs", task.specId);
		const requirements = read(path.join(dir, "requirements.json"));
		expect(requirements.task_description).not.toMatch(/</);
		expect(requirements.display_description).toBe(`${html}<!-- inlined -->`);
	});

	it("keeps the HTML as it is when inlining fails or Azure DevOps is not configured", async () => {
		state.env = { AZURE_DEVOPS_PAT: "pat-test-0000", AZURE_DEVOPS_ORG_URL: "https://dev.azure.com/org" };
		state.inline.mockRejectedValueOnce(new Error("401"));
		expect((await create("p1", "A", "<p>x</p>", { importSource: "azure-devops" })).success).toBe(true);
		state.env = {};
		expect((await create("p1", "B", "<p>x</p>", { importSource: "azure-devops" })).success).toBe(true);
		expect(state.inline).toHaveBeenCalledTimes(1);
		// A description that is not HTML, or HTML from elsewhere, is not inlined.
		expect((await create("p1", "C", "<p>x</p>", { importSource: "jira" })).success).toBe(true);
		expect(state.inline).toHaveBeenCalledTimes(1);
	});

	it("generates a title when none is given, and falls back on the description", async () => {
		expect(((await create("p1", "  ", "Users sign in")).data as Task).title).toBe("Generated title");
		state.title.mockResolvedValueOnce(null);
		const long = "x".repeat(80);
		expect(((await create("p1", "", `${long}\nmore`)).data as Task).title).toBe(`${"x".repeat(60)}...`);
		state.title.mockRejectedValueOnce(new Error("no credentials"));
		expect(((await create("p1", undefined, "Short line\nmore")).data as Task).title).toBe("Short line");
		state.title.mockRejectedValueOnce(new Error("no credentials"));
		expect(((await create("p1", "", "y".repeat(70))).data as Task).title).toBe(`${"y".repeat(60)}...`);
		state.title.mockResolvedValueOnce(null);
		expect(((await create("p1", "", "short")).data as Task).title).toBe("short");
	});
});

describe("TASK_DELETE", () => {
	const del = () => invoke(IPC_CHANNELS.TASK_DELETE, "t1");
	const worktree = () => {
		const wt = path.join(projectDir, ".workpilot", "worktrees", "tasks", "001-x");
		mkdirSync(path.join(wt, ".workpilot", "specs", "001-x"), { recursive: true });
		return wt;
	};

	it("hands a server card to the server, and refuses an unknown or running task", async () => {
		state.serverCard = { cardId: "c" };
		expect(await del()).toEqual({ success: true, data: "deleted on server" });
		state.serverCard = null;
		expect(await del()).toEqual({ success: false, error: "Task or project not found" });
		addTask();
		agent.running = true;
		expect(await del()).toEqual({ success: false, error: "Cannot delete a running task. Stop the task first." });
		expect(existsSync(specDir)).toBe(true);
	});

	it("cleans the worktree (closing its PR) and deletes every spec copy", async () => {
		addTask({ metadata: { prUrl: "https://example.invalid/pr/3" } });
		const wt = worktree();
		state.cleanup.mockResolvedValueOnce({
			success: true,
			warnings: ["slow"],
			autoCommitted: true,
			prClosed: true,
			closedPrNumber: 3,
		});
		expect(await del()).toEqual({ success: true });
		expect(state.cleanup).toHaveBeenCalledWith(
			expect.objectContaining({ worktreePath: wt, deleteBranch: true, prUrl: "https://example.invalid/pr/3" }),
		);
		expect(existsSync(specDir)).toBe(false);
		expect(existsSync(path.join(wt, ".workpilot", "specs", "001-x"))).toBe(false);
		expect(state.invalidate).toHaveBeenCalledWith("p1");
	});

	it("is done when nothing is left on disk", async () => {
		addTask();
		rmSync(specDir, { recursive: true });
		expect(await del()).toEqual({ success: true });
		expect(state.invalidate).toHaveBeenCalledWith("p1");
	});

	it("reports a worktree it could not clean, after deleting the specs", async () => {
		addTask({ prUrl: "https://example.invalid/pr/4" } as Partial<Task>);
		worktree();
		state.cleanup.mockResolvedValueOnce({ success: false, warnings: ["locked", "busy"] });
		expect(await del()).toEqual({
			success: false,
			error: "Failed to delete some task files: Worktree cleanup: locked; busy",
		});
		expect((state.cleanup.mock.calls[0] as unknown[])[0]).toMatchObject({ prUrl: "https://example.invalid/pr/4" });
		expect(existsSync(specDir)).toBe(false);
	});
});

describe("TASK_RESET", () => {
	const reset = () => invoke(IPC_CHANNELS.TASK_RESET, "t1");

	it("refuses an unknown or running task", async () => {
		expect(await reset()).toEqual({ success: false, error: "Task or project not found" });
		addTask();
		agent.running = true;
		expect(await reset()).toEqual({ success: false, error: "Cannot reset a running task. Stop the task first." });
	});

	it("keeps the spec and drops everything the pipeline produced", async () => {
		addTask({ status: "human_review", subtasks: [{ id: "s" }] as Task["subtasks"], logs: ["x"] } as Partial<Task>);
		const wt = path.join(projectDir, ".workpilot", "worktrees", "tasks", "001-x");
		const wtSpec = path.join(wt, ".workpilot", "specs", "001-x");
		mkdirSync(wtSpec, { recursive: true });
		state.cleanup.mockResolvedValueOnce({ success: true, warnings: ["branch kept remotely"] });
		for (const dir of [specDir, wtSpec]) {
			for (const name of [
				"spec.md",
				"task_metadata.json",
				"implementation_plan.json",
				"qa_report.md",
				"task_logs.json",
				"conversation.jsonl",
				"conversation.qwen.jsonl",
				"conversation.jsonl.migrated",
				"PROMPT_TOO_LONG_HALT",
			]) {
				write(path.join(dir, name), "x");
			}
			mkdirSync(path.join(dir, "memory"));
			mkdirSync(path.join(dir, "attachments"));
		}

		const result = await reset();

		expect(result.success).toBe(true);
		expect(result.data).toMatchObject({ status: "backlog", subtasks: [], logs: [] });
		// The cleanup removed the worktree for real; the mock does not, so its copy is checked too.
		for (const dir of [specDir, wtSpec]) {
			expect(readdirSync(dir).sort()).toEqual(["attachments", "spec.md", "task_metadata.json"]);
		}
		expect(state.clearTask).toHaveBeenCalledWith("t1");
		expect(state.invalidate).toHaveBeenCalledWith("p1");
	});

	it("stops when the worktree cannot be removed, before touching the spec", async () => {
		addTask();
		mkdirSync(path.join(projectDir, ".workpilot", "worktrees", "tasks", "001-x"), { recursive: true });
		write(path.join(specDir, "implementation_plan.json"), "{}");
		state.cleanup.mockResolvedValueOnce({ success: false, warnings: ["locked"] });
		expect(await reset()).toEqual({ success: false, error: "Worktree cleanup failed: locked" });
		expect(existsSync(path.join(specDir, "implementation_plan.json"))).toBe(true);
		expect(state.clearTask).not.toHaveBeenCalled();
	});
});

describe("TASK_CHECK_PLAN_CONFLICTS and TASK_SPEC_INTERVIEW", () => {
	it("compares the task's plan with the project's other tasks", async () => {
		expect(await invoke(IPC_CHANNELS.TASK_CHECK_PLAN_CONFLICTS, "t1")).toEqual({ success: false, error: "Task not found" });
		addTask();
		const result = await invoke(IPC_CHANNELS.TASK_CHECK_PLAN_CONFLICTS, "t1");
		expect(result.success).toBe(true);
		expect(result.data).toBeDefined();
	});

	it("asks clarifying questions about the title and description, in the app's language", async () => {
		expect(await invoke(IPC_CHANNELS.TASK_SPEC_INTERVIEW, "t1")).toEqual({ success: false, error: "Task not found" });
		addTask({ title: "", description: "  " });
		expect(await invoke(IPC_CHANNELS.TASK_SPEC_INTERVIEW, "t1")).toEqual({
			success: false,
			error: "Task has no description to analyze",
		});
		addTask();
		expect(await invoke(IPC_CHANNELS.TASK_SPEC_INTERVIEW, "t1")).toEqual({
			success: true,
			data: [{ id: "q1", question: "Why?" }],
		});
		expect(state.questions).toHaveBeenCalledWith("Old title\n\nOld description", "fr");
		state.questions.mockResolvedValueOnce(null);
		expect((await invoke(IPC_CHANNELS.TASK_SPEC_INTERVIEW, "t1")).error).toMatch(/^Could not generate interview questions/);
	});
});

describe("TASK_UPDATE", () => {
	const update = (updates: unknown) => invoke(IPC_CHANNELS.TASK_UPDATE, "t1", updates);
	const files = () => ({
		plan: path.join(specDir, "implementation_plan.json"),
		spec: path.join(specDir, "spec.md"),
		meta: path.join(specDir, "task_metadata.json"),
		req: path.join(specDir, "requirements.json"),
	});
	function seed(): ReturnType<typeof files> {
		const f = files();
		write(f.plan, { feature: "Old title", description: "Old description", phases: [] });
		write(f.spec, "# Old title\n\n## Overview\nOld description\n\n## Requirements\n- keep\n");
		write(f.req, { task_description: "Old description", display_description: "<p>old</p>", additional_context: "old" });
		return f;
	}

	it("hands a server card to the server, and refuses an unknown task or a missing spec", async () => {
		state.serverCard = { cardId: "c" };
		expect(await update({ title: "x" })).toEqual({ success: true, data: "updated on server" });
		state.serverCard = null;
		expect(await update({ title: "x" })).toEqual({ success: false, error: "Task not found" });
		addTask();
		rmSync(specDir, { recursive: true });
		expect(await update({ title: "x" })).toEqual({ success: false, error: "Spec directory not found" });
	});

	it("writes the new title and description everywhere, keeping `$` in the text as text", async () => {
		addTask();
		const f = seed();
		write(path.join(specDir, "spec_source.json"), { task_description: "Old description" });

		const result = await update({
			title: "Pay $1 & keep $&",
			description: "It costs $1, see $& and $$",
			metadata: { category: "feature", acceptanceCriteria: ["works"], extraNote: "  note  " },
		});

		expect(result.success).toBe(true);
		expect(result.data).toMatchObject({ title: "Pay $1 & keep $&", description: "It costs $1, see $& and $$" });
		expect(read(f.plan)).toMatchObject({ feature: "Pay $1 & keep $&", description: "It costs $1, see $& and $$" });
		// A backlog task's spec was written for the old description: it is dropped, to be written again.
		expect(existsSync(f.spec)).toBe(false);
		expect(existsSync(path.join(specDir, "spec_source.json"))).toBe(false);
		expect(read(f.meta)).toMatchObject({ category: "feature" });
		expect(read(f.req)).toEqual({
			task_description: "It costs $1, see $& and $$",
			workflow_type: "feature",
			acceptance_criteria: ["works"],
			additional_context: "note",
		});
		expect(state.invalidate).toHaveBeenCalledWith("p1");
	});

	it("updates spec.md in place for a task that already ran", async () => {
		addTask({ status: "human_review" });
		const f = seed();
		expect((await update({ title: "New $& title", description: "Cost $1" })).success).toBe(true);
		expect(readFileSync(f.spec, "utf-8")).toBe("# New $& title\n\n## Overview\nCost $1\n\n\n## Requirements\n- keep\n");
		// Metadata untouched without a metadata update.
		expect(existsSync(f.meta)).toBe(false);
	});

	it("writes a description edited on its own where the spec pipeline reads it", async () => {
		// The card's inline editor and the pre-start answers send the description
		// alone: requirements.json kept the text of the card's creation, so the
		// agent planned from the title and ignored what the person wrote.
		addTask({ status: "human_review" });
		const f = seed();
		expect((await update({ description: "What I wrote on the card" })).success).toBe(true);
		expect(read(f.req)).toEqual({ task_description: "What I wrote on the card", additional_context: "old" });
		expect(read(f.plan).description).toBe("What I wrote on the card");

		// A title alone leaves requirements.json as it is.
		write(f.req, { task_description: "Kept" });
		expect((await update({ title: "Renamed" })).success).toBe(true);
		expect(read(f.req)).toEqual({ task_description: "Kept" });
	});

	it("keeps tracker HTML for display only, inlining Azure DevOps images", async () => {
		addTask({ status: "human_review", metadata: { importSource: "azure-devops" } });
		const f = seed();
		state.env = { AZURE_DEVOPS_PAT: "pat-test-0000", AZURE_DEVOPS_ORG_URL: "https://dev.azure.com/org" };
		const html = "<p>New <b>text</b></p>";
		const result = await update({ description: html, metadata: { extraNote: "  " } });
		expect((result.data as Task).description).toBe(`${html}<!-- inlined -->`);
		const req = read(f.req);
		expect(req.task_description).not.toMatch(/</);
		expect(req.display_description).toBe(`${html}<!-- inlined -->`);
		expect(req.additional_context).toBeUndefined();
		expect(read(f.plan).description).not.toMatch(/</);

		state.inline.mockRejectedValueOnce(new Error("401"));
		expect((await update({ description: html, metadata: {} })).success).toBe(true);
		// Without inlining the display HTML is the source: still kept for display.
		expect(read(f.req).display_description).toBe(html);
		state.env = {};
		expect((await update({ description: "plain", metadata: {} })).success).toBe(true);
		expect(read(f.req).display_description).toBeUndefined();
	});

	it("generates a missing title from the description, or falls back on it", async () => {
		addTask({ status: "human_review" });
		seed();
		expect((await update({ title: " " })).data).toMatchObject({ title: "Generated title" });
		expect(state.title).toHaveBeenCalledWith("Old description");
		state.title.mockResolvedValueOnce(null);
		expect((await update({ title: "", description: "z".repeat(61) })).data).toMatchObject({ title: `${"z".repeat(60)}...` });
		state.title.mockRejectedValueOnce(new Error("x"));
		expect((await update({ title: "", description: "first\nsecond" })).data).toMatchObject({ title: "first" });
		state.title.mockRejectedValueOnce(new Error("x"));
		expect((await update({ title: "", description: "w".repeat(90) })).data).toMatchObject({ title: `${"w".repeat(60)}...` });
		state.title.mockResolvedValueOnce(null);
		expect((await update({ title: "", description: "tiny" })).data).toMatchObject({ title: "tiny" });
	});

	it("goes on past a plan, spec, metadata or requirements file it cannot write", async () => {
		addTask({ status: "human_review" });
		const f = files();
		for (const file of [f.plan, f.spec, f.meta, f.req]) mkdirSync(file);
		const result = await update({ title: "T", description: "D", metadata: { category: "bug" } });
		expect(result.success).toBe(true);
		expect(result.data).toMatchObject({ title: "T", description: "D", metadata: { category: "bug" } });
	});

	it("goes on when there is no plan, spec or requirements at all", async () => {
		addTask();
		expect((await update({ title: "T", metadata: {} })).success).toBe(true);
	});

	it("answers with the error for an update it cannot read", async () => {
		addTask();
		expect(await update(undefined)).toMatchObject({ success: false });
		expect(await update({ description: 42 })).toMatchObject({ success: false });
	});

	it("saves attached images that are images, inside the attachments folder", async () => {
		addTask({ status: "human_review" });
		const data = Buffer.from("img").toString("base64");
		const result = await update({
			metadata: {
				attachedImages: [
					{ id: "1", filename: "shot.png", mimeType: "image/png", size: 3, data },
					{ id: "2", filename: "../../evil.png", mimeType: "image/png", size: 3, data },
					{ id: "3", filename: "page.html", mimeType: "text/html", size: 3, data },
					{ id: "4", filename: "nomime.png", size: 3, data },
					{ id: "5", filename: "..", mimeType: "image/png", size: 3, data },
					{ id: "6", filename: "kept.png", mimeType: "image/png", path: "attachments/kept.png" },
					{ id: "7", filename: "nothing.png", mimeType: "image/png" },
				],
			},
		});
		const images = (result.data as Task).metadata?.attachedImages;
		expect(images?.map((i) => i.id)).toEqual(["1", "2", "6"]);
		expect(images?.[1]).toMatchObject({ filename: "evil.png", path: "attachments/evil.png" });
		expect(readdirSync(path.join(specDir, "attachments")).sort()).toEqual(["evil.png", "shot.png"]);
		expect(readFileSync(path.join(specDir, "attachments", "shot.png"), "utf-8")).toBe("img");
		expect(read(path.join(specDir, "task_metadata.json")).attachedImages).toHaveLength(3);
	});

	it("leaves out an image it cannot write", async () => {
		addTask({ status: "human_review" });
		mkdirSync(path.join(specDir, "attachments", "taken.png"), { recursive: true });
		const result = await update({
			metadata: { attachedImages: [{ id: "1", filename: "taken.png", mimeType: "image/png", data: "eA==" }] },
		});
		expect((result.data as Task).metadata?.attachedImages).toEqual([]);
	});
});

describe("TASK_LOAD_IMAGE_THUMBNAIL", () => {
	const thumb = (...args: unknown[]) => invoke(IPC_CHANNELS.TASK_LOAD_IMAGE_THUMBNAIL, ...args);

	beforeEach(() => {
		mkdirSync(path.join(specDir, "attachments"), { recursive: true });
		write(path.join(specDir, "attachments", "shot.png"), "png");
	});

	it("refuses a bad spec id, an unknown project and a path out of the spec", async () => {
		for (const bad of ["../001-x", "a/b", "..", ""]) {
			expect(await thumb(projectDir, bad, "attachments/shot.png")).toEqual({ success: false, error: "Invalid spec ID" });
		}
		expect(await thumb(path.join(base, "other"), "001-x", "attachments/shot.png")).toEqual({
			success: false,
			error: "Unknown project",
		});
		write(path.join(projectDir, "secret.png"), "x");
		expect(await thumb(projectDir, "001-x", "../../../secret.png")).toEqual({ success: false, error: "Invalid image path" });
		expect(await thumb(projectDir, "001-x", "attachments/missing.png")).toEqual({
			success: false,
			error: "Image not found: attachments/missing.png",
		});
	});

	it("does not follow a link out of the spec folder", async (ctx) => {
		write(path.join(base, "outside.png"), "x");
		try {
			symlinkSync(path.join(base, "outside.png"), path.join(specDir, "attachments", "link.png"));
		} catch {
			ctx.skip(); // Windows without the right to create links
		}
		expect(await thumb(projectDir, "001-x", "attachments/link.png")).toEqual({ success: false, error: "Invalid image path" });
	});

	it("makes a thumbnail no larger than 200 pixels, keeping the proportions", async () => {
		const expected = `data:image/jpeg;base64,${Buffer.from("jpeg of shot.png").toString("base64")}`;
		expect(await thumb(projectDir, "001-x", "attachments/shot.png")).toEqual({ success: true, data: expected });
		expect(state.image.resized).toEqual({ width: 200, height: 50, quality: "good" });
		state.image.size = { width: 100, height: 400 };
		await thumb(projectDir, "001-x", "attachments/shot.png");
		expect(state.image.resized).toEqual({ width: 50, height: 200, quality: "good" });
		state.image.size = { width: 120, height: 80 };
		await thumb(projectDir, "001-x", "attachments/shot.png");
		expect(state.image.resized).toEqual({ width: 120, height: 80, quality: "good" });
		state.image.size = { width: 80, height: 120 };
		await thumb(projectDir, "001-x", "attachments/shot.png");
		expect(state.image.resized).toEqual({ width: 80, height: 120, quality: "good" });
	});

	it("answers an image it cannot load, and an error", async () => {
		state.image.empty = true;
		expect(await thumb(projectDir, "001-x", "attachments/shot.png")).toEqual({ success: false, error: "Failed to load image" });
		state.image.empty = false;
		state.image.size = null as never;
		expect((await thumb(projectDir, "001-x", "attachments/shot.png")).success).toBe(false);
	});
});
