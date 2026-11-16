/**
 * @vitest-environment node
 *
 * The Azure DevOps handlers on a real project folder, the backend runner
 * answered by a fake process: what the renderer may send, what each channel
 * asks the runner, and what an import, a display repair and a criteria sync
 * leave on the disk.
 */

import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ipcMain } from "electron";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../../shared/constants";

type RunnerAnswer = { data?: unknown; error?: string };
type Call = { operation: string; params: Record<string, unknown>; env: Record<string, string>; cwd: string };

const state = vi.hoisted(() => ({
	calls: [] as Call[],
	runner: (_operation: string, _params: Record<string, unknown>): RunnerAnswer => ({ data: null }),
	projects: [] as Array<{ id: string; path: string; autoBuildPath?: string }>,
	tasks: [] as Array<Record<string, unknown>>,
	env: {} as Record<string, string> | Error,
	invalidated: [] as string[],
}));

vi.mock("node:child_process", async (importOriginal) => {
	const real = await importOriginal<typeof import("node:child_process")>();
	return {
		...real,
		spawn: (_command: string, args: string[], options: { cwd: string; env: Record<string, string> }) => {
			const [, , , operation, params] = args;
			const call = { operation, params: JSON.parse(params), env: options.env, cwd: options.cwd };
			state.calls.push(call);
			const proc = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
			queueMicrotask(() => {
				const answer = state.runner(operation, call.params);
				proc.stdout.emit("data", Buffer.from(`${JSON.stringify(answer)}\n`));
				proc.emit("close", answer.error ? 1 : 0);
			});
			return proc;
		},
	};
});
vi.mock("../../updater/path-resolver", () => ({ getEffectiveSourcePath: () => "/app/backend" }));
vi.mock("../../utils/connectors-path", () => ({ connectorsRoot: (backend: string) => `${backend}-connectors` }));
vi.mock("../../project-store", () => ({
	projectStore: {
		getProject: (id: string) => state.projects.find((project) => project.id === id),
		getTasks: () => state.tasks,
		invalidateTasksCache: (id: string) => state.invalidated.push(id),
	},
}));
vi.mock("../../project-env-file", () => ({
	readProjectEnv: () => {
		if (state.env instanceof Error) throw state.env;
		return state.env;
	},
}));

import { azureDevOpsArgsAllowed } from "../azure-devops-ipc-guard";
import { registerAzureDevOpsHandlers } from "../azure-devops-handlers";

const invoke = <T>(channel: string, ...args: unknown[]) =>
	(ipcMain as unknown as { invokeHandler: (c: string, e: unknown, ...a: unknown[]) => Promise<T> }).invokeHandler(
		channel,
		{},
		...args,
	);

const ORG = "https://dev.azure.com/o";
const IMAGE = `${ORG}/_apis/wit/attachments/abc?fileName=shot.png`;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const readJson = (file: string) => JSON.parse(readFileSync(file, "utf-8"));

let root: string;
let specsDir: string;
const fetchMock = vi.fn();

beforeAll(() => {
	registerAzureDevOpsHandlers(
		{} as Parameters<typeof registerAzureDevOpsHandlers>[0],
		() => null,
	);
});

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "ado-handlers-"));
	specsDir = path.join(root, ".workpilot", "specs");
	state.calls = [];
	state.runner = () => ({ data: null });
	state.projects = [
		{ id: "p-1", path: root, autoBuildPath: ".workpilot" },
		{ id: "p-bare", path: root },
	];
	state.tasks = [];
	state.invalidated = [];
	state.env = {
		AZURE_DEVOPS_PAT: "pat-test-0000", // pragma: allowlist secret
		AZURE_DEVOPS_ORG_URL: ORG,
		AZURE_DEVOPS_PROJECT: "Caf%C3%A9 Shop",
	};
	fetchMock.mockReset();
	fetchMock.mockImplementation(async () => new Response(PNG, { headers: { "content-type": "image/png" } }));
	vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	rmSync(root, { recursive: true, force: true });
});

describe("what the renderer may send", () => {
	const allowed = (channel: string, ...args: unknown[]) => azureDevOpsArgsAllowed(channel, ["p-1", ...args]);

	it("takes nothing but the project id where the channel needs nothing else", () => {
		for (const channel of [
			IPC_CHANNELS.AZURE_DEVOPS_CHECK_CONNECTION,
			IPC_CHANNELS.AZURE_DEVOPS_LIST_REPOSITORIES,
			IPC_CHANNELS.AZURE_DEVOPS_DETECT_REPOSITORY,
		]) {
			expect(allowed(channel)).toBe(true);
			expect(allowed(channel, "extra")).toBe(false);
		}
	});

	it("takes list options of their types, within bounds", () => {
		const list = IPC_CHANNELS.AZURE_DEVOPS_GET_WORK_ITEMS;
		expect(allowed(list)).toBe(true);
		expect(allowed(list, undefined, ["Bug", "User Story"], 50)).toBe(true);
		expect(allowed(list, "Shop", undefined, 1000)).toBe(true);
		expect(allowed(list, "", undefined, undefined)).toBe(false);
		expect(allowed(list, undefined, ["Bug", 7])).toBe(false);
		expect(allowed(list, undefined, ["x".repeat(256)])).toBe(false);
		expect(allowed(list, undefined, "Bug")).toBe(false);
		expect(allowed(list, undefined, undefined, 1001)).toBe(false);
		expect(allowed(list, undefined, undefined, -1)).toBe(false);
		expect(allowed(list, undefined, undefined, 5, "extra")).toBe(false);
	});

	it("takes work item ids as positive integers, a list of them bounded", () => {
		expect(allowed(IPC_CHANNELS.AZURE_DEVOPS_GET_WORK_ITEM, 42)).toBe(true);
		expect(allowed(IPC_CHANNELS.AZURE_DEVOPS_GET_WORK_ITEM, "42")).toBe(false);
		expect(allowed(IPC_CHANNELS.AZURE_DEVOPS_GET_WORK_ITEM, 0)).toBe(false);
		expect(allowed(IPC_CHANNELS.AZURE_DEVOPS_GET_WORK_ITEM, 1.5)).toBe(false);
		expect(allowed(IPC_CHANNELS.AZURE_DEVOPS_GET_WORK_ITEM, 42, 43)).toBe(false);

		const imports = IPC_CHANNELS.AZURE_DEVOPS_IMPORT_WORK_ITEMS;
		expect(allowed(imports, [1, 2])).toBe(true);
		expect(allowed(imports, [1], { requireReviewBeforeCoding: true })).toBe(true);
		expect(allowed(imports, [1], {})).toBe(true);
		expect(allowed(imports, [1, "2"])).toBe(false);
		expect(allowed(imports, Array.from({ length: 501 }, (_, i) => i + 1))).toBe(false);
		expect(allowed(imports, [1], { requireReviewBeforeCoding: "yes" })).toBe(false);
		expect(allowed(imports, [1], { specsDir: "/etc" })).toBe(false);
		expect(allowed(imports, [1], null)).toBe(false);
		expect(allowed(imports, [1], [true])).toBe(false);
		expect(allowed(imports, [1], undefined, "extra")).toBe(false);
	});

	it("takes a task id as a bounded text", () => {
		expect(allowed(IPC_CHANNELS.AZURE_DEVOPS_HYDRATE_TASK_DISPLAY, "001-task")).toBe(true);
		expect(allowed(IPC_CHANNELS.AZURE_DEVOPS_HYDRATE_TASK_DISPLAY, "")).toBe(false);
		expect(allowed(IPC_CHANNELS.AZURE_DEVOPS_HYDRATE_TASK_DISPLAY, "001", "x")).toBe(false);
		expect(allowed(IPC_CHANNELS.AZURE_DEVOPS_SYNC_TASK_AC, "001-task", 7)).toBe(true);
		expect(allowed(IPC_CHANNELS.AZURE_DEVOPS_SYNC_TASK_AC, { id: 1 }, 7)).toBe(false);
		expect(allowed(IPC_CHANNELS.AZURE_DEVOPS_SYNC_TASK_AC, "001-task", "7")).toBe(false);
		expect(allowed(IPC_CHANNELS.AZURE_DEVOPS_SYNC_TASK_AC, "001-task", 7, 8)).toBe(false);
	});

	it("refuses an invoke before the handler runs", async () => {
		await expect(invoke(IPC_CHANNELS.AZURE_DEVOPS_GET_WORK_ITEM, "p-1", "1 OR 1=1")).rejects.toThrow(
			"Invalid Azure DevOps arguments",
		);
		expect(state.calls).toEqual([]);
	});
});

describe("checking the connection", () => {
	it("gives the project the runner detected, with the project's credentials in its environment", async () => {
		state.runner = () => ({ data: { project: "Detected" } });
		expect(await invoke(IPC_CHANNELS.AZURE_DEVOPS_CHECK_CONNECTION, "p-1")).toEqual({
			success: true,
			data: { connected: true, organizationUrl: ORG, projectName: "Detected" },
		});
		const [call] = state.calls;
		expect(call.operation).toBe("test_connection");
		expect(call.cwd).toBe(path.join(root, ".workpilot"));
		expect(call.env).toMatchObject({
			AZURE_DEVOPS_PAT: "pat-test-0000", // pragma: allowlist secret
			AZURE_DEVOPS_ORG_URL: ORG,
			AZURE_DEVOPS_PROJECT: "Café Shop",
		});
	});

	it("falls back to the configured project, kept as written when it is not a valid escape", async () => {
		state.env = { AZURE_DEVOPS_PAT: "pat-test-0000", AZURE_DEVOPS_ORG_URL: ORG, AZURE_DEVOPS_PROJECT: "100%" }; // pragma: allowlist secret
		expect(await invoke(IPC_CHANNELS.AZURE_DEVOPS_CHECK_CONNECTION, "p-1")).toEqual({
			success: true,
			data: { connected: true, organizationUrl: ORG, projectName: "100%" },
		});
		state.env = { AZURE_DEVOPS_PAT: "pat-test-0000", AZURE_DEVOPS_ORG_URL: ORG }; // pragma: allowlist secret
		state.runner = () => ({ data: {} });
		const answer = await invoke<{ data: Record<string, unknown> }>(IPC_CHANNELS.AZURE_DEVOPS_CHECK_CONNECTION, "p-1");
		expect(answer.data.projectName).toBeUndefined();
		expect(state.calls[1].env.AZURE_DEVOPS_PROJECT).toBeUndefined();
	});

	it("says not connected, and why, without calling Azure when a setting is missing", async () => {
		const notConfigured = { success: true, data: { connected: false, error: "Azure DevOps not configured" } };
		state.env = { AZURE_DEVOPS_ORG_URL: ORG };
		expect(await invoke(IPC_CHANNELS.AZURE_DEVOPS_CHECK_CONNECTION, "p-1")).toEqual(notConfigured);
		state.env = new Error("unreadable");
		expect(await invoke(IPC_CHANNELS.AZURE_DEVOPS_CHECK_CONNECTION, "p-1")).toEqual(notConfigured);
		expect(await invoke(IPC_CHANNELS.AZURE_DEVOPS_CHECK_CONNECTION, "p-bare")).toEqual(notConfigured);
		expect(await invoke(IPC_CHANNELS.AZURE_DEVOPS_CHECK_CONNECTION, "p-unknown")).toEqual({
			success: false,
			error: "Project not found",
		});
		expect(state.calls).toEqual([]);
	});

	it("says not connected with the runner's message", async () => {
		state.runner = () => ({ error: "TF400813: not authorized" });
		expect(await invoke(IPC_CHANNELS.AZURE_DEVOPS_CHECK_CONNECTION, "p-1")).toEqual({
			success: true,
			data: { connected: false, error: "TF400813: not authorized" },
		});
	});
});

describe("listing", () => {
	it("gives the repositories, or the runner's error", async () => {
		state.runner = () => ({ data: [{ id: "r", name: "Shop" }] });
		expect(await invoke(IPC_CHANNELS.AZURE_DEVOPS_LIST_REPOSITORIES, "p-1")).toEqual({
			success: true,
			data: [{ id: "r", name: "Shop" }],
		});
		state.runner = () => ({ error: "Project name is required to list repositories" });
		expect(await invoke(IPC_CHANNELS.AZURE_DEVOPS_LIST_REPOSITORIES, "p-1")).toEqual({
			success: false,
			error: "Project name is required to list repositories",
		});
		expect(state.calls.map((call) => call.operation)).toEqual(["list_repositories", "list_repositories"]);
	});

	it("needs the organization and the token", async () => {
		state.env = { AZURE_DEVOPS_PAT: "pat-test-0000" }; // pragma: allowlist secret
		const refusal = { success: false, error: "Azure DevOps not configured for this project" };
		expect(await invoke(IPC_CHANNELS.AZURE_DEVOPS_LIST_REPOSITORIES, "p-1")).toEqual(refusal);
		expect(await invoke(IPC_CHANNELS.AZURE_DEVOPS_GET_WORK_ITEMS, "p-1")).toEqual(refusal);
		expect(await invoke(IPC_CHANNELS.AZURE_DEVOPS_GET_WORK_ITEM, "p-1", 3)).toEqual(refusal);
		expect(await invoke(IPC_CHANNELS.AZURE_DEVOPS_GET_WORK_ITEM, "p-unknown", 3)).toEqual({
			success: false,
			error: "Project not found",
		});
		expect(state.calls).toEqual([]);
	});

	it("asks for a hundred work items unless told otherwise", async () => {
		state.runner = () => ({ data: [] });
		expect(await invoke(IPC_CHANNELS.AZURE_DEVOPS_GET_WORK_ITEMS, "p-1")).toEqual({ success: true, data: [] });
		expect(state.calls[0].params).toEqual({ max_items: 100 });
		state.runner = () => ({ error: "boom" });
		expect(await invoke(IPC_CHANNELS.AZURE_DEVOPS_GET_WORK_ITEM, "p-1", 3)).toEqual({ success: false, error: "boom" });
	});

	it("detects the repository with no credential, or says why it could not", async () => {
		state.runner = () => ({ error: "not a git repository" });
		expect(await invoke(IPC_CHANNELS.AZURE_DEVOPS_DETECT_REPOSITORY, "p-bare")).toEqual({
			success: false,
			error: "not a git repository",
		});
		expect(state.calls[0].cwd).toBe(root);
		expect(state.calls[0].env.AZURE_DEVOPS_PAT).toBeUndefined();
		expect(await invoke(IPC_CHANNELS.AZURE_DEVOPS_DETECT_REPOSITORY, "p-unknown")).toEqual({
			success: false,
			error: "Project not found",
		});
	});
});

const BUG = {
	id: 42,
	title: "<b>Fenêtre</b>\n  qui   clignote",
	workItemType: "Bug",
	state: "Active",
	priority: 1,
	url: "https://dev.azure.com/o/_workitems/edit/42",
	areaPath: "Shop\\Front",
	iterationPath: "Shop\\Sprint 3",
	tags: ["ui", "flaky"],
	description: `<p>Steps</p><img src="${IMAGE}">`,
	acceptanceCriteria: "<ul><li>No flicker</li><li>Same size</li></ul>",
};
const STORY = { id: 43, title: "<i></i>", workItemType: "User Story", state: "New", priority: 3, url: "javascript:alert(1)" };

describe("importing work items", () => {
	it("writes one spec folder per chosen work item, numbered after the existing ones", async () => {
		mkdirSync(path.join(specsDir, "007-older"), { recursive: true });
		writeFileSync(path.join(specsDir, "012-a-file"), "");
		mkdirSync(path.join(specsDir, "notes"));
		state.runner = () => ({ data: [BUG, STORY, { ...BUG, id: 99 }] });

		const answer = await invoke<{ success: boolean; data: Record<string, unknown> }>(
			IPC_CHANNELS.AZURE_DEVOPS_IMPORT_WORK_ITEMS,
			"p-1",
			[43, 42],
			{ requireReviewBeforeCoding: true },
		);

		expect(state.calls[0]).toMatchObject({ operation: "list_work_items", params: { max_items: 1000 } });
		expect(answer.success).toBe(true);
		expect(answer.data).toMatchObject({ success: true, imported: 2, failed: 0, errors: undefined });
		expect(readdirSync(specsDir).sort()).toEqual(["007-older", "008-fenetre-qui-clignote", "009-task", "012-a-file", "notes"]);
		expect(state.invalidated).toEqual(["p-1"]);

		const bugDir = path.join(specsDir, "008-fenetre-qui-clignote");
		const requirements = readJson(path.join(bugDir, "requirements.json"));
		expect(requirements.display_title).toBe("Fenêtre qui clignote");
		expect(requirements.workflow_type).toBe("bugfix");
		expect(requirements.acceptance_criteria).toEqual(["No flicker", "Same size"]);
		expect(requirements.display_description).toContain(`data:image/png;base64,${PNG.toString("base64")}`);
		expect(requirements.display_description).not.toContain(IMAGE);
		expect(requirements.task_description).toBe(
			[
				"# Fenêtre qui clignote",
				"",
				"**Source:** Azure DevOps Bug ADO-42",
				"**State:** Active",
				"**Priority:** 1",
				"**Area:** Shop\\Front",
				"**Iteration:** Shop\\Sprint 3",
				"**Tags:** ui, flaky",
				"",
				"## Description",
				"",
				"Steps",
				"",
				"## Acceptance Criteria",
				"",
				"- No flicker",
				"- Same size",
			].join("\n"),
		);
		expect(readJson(path.join(bugDir, "task_metadata.json"))).toEqual({
			sourceType: "imported",
			category: "bug_fix",
			priority: "high",
			azureDevOpsIdentifier: "ADO-42",
			azureDevOpsUrl: BUG.url,
			azureDevOpsState: "Active",
			azureDevOpsType: "Bug",
			acceptanceCriteria: ["No flicker", "Same size"],
			requireReviewBeforeCoding: true,
		});
		expect(readdirSync(path.join(bugDir, "attachments"))).toEqual(["ado-42-image-1.png"]);
		expect(fetchMock).toHaveBeenCalledWith(IMAGE, expect.anything());

		const storyDir = path.join(specsDir, "009-task");
		const story = readJson(path.join(storyDir, "requirements.json"));
		expect(story).toEqual({ task_description: expect.stringContaining("## Description\n\n"), workflow_type: "feature" });
		expect(readJson(path.join(storyDir, "task_metadata.json"))).toMatchObject({
			category: "feature",
			priority: "low",
			azureDevOpsUrl: "",
		});
		expect(existsSync(path.join(storyDir, "implementation_plan.json"))).toBe(false);

		const tasks = answer.data.tasks as Array<Record<string, unknown>>;
		expect(tasks.map((task) => [task.id, task.title, task.status, task.projectId])).toEqual([
			["008-fenetre-qui-clignote", "Fenêtre qui clignote", "backlog", "p-1"],
			["009-task", "", "backlog", "p-1"],
		]);
		expect(tasks[0].description).toBe(requirements.display_description);
	});

	it("maps the other types and priorities, and keeps the plain description when there is no rich one", async () => {
		state.runner = () => ({
			data: [
				{ id: 1, title: "A", workItemType: "constructor", priority: 2, description: "plain words" },
				{ id: 2, title: "B", workItemType: "Feature" },
			],
		});
		await invoke(IPC_CHANNELS.AZURE_DEVOPS_IMPORT_WORK_ITEMS, "p-1", [1, 2]);
		const first = path.join(specsDir, "001-a");
		expect(readJson(path.join(first, "task_metadata.json"))).toMatchObject({ category: "feature", priority: "medium" });
		expect(readJson(path.join(first, "requirements.json")).task_description).toContain("## Description\n\nplain words");
		expect(readJson(path.join(specsDir, "002-b", "task_metadata.json"))).toMatchObject({
			category: "feature",
			priority: "medium",
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("reports the work items it could not import and goes on with the others", async () => {
		state.runner = () => ({ data: [{ id: 5, title: "Broken" }, { ...STORY, id: 6, title: "Fine" }] });
		const answer = await invoke<{ data: Record<string, unknown> }>(IPC_CHANNELS.AZURE_DEVOPS_IMPORT_WORK_ITEMS, "p-1", [5, 6]);
		expect(answer.data).toMatchObject({ imported: 1, failed: 1 });
		expect(answer.data.errors).toEqual([expect.stringMatching(/^Failed to import work item 5: /)]);
		expect(readdirSync(specsDir)).toContain("002-fine");
	});

	it("says what stops it before writing anything", async () => {
		state.runner = () => ({ data: [BUG] });
		expect(await invoke(IPC_CHANNELS.AZURE_DEVOPS_IMPORT_WORK_ITEMS, "p-1", [7])).toEqual({
			success: false,
			error: "No matching work items found",
		});
		state.runner = () => ({ error: "TF401019" });
		expect(await invoke(IPC_CHANNELS.AZURE_DEVOPS_IMPORT_WORK_ITEMS, "p-1", [42])).toEqual({
			success: false,
			error: "TF401019",
		});
		expect(await invoke(IPC_CHANNELS.AZURE_DEVOPS_IMPORT_WORK_ITEMS, "p-bare", [42])).toEqual({
			success: false,
			error: "Project not found or not initialized",
		});
		state.env = {};
		expect(await invoke(IPC_CHANNELS.AZURE_DEVOPS_IMPORT_WORK_ITEMS, "p-1", [42])).toEqual({
			success: false,
			error: "Azure DevOps not configured",
		});
		expect(existsSync(specsDir)).toBe(false);
	});
});

/** An imported task's spec folder holding `requirements`, registered as a task of p-1. */
function importedTask(requirements: unknown, identifier = "ADO-42", id = "008-task"): string {
	const specDir = path.join(specsDir, id);
	mkdirSync(specDir, { recursive: true });
	const text = typeof requirements === "string" ? requirements : JSON.stringify(requirements);
	writeFileSync(path.join(specDir, "requirements.json"), text);
	writeFileSync(path.join(specDir, "task_metadata.json"), JSON.stringify({ azureDevOpsIdentifier: identifier }));
	state.tasks.push({ id, specsPath: specDir, metadata: { azureDevOpsIdentifier: identifier } });
	return path.join(specDir, "requirements.json");
}

describe("repairing the display of an imported task", () => {
	const hydrate = (taskId = "008-task") =>
		invoke<{ success: boolean; data?: { html: string; title?: string }; error?: string }>(
			IPC_CHANNELS.AZURE_DEVOPS_HYDRATE_TASK_DISPLAY,
			"p-1",
			taskId,
		);

	it("fetches a missing title, inlines the images, and writes both", async () => {
		const file = importedTask({ task_description: `<p>Old</p><img src="${IMAGE}">`, workflow_type: "bugfix" });
		state.runner = () => ({ data: { id: 42, title: "<b>Fenêtre</b>   cassée" } });

		const answer = await hydrate();

		expect(state.calls[0]).toMatchObject({ operation: "get_work_item", params: { work_item_id: 42 } });
		expect(answer.data?.title).toBe("Fenêtre cassée");
		expect(answer.data?.html).toContain("data:image/png;base64,");
		expect(readJson(file)).toEqual({
			task_description: `<p>Old</p><img src="${IMAGE}">`,
			workflow_type: "bugfix",
			display_title: "Fenêtre cassée",
			display_description: answer.data?.html,
		});
		expect(state.invalidated).toEqual(["p-1"]);
	});

	it("keeps what was written to the file while Azure DevOps answered", async () => {
		const file = importedTask({ display_title: "Titre", task_description: `<img src="${IMAGE}">` });
		fetchMock.mockImplementation(async () => {
			writeFileSync(file, JSON.stringify({ ...readJson(file), acceptance_criteria: ["Synced meanwhile"] }));
			return new Response(PNG, { headers: { "content-type": "image/png" } });
		});

		const answer = await hydrate();

		expect(state.calls).toEqual([]);
		expect(answer.data?.title).toBe("Titre");
		expect(readJson(file)).toMatchObject({
			display_title: "Titre",
			acceptance_criteria: ["Synced meanwhile"],
			display_description: answer.data?.html,
		});
	});

	it("strips the images it cannot load, and fetches nothing without a token", async () => {
		state.env = { AZURE_DEVOPS_ORG_URL: ORG };
		const file = importedTask({ display_description: `<p>Kept</p><img src="${IMAGE}"><img src="data:image/png;base64,AA">` });
		const answer = await hydrate();
		expect(answer).toEqual({
			success: true,
			data: { html: '<p>Kept</p><img src="data:image/png;base64,AA">', title: undefined },
		});
		expect(fetchMock).not.toHaveBeenCalled();
		expect(state.calls).toEqual([]);
		expect(readJson(file).display_description).toBe(answer.data?.html);
	});

	it("writes nothing when there is nothing to repair", async () => {
		const text = JSON.stringify({ display_title: "Done", display_description: "<p>No image</p>" });
		const file = importedTask(text);
		expect(await hydrate()).toEqual({ success: true, data: { html: "<p>No image</p>", title: "Done" } });
		expect(readFileSync(file, "utf-8")).toBe(text);

		const inlined = JSON.stringify({ display_title: "Done", display_description: '<img src="data:image/png;base64,AA">' });
		const second = importedTask(inlined, "ADO-42", "009-inlined");
		expect((await hydrate("009-inlined")).data?.html).toBe('<img src="data:image/png;base64,AA">');
		expect(readFileSync(second, "utf-8")).toBe(inlined);
		importedTask({ display_title: "Bare" }, "ADO-42", "010-bare");
		expect(await hydrate("010-bare")).toEqual({ success: true, data: { html: "", title: "Bare" } });
		expect(fetchMock).not.toHaveBeenCalled();
		expect(state.invalidated).toEqual([]);
	});

	it("goes on without the title when it cannot be fetched", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		importedTask({ task_description: "plain" });
		state.runner = () => ({ error: "TF401232: work item does not exist" });
		expect(await hydrate()).toEqual({ success: true, data: { html: "plain", title: undefined } });
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("Title fetch failed"), "TF401232: work item does not exist");

		state.runner = () => ({ data: { id: 42 } });
		expect(await hydrate()).toEqual({ success: true, data: { html: "plain", title: undefined } });
	});

	it("asks for no title when the task does not name its work item", async () => {
		importedTask({ task_description: "plain" }, "42; rm -rf", "001-a");
		importedTask({ task_description: "plain" }, `ADO-${"9".repeat(400)}`, "002-b");
		expect((await hydrate("001-a")).success).toBe(true);
		expect((await hydrate("002-b")).success).toBe(true);
		expect(state.calls).toEqual([]);
	});

	it("says when the file it writes to went away, and still answers", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const file = importedTask({ task_description: `<img src="${IMAGE}">` });
		fetchMock.mockImplementation(async () => {
			rmSync(file);
			mkdirSync(file);
			return new Response(PNG, { headers: { "content-type": "image/png" } });
		});
		expect((await hydrate()).success).toBe(true);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("Could not persist"), expect.any(String));
	});

	it("leaves a file that stopped being an object as it is", async () => {
		const file = importedTask({ display_title: "T", task_description: `<img src="${IMAGE}">` });
		fetchMock.mockImplementation(async () => {
			writeFileSync(file, "[]");
			return new Response(PNG, { headers: { "content-type": "image/png" } });
		});
		expect((await hydrate()).success).toBe(true);
		expect(readFileSync(file, "utf-8")).toBe("[]");
	});

	it("says why it cannot", async () => {
		expect(
			await invoke(IPC_CHANNELS.AZURE_DEVOPS_HYDRATE_TASK_DISPLAY, "p-unknown", "008-task"),
		).toEqual({ success: false, error: "Project not found" });
		expect(await hydrate("missing")).toEqual({ success: false, error: "Task spec directory not found" });
		state.tasks.push({ id: "gone", specsPath: path.join(root, "gone") });
		expect(await hydrate("gone")).toEqual({ success: false, error: "requirements.json not found" });
		importedTask("{not json", "ADO-1", "003-broken");
		importedTask("null", "ADO-1", "004-null");
		importedTask('["a"]', "ADO-1", "005-list");
		for (const id of ["003-broken", "004-null", "005-list"]) {
			expect(await hydrate(id)).toEqual({ success: false, error: "requirements.json is malformed" });
		}
	});
});

describe("syncing the acceptance criteria of an imported task", () => {
	const sync = (taskId: string, workItemId: number) =>
		invoke(IPC_CHANNELS.AZURE_DEVOPS_SYNC_TASK_AC, "p-1", taskId, workItemId);

	it("reads them from the task's work item and writes them into its metadata and requirements", async () => {
		const file = importedTask({ task_description: "x", acceptance_criteria: ["Old"] });
		state.runner = () => ({ data: { id: 42, acceptanceCriteria: "<ul><li>New one</li><li>Two</li></ul>" } });

		expect(await sync("008-task", 42)).toEqual({ success: true, data: { acceptanceCriteria: ["New one", "Two"] } });

		expect(state.calls[0]).toMatchObject({ operation: "get_work_item", params: { work_item_id: 42 } });
		expect(readJson(file)).toEqual({ task_description: "x", acceptance_criteria: ["New one", "Two"] });
		expect(readJson(path.join(path.dirname(file), "task_metadata.json"))).toEqual({
			azureDevOpsIdentifier: "ADO-42",
			acceptanceCriteria: ["New one", "Two"],
		});
		expect(state.invalidated).toEqual(["p-1"]);
	});

	it("takes no work item but the one the task came from", async () => {
		importedTask({ task_description: "x" });
		const refusal = { success: false, error: "This task was not imported from that work item" };
		expect(await sync("008-task", 7)).toEqual(refusal);
		expect(await sync("unknown", 42)).toEqual(refusal);
		state.tasks.push({ id: "manual", specsPath: path.join(specsDir, "008-task") });
		expect(await sync("manual", 42)).toEqual(refusal);
		expect(state.calls).toEqual([]);
	});

	it("gives the criteria without writing when the task has no folder, and an empty list when there are none", async () => {
		state.tasks.push({ id: "loose", metadata: { azureDevOpsIdentifier: "ado-9" } });
		state.runner = () => ({ data: { id: 9 } });
		expect(await sync("loose", 9)).toEqual({ success: true, data: { acceptanceCriteria: [] } });
		expect(state.invalidated).toEqual([]);
	});

	it("leaves a file that is not an object as it is", async () => {
		const file = importedTask("[1]");
		state.runner = () => ({ data: { id: 42, acceptanceCriteria: "<ul><li>A</li></ul>" } });
		expect(await sync("008-task", 42)).toEqual({ success: true, data: { acceptanceCriteria: ["A"] } });
		expect(readFileSync(file, "utf-8")).toBe("[1]");
	});

	it("says why it cannot", async () => {
		importedTask({ task_description: "x" });
		state.runner = () => ({ error: "TF401232" });
		expect(await sync("008-task", 42)).toEqual({ success: false, error: "TF401232" });
		expect(await invoke(IPC_CHANNELS.AZURE_DEVOPS_SYNC_TASK_AC, "p-bare", "008-task", 42)).toEqual({
			success: false,
			error: "Project not found or not initialized",
		});
		state.env = { AZURE_DEVOPS_PAT: "pat-test-0000" }; // pragma: allowlist secret
		expect(await sync("008-task", 42)).toEqual({ success: false, error: "Azure DevOps not configured" });
	});
});
