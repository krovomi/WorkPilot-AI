/**
 * @vitest-environment node
 *
 * The Azure DevOps connector is a runner file of the backend: the project
 * folder, the operation and its parameters reach it as arguments, whatever
 * they hold, and its environment keeps no credential but the project's own.
 */

import { EventEmitter } from "node:events";
import path from "node:path";
import { ipcMain } from "electron";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../../shared/constants";

type FakeProcess = EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
type Spawned = { command: string; args: string[]; options: { cwd: string; env: Record<string, string> } };

const state = vi.hoisted(() => ({
	spawned: [] as Spawned[],
	answer: (_proc: FakeProcess): void => undefined,
	project: undefined as
		| { id: string; path: string; autoBuildPath?: string; settings?: Record<string, unknown> }
		| undefined,
	env: {} as Record<string, string>,
}));

vi.mock("node:child_process", async (importOriginal) => {
	const real = await importOriginal<typeof import("node:child_process")>();
	return {
		...real,
		spawn: (command: string, args: string[], options: Spawned["options"]) => {
			state.spawned.push({ command, args, options });
			const proc = Object.assign(new EventEmitter(), {
				stdout: new EventEmitter(),
				stderr: new EventEmitter(),
			}) as FakeProcess;
			queueMicrotask(() => state.answer(proc));
			return proc;
		},
	};
});
vi.mock("../../updater/path-resolver", () => ({ getEffectiveSourcePath: () => "/app/backend" }));
vi.mock("../../utils/connectors-path", () => ({ connectorsRoot: (backend: string) => `${backend}-connectors` }));
vi.mock("../../project-store", () => ({
	projectStore: {
		getProject: (id: string) => (state.project?.id === id ? state.project : undefined),
		getTasks: () => [],
		invalidateTasksCache: vi.fn(),
	},
}));
vi.mock("../../project-env-file", () => ({ readProjectEnv: () => state.env }));

import { azureDevOpsCallArgs, callAzureDevOpsPython } from "../azure-devops-connector";
import { registerAzureDevOpsHandlers } from "../azure-devops-handlers";

const answerWith =
	(stdout: string, code = 0, stderr = "") =>
	(proc: FakeProcess) => {
		if (stdout) proc.stdout.emit("data", Buffer.from(stdout));
		if (stderr) proc.stderr.emit("data", Buffer.from(stderr));
		proc.emit("close", code);
	};

const invoke = <T>(channel: string, ...args: unknown[]) =>
	(ipcMain as unknown as { invokeHandler: (c: string, e: unknown, ...a: unknown[]) => Promise<T> }).invokeHandler(
		channel,
		{},
		...args,
	);

const HOSTILE = `/work/o'neil'); import os; os.system('id'); ('`;

beforeEach(() => {
	state.spawned = [];
	state.answer = answerWith('{"data": {"ok": true}}');
	state.project = { id: "p-1", path: HOSTILE, autoBuildPath: ".workpilot" };
	state.env = {
		AZURE_DEVOPS_PAT: "pat-test-0000", // pragma: allowlist secret
		AZURE_DEVOPS_ORG_URL: "https://dev.azure.com/o",
		AZURE_DEVOPS_PROJECT: "My%20Project",
	};
});

describe("the arguments of a connector call", () => {
	it("are the runner file, then values only", () => {
		const args = azureDevOpsCallArgs(HOSTILE, "get_work_item", { work_item_id: 7 });
		expect(args).toHaveLength(5);
		expect(path.basename(args[0])).toBe("connector_call.py");
		expect(args[0]).toContain(path.join("backend", "runners", "azure_devops"));
		expect(args.slice(1)).toEqual(["/app/backend-connectors", HOSTILE, "get_work_item", '{"work_item_id":7}']);
	});
});

describe("a connector call", () => {
	it("gives the runner's data, run in the folder with the project's settings only", async () => {
		process.env.GITHUB_TOKEN = "ghp-test-0000"; // pragma: allowlist secret
		try {
			await expect(callAzureDevOpsPython("/work/p", "list_work_items", {}, { AZURE_DEVOPS_PAT: "x" })).resolves.toEqual({
				ok: true,
			});
		} finally {
			delete process.env.GITHUB_TOKEN;
		}
		const [call] = state.spawned;
		expect(call.command).toBe("python");
		expect(call.options.cwd).toBe("/work/p");
		expect(call.options.env.AZURE_DEVOPS_PAT).toBe("x");
		expect(call.options.env.PYTHONIOENCODING).toBe("utf-8");
		expect(call.options.env.GITHUB_TOKEN).toBeUndefined();
	});

	it("reads the last line, after anything a library printed", async () => {
		state.answer = answerWith('warning: something\n{"data": [1, 2]}\n');
		await expect(callAzureDevOpsPython("/work/p", "list_work_items")).resolves.toEqual([1, 2]);
	});

	it("rejects with the runner's message", async () => {
		state.answer = answerWith('{"error": "Azure DevOps not configured"}', 1);
		await expect(callAzureDevOpsPython("/work/p", "test_connection")).rejects.toThrow("Azure DevOps not configured");
	});

	it("rejects with what Python said when there is no answer", async () => {
		state.answer = answerWith("", 1, "Traceback: ModuleNotFoundError");
		await expect(callAzureDevOpsPython("/work/p", "test_connection")).rejects.toThrow("ModuleNotFoundError");
		state.answer = answerWith("", 2);
		await expect(callAzureDevOpsPython("/work/p", "test_connection")).rejects.toThrow("Process exited with code 2");
		state.answer = answerWith("not json", 0);
		await expect(callAzureDevOpsPython("/work/p", "test_connection")).rejects.toThrow("not json");
	});

	it("rejects when Python cannot start", async () => {
		state.answer = (proc) => proc.emit("error", new Error("spawn python ENOENT"));
		await expect(callAzureDevOpsPython("/work/p", "test_connection")).rejects.toThrow("ENOENT");
	});
});

describe("the handlers that call the connector", () => {
	beforeAll(() => {
		registerAzureDevOpsHandlers(
			{} as Parameters<typeof registerAzureDevOpsHandlers>[0],
			() => null,
		);
	});

	it("detect the repository without any credential, the folder an argument", async () => {
		state.answer = answerWith('{"data": {"repository": "Shop"}}');
		expect(await invoke(IPC_CHANNELS.AZURE_DEVOPS_DETECT_REPOSITORY, "p-1")).toEqual({
			success: true,
			data: { repository: "Shop" },
		});
		const [call] = state.spawned;
		const folder = path.join(HOSTILE, ".workpilot");
		expect(call.args.slice(2)).toEqual([folder, "detect_repository", "{}"]);
		expect(call.options.env.AZURE_DEVOPS_PAT).toBeUndefined();
	});

	it("say why the repository could not be detected", async () => {
		state.answer = answerWith('{"error": "not a git repository"}', 1);
		expect(await invoke(IPC_CHANNELS.AZURE_DEVOPS_DETECT_REPOSITORY, "p-1")).toEqual({
			success: false,
			error: "not a git repository",
		});
		expect(await invoke(IPC_CHANNELS.AZURE_DEVOPS_DETECT_REPOSITORY, "p-unknown")).toEqual({
			success: false,
			error: "Project not found",
		});
	});

	it("check the connection with the project's credentials in the environment, never in the arguments", async () => {
		state.answer = answerWith('{"data": {"project": "Detected"}}');
		expect(await invoke(IPC_CHANNELS.AZURE_DEVOPS_CHECK_CONNECTION, "p-1")).toEqual({
			success: true,
			data: { connected: true, organizationUrl: "https://dev.azure.com/o", projectName: "Detected" },
		});
		const [call] = state.spawned;
		expect(call.args.join(" ")).not.toContain("pat-test-0000");
		expect(call.options.env).toMatchObject({
			AZURE_DEVOPS_PAT: "pat-test-0000", // pragma: allowlist secret
			AZURE_DEVOPS_PROJECT: "My Project",
		});
	});

	it("pass a work item id and the list options as data", async () => {
		state.answer = answerWith('{"data": {"id": 42}}');
		await invoke(IPC_CHANNELS.AZURE_DEVOPS_GET_WORK_ITEM, "p-1", 42);
		state.answer = answerWith('{"data": []}');
		await invoke(IPC_CHANNELS.AZURE_DEVOPS_GET_WORK_ITEMS, "p-1", undefined, ["Bug"], 5);
		expect(state.spawned.map((call) => call.args.slice(3))).toEqual([
			["get_work_item", '{"work_item_id":42}'],
			["list_work_items", '{"item_types":["Bug"],"max_items":5}'],
		]);
	});
});
