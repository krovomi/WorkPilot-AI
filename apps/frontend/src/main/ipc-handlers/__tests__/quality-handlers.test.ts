import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	handlers: new Map<string, (...args: unknown[]) => unknown>(),
	spawned: [] as { cmd: string; args: string[]; env: Record<string, string> }[],
	stdout: "",
}));

vi.mock("electron", () => ({
	app: { isPackaged: false, getAppPath: () => "/repo/apps/frontend" },
	ipcMain: {
		handle: (channel: string, fn: (...args: unknown[]) => unknown) => state.handlers.set(channel, fn),
	},
}));
vi.mock("../../app-logger", () => ({ logger: { warn: vi.fn(), info: vi.fn() } }));
vi.mock("../../python-env-manager", () => ({
	pythonEnvManager: { getPythonPath: () => "/venv/bin/python" },
}));
vi.mock("../../project-store", () => ({
	projectStore: {
		getProject: (id: string) => (id === "p1" ? { id: "p1", path: "/work/shop" } : undefined),
	},
}));
vi.mock("node:child_process", () => ({
	spawn: vi.fn((cmd: string, args: string[], options: { env: Record<string, string> }) => {
		state.spawned.push({ cmd, args, env: options.env });
		const listeners: Record<string, (arg?: unknown) => void> = {};
		const proc = {
			stdout: { on: (_: string, fn: (d: Buffer) => void) => queueMicrotask(() => fn(Buffer.from(state.stdout))) },
			stderr: { on: vi.fn() },
			on: (event: string, fn: (arg?: unknown) => void) => {
				listeners[event] = fn;
				if (event === "close") setTimeout(() => fn(0), 0);
			},
		};
		return proc;
	}),
}));

import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import { parseQualityOutput, setupQualityHandlers } from "../quality-handlers";

describe("PR quality score", () => {
	beforeEach(() => {
		state.handlers.clear();
		state.spawned = [];
		state.stdout = 'QUALITY_RESULT:{"overall_score": 92, "grade": "A"}\n';
		setupQualityHandlers();
	});

	it("runs the backend's runner in the project the id names", async () => {
		const handler = state.handlers.get(IPC_CHANNELS.QUALITY_ANALYZE_PR);
		const score = await handler?.({}, { prNumber: 7, changedFiles: ["a.py", 3], projectId: "p1" });
		expect(score).toEqual({ overall_score: 92, grade: "A" });
		const [run] = state.spawned;
		expect(run.cmd).toBe("/venv/bin/python");
		expect(run.args[0].replaceAll("\\", "/")).toBe("/repo/apps/backend/runners/quality_score_runner.py");
		expect(run.args.slice(1)).toEqual(["--project-dir", "/work/shop", "--files", "a.py"]);
	});

	it("refuses a project it does not know, and never takes a path", async () => {
		const handler = state.handlers.get(IPC_CHANNELS.QUALITY_ANALYZE_PR);
		await expect(
			handler?.({}, { prNumber: 7, changedFiles: ["a.py"], projectId: "/etc" }),
		).rejects.toThrow("Unknown project");
		expect(state.spawned).toEqual([]);
	});

	it("passes no credential to the runner", async () => {
		process.env.ANTHROPIC_API_KEY = "sk-test";
		try {
			await state.handlers.get(IPC_CHANNELS.QUALITY_ANALYZE)?.({}, { files: ["a.py"], projectId: "p1" });
			expect(state.spawned[0].env.ANTHROPIC_API_KEY).toBeUndefined();
		} finally {
			delete process.env.ANTHROPIC_API_KEY;
		}
	});

	it("reads the runner's error", () => {
		expect(() => parseQualityOutput("QUALITY_ERROR:Project directory not found\n")).toThrow(
			"Project directory not found",
		);
		expect(() => parseQualityOutput("noise\n")).toThrow("no result");
	});
});
