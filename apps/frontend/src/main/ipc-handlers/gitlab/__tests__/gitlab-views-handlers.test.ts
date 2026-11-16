/**
 * @vitest-environment node
 *
 * The GitLab views' handlers as the renderer reaches them, on a stand-in
 * GitLab: the connection check, issues and their notes, merge requests and a
 * new one, the bulk import (a local spec, or a server project's card), and
 * the investigation that turns an issue and the notes the person chose into
 * a task. Arguments of the wrong shape never reach a handler.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ipcMain } from "electron";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type Fetched = { endpoint: string; options?: { method?: string; body?: string } };

const state = vi.hoisted(() => ({
	projects: {} as Record<string, Record<string, unknown>>,
	config: null as null | { token: string; instanceUrl: string; project: string },
	fetches: [] as Fetched[],
	answer: (_endpoint: string, _options?: Fetched["options"]): unknown => [],
	total: 0,
	cards: [] as { title: string; description: string }[],
	cardAnswer: { success: true, data: { id: "card-1" } } as { success: boolean; data?: unknown; error?: string },
	images: [] as unknown[][],
	window: null as null | { webContents: { send: ReturnType<typeof vi.fn> } },
}));

vi.mock("../../server-feature-files", () => ({
	featureProject: (id: unknown) => state.projects[id as string],
}));
vi.mock("../../../project-store", () => ({
	projectStore: { getProject: (id: string) => (state.projects[id]?.remote ? undefined : state.projects[id]) },
}));
vi.mock("../../../server-board-actions", () => ({
	createServerCard: async (_project: unknown, title: string, description: string) => {
		state.cards.push({ title, description });
		return state.cardAnswer;
	},
}));
vi.mock("../../shared/issue-attachments", () => ({
	attachGitLabIssueImages: async (...args: unknown[]) => {
		state.images.push(args);
	},
}));
vi.mock("../utils", async (importOriginal) => ({
	...(await importOriginal<typeof import("../utils")>()),
	getGitLabConfig: async () => state.config,
	gitlabFetch: async (_token: string, _instance: string, endpoint: string, options?: Fetched["options"]) => {
		state.fetches.push({ endpoint, options });
		return state.answer(endpoint, options);
	},
	gitlabFetchWithCount: async (_token: string, _instance: string, endpoint: string) => {
		state.fetches.push({ endpoint });
		return { data: [], totalCount: state.total };
	},
}));

import { IPC_CHANNELS } from "../../../../shared/constants";
import { registerGitlabHandlers } from "../index";
import { gitlabArgsAllowed } from "../ipc-guard";

type MockIpc = typeof ipcMain & {
	invokeHandler: (channel: string, event: unknown, ...args: unknown[]) => Promise<unknown>;
};
const invoke = (channel: string, ...args: unknown[]) => (ipcMain as MockIpc).invokeHandler(channel, {}, ...args);
const send = (channel: string, ...args: unknown[]) => ipcMain.emit(channel, {}, ...args);

const API = "/projects/acme%2Fshop";
const CONFIG = { token: "glpat-test-0000", instanceUrl: "https://gitlab.example.com", project: "acme/shop" };
const apiIssue = (iid: number, extra: Record<string, unknown> = {}) => ({
	id: 1000 + iid,
	iid,
	title: `Issue ${iid}`,
	description: `Body of ${iid}`,
	state: "opened",
	labels: ["bug"],
	assignees: [{ username: "ada", avatar_url: "https://gitlab.example.com/a.png" }],
	author: { username: "bob" },
	created_at: "2026-11-01T10:00:00Z",
	updated_at: "2026-11-02T10:00:00Z",
	user_notes_count: 2,
	web_url: `https://gitlab.example.com/acme/shop/-/issues/${iid}`,
	...extra,
});
const note = (id: number, extra: Record<string, unknown> = {}) => ({
	id,
	body: `Note ${id}`,
	author: { username: `user${id}` },
	created_at: "2026-11-03T10:00:00Z",
	updated_at: "2026-11-03T10:00:00Z",
	system: false,
	...extra,
});

let dir: string;

beforeAll(() => registerGitlabHandlers(() => state.window as never));

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), "gitlab-views-"));
	state.projects = {
		local: { id: "local", path: dir, autoBuildPath: ".workpilot", settings: { mainBranch: "develop" } },
		remote: { id: "remote", path: dir, remote: true },
	};
	state.config = { ...CONFIG };
	state.fetches = [];
	state.answer = () => [];
	state.total = 0;
	state.cards = [];
	state.cardAnswer = { success: true, data: { id: "card-1" } };
	state.images = [];
	state.window = { webContents: { send: vi.fn() } };
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("arguments", () => {
	const allowed = (channel: string, ...args: unknown[]) => gitlabArgsAllowed(channel, ["local", ...args]);

	it("take a state of GitLab's, an iid, and lists of iids and note ids", () => {
		expect(allowed(IPC_CHANNELS.GITLAB_GET_ISSUES)).toBe(true);
		expect(allowed(IPC_CHANNELS.GITLAB_GET_ISSUES, "closed")).toBe(true);
		expect(allowed(IPC_CHANNELS.GITLAB_GET_ISSUES, "opened&scope=all")).toBe(false);
		expect(allowed(IPC_CHANNELS.GITLAB_GET_MERGE_REQUESTS, "merged")).toBe(true);
		expect(allowed(IPC_CHANNELS.GITLAB_GET_MERGE_REQUESTS, "draft")).toBe(false);
		expect(allowed(IPC_CHANNELS.GITLAB_GET_ISSUE_NOTES, 7)).toBe(true);
		expect(allowed(IPC_CHANNELS.GITLAB_GET_ISSUE_NOTES, "7/../../x")).toBe(false);
		expect(allowed(IPC_CHANNELS.GITLAB_IMPORT_ISSUES, [1, 2])).toBe(true);
		expect(allowed(IPC_CHANNELS.GITLAB_IMPORT_ISSUES, [1, "2"])).toBe(false);
		expect(allowed(IPC_CHANNELS.GITLAB_INVESTIGATE_ISSUE, 7)).toBe(true);
		expect(allowed(IPC_CHANNELS.GITLAB_INVESTIGATE_ISSUE, 7, [3])).toBe(true);
		expect(allowed(IPC_CHANNELS.GITLAB_INVESTIGATE_ISSUE, 7, "3")).toBe(false);
		expect(allowed(IPC_CHANNELS.GITLAB_INVESTIGATE_ISSUE, 0)).toBe(false);
	});

	it("take a new merge request with the dialog's fields only, of their types", () => {
		const mr = { title: "Fix", sourceBranch: "fix/x", targetBranch: "develop" };
		const ok = (options: unknown) => allowed(IPC_CHANNELS.GITLAB_CREATE_MERGE_REQUEST, options);
		expect(ok(mr)).toBe(true);
		expect(
			ok({ ...mr, description: "Why", labels: ["bug"], assigneeIds: [3], removeSourceBranch: true, squash: false }),
		).toBe(true);
		expect(ok({ ...mr, title: "  " })).toBe(false);
		expect(ok({ ...mr, sourceBranch: "x".repeat(256) })).toBe(false);
		expect(ok({ ...mr, labels: "bug" })).toBe(false);
		expect(ok({ ...mr, assigneeIds: ["ada"] })).toBe(false);
		expect(ok({ ...mr, squash: "yes" })).toBe(false);
		expect(ok({ ...mr, description: 3 })).toBe(false);
		expect(ok({ ...mr, target_project_id: 9 })).toBe(false);
		expect(ok([mr])).toBe(false);
		expect(ok(null)).toBe(false);
	});

	it("refuse an invoke before the handler, and drop a send", async () => {
		await expect(invoke(IPC_CHANNELS.GITLAB_GET_ISSUES, "local", "all&x=1")).rejects.toThrow(
			"Invalid GitLab arguments",
		);
		send(IPC_CHANNELS.GITLAB_INVESTIGATE_ISSUE, "local", -1);
		await new Promise((resolve) => setImmediate(resolve));
		expect(state.fetches).toEqual([]);
		expect(state.window?.webContents.send).not.toHaveBeenCalled();
	});
});

describe("the connection check", () => {
	it("names the GitLab project and counts its open issues", async () => {
		state.answer = () => ({ path_with_namespace: "acme/shop", description: "The shop" });
		state.total = 12;
		const result = (await invoke(IPC_CHANNELS.GITLAB_CHECK_CONNECTION, "local")) as {
			data: Record<string, unknown>;
		};
		expect(result.data).toMatchObject({
			connected: true,
			instanceUrl: CONFIG.instanceUrl,
			projectPathWithNamespace: "acme/shop",
			projectDescription: "The shop",
			issueCount: 12,
		});
		expect(state.fetches.map((f) => f.endpoint)).toEqual([API, `${API}/issues?state=opened&per_page=1`]);
	});

	it("says why it is not connected", async () => {
		await expect(invoke(IPC_CHANNELS.GITLAB_CHECK_CONNECTION, "unknown")).resolves.toEqual({
			success: false,
			error: "Project not found",
		});
		state.config = null;
		await expect(invoke(IPC_CHANNELS.GITLAB_CHECK_CONNECTION, "local")).resolves.toMatchObject({
			success: true,
			data: { connected: false, error: expect.stringContaining("GITLAB_TOKEN") },
		});
		state.config = { ...CONFIG };
		state.answer = () => {
			throw new Error("401 Unauthorized");
		};
		await expect(invoke(IPC_CHANNELS.GITLAB_CHECK_CONNECTION, "local")).resolves.toMatchObject({
			data: { connected: false, error: "401 Unauthorized" },
		});
		state.answer = () => {
			throw "offline";
		};
		await expect(invoke(IPC_CHANNELS.GITLAB_CHECK_CONNECTION, "local")).resolves.toMatchObject({
			data: { connected: false, error: "Failed to connect to GitLab" },
		});
	});
});

describe("issues", () => {
	it("lists them, newest activity first, opened by default", async () => {
		state.answer = () => [
			apiIssue(7, { milestone: { id: 1, title: "v1", state: "closed" } }),
			apiIssue(8, { milestone: { id: 2, title: "v2", state: "upcoming" }, assignees: undefined, author: undefined, labels: undefined }),
			apiIssue(9, { assignees: [{}] }),
		];
		const result = (await invoke(IPC_CHANNELS.GITLAB_GET_ISSUES, "remote")) as { data: Record<string, unknown>[] };
		expect(state.fetches[0].endpoint).toBe(`${API}/issues?state=opened&per_page=100&order_by=updated_at&sort=desc`);
		expect(result.data[0]).toMatchObject({
			iid: 7,
			labels: ["bug"],
			assignees: [{ username: "ada", avatarUrl: "https://gitlab.example.com/a.png" }],
			author: { username: "bob" },
			milestone: { id: 1, title: "v1", state: "closed" },
			projectPathWithNamespace: "acme/shop",
		});
		expect(result.data[1]).toMatchObject({
			labels: [],
			assignees: [],
			author: { username: "unknown" },
			milestone: { state: "active" },
		});
		expect(result.data[2]).toMatchObject({ assignees: [{ username: "unknown" }] });

		await invoke(IPC_CHANNELS.GITLAB_GET_ISSUES, "local", "all");
		expect(state.fetches[1].endpoint).toContain("state=all");
	});

	it("reads an issue's notes without GitLab's system notes", async () => {
		state.answer = () => [note(1), note(2, { system: true }), note(3, { author: undefined })];
		const result = (await invoke(IPC_CHANNELS.GITLAB_GET_ISSUE_NOTES, "local", 7)) as { data: { id: number }[] };
		expect(state.fetches[0].endpoint).toBe(`${API}/issues/7/notes?per_page=100&order_by=created_at&sort=asc`);
		expect(result.data.map((n) => n.id)).toEqual([1, 3]);
		expect(result.data[1]).toMatchObject({ author: { username: "unknown" } });
	});

	it("says why a list could not be read", async () => {
		await expect(invoke(IPC_CHANNELS.GITLAB_GET_ISSUES, "unknown")).resolves.toEqual({
			success: false,
			error: "Project not found",
		});
		state.config = null;
		await expect(invoke(IPC_CHANNELS.GITLAB_GET_ISSUE_NOTES, "local", 7)).resolves.toEqual({
			success: false,
			error: "GitLab not configured",
		});
		state.config = { ...CONFIG };
		state.answer = () => {
			throw new Error("404 Not Found");
		};
		await expect(invoke(IPC_CHANNELS.GITLAB_GET_ISSUES, "local")).resolves.toEqual({
			success: false,
			error: "404 Not Found",
		});
		state.answer = () => {
			throw "offline";
		};
		await expect(invoke(IPC_CHANNELS.GITLAB_GET_ISSUE_NOTES, "local", 7)).resolves.toEqual({
			success: false,
			error: "Failed to get notes",
		});
	});
});

describe("merge requests", () => {
	it("lists them in the state asked, opened by default, whatever field GitLab left out", async () => {
		state.answer = () => [
			{
				id: 1,
				iid: 3,
				title: "Add cart",
				description: "",
				state: "merged",
				source_branch: "feat/cart",
				target_branch: "develop",
				author: { username: "ada", avatar_url: "" },
				assignees: [{ username: "bob" }, null],
				labels: ["feature"],
				web_url: "https://gitlab.example.com/acme/shop/-/merge_requests/3",
				created_at: "2026-11-01T10:00:00Z",
				updated_at: "",
				merged_at: "2026-11-02T10:00:00Z",
				merge_status: "can_be_merged",
			},
			{ id: 2, iid: 4 },
			{ id: 5, iid: 5, author: {} },
		];
		const result = (await invoke(IPC_CHANNELS.GITLAB_GET_MERGE_REQUESTS, "local")) as {
			data: Record<string, unknown>[];
		};
		expect(state.fetches[0].endpoint).toBe(
			`${API}/merge_requests?state=opened&per_page=100&order_by=updated_at&sort=desc`,
		);
		expect(result.data[0]).toMatchObject({
			iid: 3,
			description: undefined,
			state: "merged",
			author: { username: "ada", avatarUrl: undefined },
			assignees: [{ username: "bob" }, { username: "" }],
			updatedAt: "2026-11-01T10:00:00Z",
			mergedAt: "2026-11-02T10:00:00Z",
			mergeStatus: "can_be_merged",
		});
		expect(result.data[1]).toMatchObject({
			title: "",
			state: "opened",
			sourceBranch: "",
			author: { username: "" },
			assignees: [],
			labels: [],
			webUrl: "",
			mergedAt: undefined,
			mergeStatus: "",
		});
		expect(result.data[2]).toMatchObject({ author: { username: "" } });

		await invoke(IPC_CHANNELS.GITLAB_GET_MERGE_REQUESTS, "local", "all");
		expect(state.fetches[1].endpoint).toContain("state=all");
	});

	it("creates one with the fields the dialog filled in", async () => {
		state.answer = () => ({ id: 9, iid: 5, title: "Fix", source_branch: "fix/x", target_branch: "develop" });
		const minimal = { title: "Fix", sourceBranch: "fix/x", targetBranch: "develop" };
		await expect(invoke(IPC_CHANNELS.GITLAB_CREATE_MERGE_REQUEST, "local", minimal)).resolves.toMatchObject({
			success: true,
			data: { iid: 5, title: "Fix" },
		});
		await invoke(IPC_CHANNELS.GITLAB_CREATE_MERGE_REQUEST, "local", {
			...minimal,
			description: "Why",
			labels: ["bug", "ui"],
			assigneeIds: [3],
			removeSourceBranch: true,
			squash: false,
		});
		const bodies = state.fetches.map((f) => {
			expect(f).toMatchObject({ endpoint: `${API}/merge_requests`, options: { method: "POST" } });
			return JSON.parse(f.options?.body ?? "{}");
		});
		expect(bodies[0]).toEqual({ source_branch: "fix/x", target_branch: "develop", title: "Fix" });
		expect(bodies[1]).toEqual({
			source_branch: "fix/x",
			target_branch: "develop",
			title: "Fix",
			description: "Why",
			labels: "bug,ui",
			assignee_ids: [3],
			remove_source_branch: true,
			squash: false,
		});
	});

	it("says why one was not created", async () => {
		state.answer = () => {
			throw new Error("409 Another open merge request already exists");
		};
		await expect(
			invoke(IPC_CHANNELS.GITLAB_CREATE_MERGE_REQUEST, "local", {
				title: "Fix",
				sourceBranch: "fix/x",
				targetBranch: "develop",
			}),
		).resolves.toEqual({ success: false, error: "409 Another open merge request already exists" });
	});
});

describe("importing issues", () => {
	const specs = () => path.join(dir, ".workpilot", "specs");

	it("makes a spec of each local issue, with its screenshots, and goes on past one that fails", async () => {
		state.answer = (endpoint) => {
			if (endpoint.endsWith("/issues/9")) throw new Error("404 Not Found");
			if (endpoint.endsWith("/issues/10")) throw "offline";
			if (endpoint.endsWith("/issues/11")) return apiIssue(0);
			return apiIssue(Number(endpoint.split("/").at(-1)));
		};
		const result = (await invoke(IPC_CHANNELS.GITLAB_IMPORT_ISSUES, "local", [7, 9, 10, 11])) as {
			data: Record<string, unknown>;
		};
		expect(result).toMatchObject({ success: true });
		expect(result.data).toEqual({
			success: true,
			imported: 1,
			failed: 3,
			errors: ["404 Not Found", "Unknown error for issue #10", "Failed to create task for issue #11"],
		});
		const task = readFileSync(path.join(specs(), "007-issue-7", "TASK.md"), "utf-8");
		expect(task).toContain("# GitLab Issue #7: Issue 7");
		expect(state.images).toHaveLength(1);
		expect(state.images[0].slice(2, 5)).toEqual(["acme/shop", "Body of 7", 7]);
	});

	it("makes a card of a server project's issue on its shared board", async () => {
		state.answer = () => apiIssue(7, { title: "T".repeat(300), description: "D".repeat(30_000) });
		const result = (await invoke(IPC_CHANNELS.GITLAB_IMPORT_ISSUES, "remote", [7])) as {
			data: Record<string, unknown>;
		};
		expect(result.data).toEqual({ success: true, imported: 1, failed: 0, tasks: [{ id: "card-1" }] });
		expect(state.cards[0].title).toHaveLength(200);
		expect(state.cards[0].description.length).toBeLessThanOrEqual(20_000);
		expect(state.cards[0].description).toContain("# GitLab Issue #7");

		state.cardAnswer = { success: false };
		state.answer = () => apiIssue(8, { title: undefined });
		const refused = (await invoke(IPC_CHANNELS.GITLAB_IMPORT_ISSUES, "remote", [8])) as {
			data: Record<string, unknown>;
		};
		expect(state.cards[1].title).toBe("");
		expect(refused.data).toEqual({ success: false, imported: 0, failed: 1, errors: ["Server unavailable"], tasks: [] });
		state.cardAnswer = { success: false, error: "Board is read-only" };
		const readOnly = (await invoke(IPC_CHANNELS.GITLAB_IMPORT_ISSUES, "remote", [8])) as {
			data: { errors: string[] };
		};
		expect(readOnly.data.errors).toEqual(["Board is read-only"]);
	});

	it("imports nothing without a project or a config", async () => {
		await expect(invoke(IPC_CHANNELS.GITLAB_IMPORT_ISSUES, "unknown", [7])).resolves.toEqual({
			success: false,
			error: "Project not found",
		});
		state.config = null;
		await expect(invoke(IPC_CHANNELS.GITLAB_IMPORT_ISSUES, "local", [7])).resolves.toEqual({
			success: false,
			error: "GitLab not configured",
		});
	});
});

describe("investigating an issue", () => {
	const sent = (channel: string) =>
		(state.window?.webContents.send.mock.calls ?? []).filter(([c]) => c === channel).map(([, , payload]) => payload);
	const investigate = async (...args: unknown[]) => {
		send(IPC_CHANNELS.GITLAB_INVESTIGATE_ISSUE, "local", ...args);
		await vi.waitFor(() =>
			expect(
				sent(IPC_CHANNELS.GITLAB_INVESTIGATION_COMPLETE).length + sent(IPC_CHANNELS.GITLAB_INVESTIGATION_ERROR).length,
			).toBeGreaterThan(0),
		);
	};

	it("makes a task of the issue and the notes the person chose", async () => {
		state.answer = (endpoint) =>
			endpoint.includes("/notes") ? [note(1), note(2), note(3, { system: true })] : apiIssue(7);
		await investigate(7, [2, 3]);

		expect(state.fetches.map((f) => f.endpoint)).toEqual([
			`${API}/issues/7`,
			`${API}/issues/7/notes?per_page=100&order_by=created_at&sort=asc`,
		]);
		const task = readFileSync(path.join(dir, ".workpilot", "specs", "007-issue-7", "TASK.md"), "utf-8");
		expect(task).toContain("## Selected comments");
		expect(task).toContain("**@user2** (2026-11-03):\n\nNote 2");
		expect(task).not.toContain("Note 1");
		expect(task).not.toContain("Note 3");
		const metadata = JSON.parse(
			readFileSync(path.join(dir, ".workpilot", "specs", "007-issue-7", "task_metadata.json"), "utf-8"),
		);
		expect(metadata).toMatchObject({ sourceType: "gitlab", gitlabIssueIid: 7, baseBranch: "develop", category: "bug_fix" });

		expect(sent(IPC_CHANNELS.GITLAB_INVESTIGATION_PROGRESS).map((s) => (s as { phase: string }).phase)).toEqual([
			"fetching",
			"creating_task",
			"complete",
		]);
		expect(sent(IPC_CHANNELS.GITLAB_INVESTIGATION_COMPLETE)[0]).toMatchObject({
			success: true,
			issueIid: 7,
			taskId: "007-issue-7",
			analysis: { summary: "Investigation of GitLab issue #7: Issue 7", proposedSolution: "Body of 7" },
		});
		expect(state.images).toHaveLength(1);
	});

	it("reads no notes when none is chosen", async () => {
		state.answer = () => apiIssue(7, { description: "" });
		await investigate(7);
		expect(state.fetches).toHaveLength(1);
		expect(sent(IPC_CHANNELS.GITLAB_INVESTIGATION_COMPLETE)[0]).toMatchObject({
			analysis: { proposedSolution: "See task details for more information." },
		});
	});

	it("says why it failed", async () => {
		await investigate(7, []);
		expect(sent(IPC_CHANNELS.GITLAB_INVESTIGATION_ERROR)).toEqual(["Failed to create task from issue"]);

		state.window?.webContents.send.mockClear();
		state.answer = () => {
			throw new Error("403 Forbidden");
		};
		await investigate(7);
		expect(sent(IPC_CHANNELS.GITLAB_INVESTIGATION_ERROR)).toEqual(["403 Forbidden"]);

		state.window?.webContents.send.mockClear();
		state.answer = () => {
			throw "offline";
		};
		await investigate(7);
		expect(sent(IPC_CHANNELS.GITLAB_INVESTIGATION_ERROR)).toEqual(["Investigation failed"]);

		state.window?.webContents.send.mockClear();
		state.config = null;
		await investigate(7);
		expect(sent(IPC_CHANNELS.GITLAB_INVESTIGATION_ERROR)).toEqual(["GitLab not configured"]);
	});

	it("does not investigate a server project's issue here", async () => {
		send(IPC_CHANNELS.GITLAB_INVESTIGATE_ISSUE, "remote", 7);
		await vi.waitFor(() => expect(sent(IPC_CHANNELS.GITLAB_INVESTIGATION_ERROR)).toEqual(["Project not found"]));
		expect(state.fetches).toEqual([]);
	});

	it("tells no one without a window", async () => {
		state.window = null;
		send(IPC_CHANNELS.GITLAB_INVESTIGATE_ISSUE, "unknown", 7);
		await new Promise((resolve) => setImmediate(resolve));
		expect(state.fetches).toEqual([]);
	});
});
