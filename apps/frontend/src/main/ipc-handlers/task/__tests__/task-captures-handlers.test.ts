/**
 * @vitest-environment node
 *
 * The Captures tab over IPC, on real files: the summary read from the spec
 * folder, a published copy served only when the publication lists it, and
 * the runner (a stand-in Node script here) started with arguments main
 * builds itself; an action outside the closed list, a server card or a task
 * without captures never starts it. A server card's copy comes from the
 * server, named by its place in the publication.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	base: "",
	root: "",
	project: {} as Record<string, unknown>,
	tasks: [] as Array<Record<string, unknown>>,
	serverAnswer: { ok: false, error: "unset" } as { ok: boolean; data?: unknown; error?: string },
	serverCalls: [] as string[],
}));

vi.mock("../../../cli-tool-manager", () => ({ getToolPath: (name: string) => name }));
vi.mock("../../../project-store", () => ({
	projectStore: { getProjects: () => [state.project], getTasks: () => state.tasks },
}));
vi.mock("../../../python-env-manager", () => ({
	getConfiguredPythonPath: () => process.execPath,
	pythonEnvManager: { getPythonEnv: () => ({}) },
}));
vi.mock("../../../rate-limit-detector", () => ({
	getBestAvailableProfileEnv: () => ({ env: {} }),
}));
vi.mock("../../../updater/path-resolver", () => ({
	getEffectiveSourcePath: () => path.join(state.base, "backend"),
}));
vi.mock("../../../app-language", () => ({ getAppLanguage: () => "en" }));
// A server card ("srv:<project>:<card>" here) and the server's answer.
vi.mock("../../../server-board-actions", () => ({
	findServerCard: (taskId: string) => {
		const [, projectId, cardId] = taskId.split(":");
		// Its mirror is the test's folder; the card's folder is named by its id.
		return projectId
			? { project: { id: projectId, path: state.root, autoBuildPath: ".workpilot" }, cardId }
			: null;
	},
}));
vi.mock("../../../server-connection", () => ({
	authedFetch: async (url: string) => {
		state.serverCalls.push(url);
		return state.serverAnswer;
	},
}));

import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../../../shared/constants";
import { registerTaskCapturesHandlers } from "../task-captures-handlers";

type Result = { success: boolean; error?: string; data?: Record<string, unknown> | null };
const invoke = (channel: string, ...args: unknown[]): Promise<Result> =>
	(
		ipcMain as unknown as {
			invokeHandler: (c: string, e: unknown, ...a: unknown[]) => Promise<Result>;
		}
	).invokeHandler(channel, {}, ...args);

const SPEC = "001-orders";
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("x")]);
const sent: unknown[][] = [];
registerTaskCapturesHandlers(
	{ isEnvReady: () => true, initialize: vi.fn() } as never,
	() => ({ webContents: { send: (...a: unknown[]) => sent.push(a) } }) as never,
);

const specDir = () => path.join(state.root, ".workpilot", "specs", SPEC);
const backend = () => path.join(state.base, "backend");

function writePublication(publish = "review"): void {
	const dir = path.join(specDir(), "captures");
	mkdirSync(path.join(dir, "published", "task"), { recursive: true });
	writeFileSync(path.join(dir, "published", "task", "web--orders.png"), PNG);
	writeFileSync(
		path.join(dir, "publication.json"),
		JSON.stringify({
			version: 1,
			generatedAt: "2026-11-28T16:00:00+00:00",
			decision: { needed: true, reason: "ui-files" },
			settings: { publish },
			items: [
				{
					key: "web|orders",
					label: "Orders",
					platform: "web",
					after: {
						file: "captures/published/task/web--orders.png",
						signature: "9:9",
						privacy: { status: "clean" },
						publishable: true,
					},
				},
			],
		}),
	);
}

beforeEach(() => {
	state.base = mkdtempSync(path.join(tmpdir(), "wp-captures-ipc-"));
	state.root = path.join(state.base, "repo");
	mkdirSync(specDir(), { recursive: true });
	writeFileSync(path.join(specDir(), "task_metadata.json"), JSON.stringify({ baseBranch: "develop" }));
	mkdirSync(path.join(backend(), "runners"), { recursive: true });
	// The runner's stand-in: notes its argv, approves like the real one, answers one JSON line.
	writeFileSync(
		path.join(backend(), "runners", "pr_captures_runner.py"),
		`const fs = require("node:fs");
const path = require("node:path");
const argv = process.argv.slice(2);
fs.writeFileSync(path.join(__dirname, "call.json"), JSON.stringify(argv));
const spec = path.join(argv[2], ".workpilot", "specs", argv[4], "captures");
if (argv[0] === "approve") fs.writeFileSync(path.join(spec, "approval.json"), JSON.stringify({ signatures: ["9:9"] }));
process.stdout.write(JSON.stringify({ result: { status: "no-pr" } }) + "\\n");
`,
	);
	state.project = { id: "p1", path: state.root, autoBuildPath: ".workpilot", settings: {} };
	state.tasks = [{ id: "task-1", specId: SPEC, metadata: {} }];
	sent.length = 0;
});

afterEach(() => {
	rmSync(state.base, { recursive: true, force: true });
});

const call = () => JSON.parse(readFileSync(path.join(backend(), "runners", "call.json"), "utf-8"));

describe("TASK_CAPTURES_GET", () => {
	it("answers null for a task without captures, and refuses a bad id", async () => {
		expect(await invoke(IPC_CHANNELS.TASK_CAPTURES_GET, "task-1")).toEqual({ success: true, data: null });
		expect((await invoke(IPC_CHANNELS.TASK_CAPTURES_GET, { id: "task-1" })).success).toBe(false);
		expect((await invoke(IPC_CHANNELS.TASK_CAPTURES_GET, "nope")).error).toBe("Task not found");
	});

	it("reads the publication", async () => {
		writePublication();
		const result = await invoke(IPC_CHANNELS.TASK_CAPTURES_GET, "task-1");
		expect(result.data).toMatchObject({ needed: true, publish: "review", approved: false, publishable: 1 });
	});
});

describe("TASK_CAPTURES_IMAGE", () => {
	it("serves a listed copy and refuses any other path", async () => {
		writePublication();
		writeFileSync(path.join(specDir(), "task_metadata.json"), "{}");
		const ok = await invoke(IPC_CHANNELS.TASK_CAPTURES_IMAGE, "task-1", "captures/published/task/web--orders.png");
		expect(ok).toEqual({ success: true, data: { base64: PNG.toString("base64"), mimeType: "image/png" } });
		for (const file of ["task_metadata.json", "../../../../etc/passwd", "captures/published/task/../../publication.json"]) {
			expect(await invoke(IPC_CHANNELS.TASK_CAPTURES_IMAGE, "task-1", file)).toEqual({
				success: false,
				error: "not-listed",
			});
		}
	});
});

describe("TASK_CAPTURES_IMAGE of a server card", () => {
	// Not in the project store: the server card is found by its id alone.
	const CARD = `srv:proj-9:${SPEC}`;
	beforeEach(() => {
		state.tasks = [];
		state.serverCalls = [];
	});

	it("asks the server for the copy by its place, never by its file", async () => {
		writePublication();
		// The mirror has no image: only the server's answer is shown.
		rmSync(path.join(specDir(), "captures", "published"), { recursive: true });
		state.serverAnswer = { ok: true, data: { mimeType: "image/png", data: PNG.toString("base64") } };
		const ok = await invoke(
			IPC_CHANNELS.TASK_CAPTURES_IMAGE,
			CARD,
			"captures/published/task/web--orders.png",
		);
		expect(ok).toEqual({ success: true, data: { base64: PNG.toString("base64"), mimeType: "image/png" } });
		expect(state.serverCalls).toEqual([`/api/board/cards/${SPEC}/captures/0/after?project_id=proj-9`]);
	});

	it("passes on the server's refusal, and asks nothing for a file the publication does not list", async () => {
		writePublication();
		state.serverAnswer = { ok: false, error: "Capture not found" };
		expect(
			await invoke(IPC_CHANNELS.TASK_CAPTURES_IMAGE, CARD, "captures/published/task/web--orders.png"),
		).toEqual({ success: false, error: "Capture not found" });
		expect(
			await invoke(IPC_CHANNELS.TASK_CAPTURES_IMAGE, CARD, "captures/published/task/other.png"),
		).toEqual({ success: false, error: "not-listed" });
		expect(state.serverCalls).toHaveLength(1);
	});

	it("reads its summary from the mirror, and never runs the local runner for it", async () => {
		writePublication();
		expect((await invoke(IPC_CHANNELS.TASK_CAPTURES_GET, CARD)).data).toMatchObject({ publish: "review" });
		expect(await invoke(IPC_CHANNELS.TASK_CAPTURES_ACTION, CARD, "approve")).toEqual({
			success: false,
			error: "server-project",
		});
		expect(() => call()).toThrow();
	});
});

describe("TASK_CAPTURES_ACTION", () => {
	it("starts the runner with main's own arguments and tells the window", async () => {
		writePublication();
		const result = await invoke(IPC_CHANNELS.TASK_CAPTURES_ACTION, "task-1", "approve");
		expect(call()).toEqual([
			"approve",
			"--project-dir",
			state.root,
			"--spec-name",
			SPEC,
			"--target-branch",
			"develop",
		]);
		expect(result.success).toBe(true);
		expect(result.data).toMatchObject({ noPr: true, captures: { approved: true } });
		expect(sent[0]?.[0]).toBe(IPC_CHANNELS.TASK_UPDATED_EVENT);
		expect(sent[0]?.[2]).toMatchObject({ captures: { approved: true } });
	});

	it("refuses an action outside the list, a task without captures or a server card", async () => {
		expect(await invoke(IPC_CHANNELS.TASK_CAPTURES_ACTION, "task-1", "rm -rf")).toEqual({
			success: false,
			error: "invalid-action",
		});
		expect(await invoke(IPC_CHANNELS.TASK_CAPTURES_ACTION, "task-1", "sync")).toEqual({
			success: false,
			error: "no-captures",
		});
		writePublication();
		state.project = { ...state.project, remote: { serverUrl: "https://example.invalid" } };
		expect(await invoke(IPC_CHANNELS.TASK_CAPTURES_ACTION, "task-1", "sync")).toEqual({
			success: false,
			error: "server-project",
		});
		expect(() => call()).toThrow();
	});
});
