/**
 * @vitest-environment node
 *
 * The CI/CD Triggers handlers check the renderer's request before the runner
 * starts: a provider the runner knows, plain values for the PR, branch and
 * workflow, digits for a provider's run id, a bounded number of runs.
 */

import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
	projects: [] as Array<{ id: string; path: string; autoBuildPath: string }>,
	spawned: [] as string[][],
}));

vi.mock("electron", async () => {
	const { sharedFakeSafeStorage } = await import("../../../__tests__/helpers/fake-safe-storage");
	return {
		app: { getPath: () => tmpdir(), getAppPath: () => tmpdir(), isPackaged: false },
		safeStorage: sharedFakeSafeStorage().safeStorage,
		ipcMain: {
			handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) =>
				state.handlers.set(channel, handler),
		},
	};
});

vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:child_process")>()),
	spawn: (_cmd: string, args: string[]) => {
		state.spawned.push(args);
		const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
		proc.stdout = new EventEmitter();
		proc.stderr = new EventEmitter();
		setTimeout(() => {
			proc.stdout.emit("data", Buffer.from("{}"));
			proc.emit("close", 0);
		}, 0);
		return proc;
	},
}));

vi.mock("../../project-store", () => ({
	projectStore: { getProjects: () => state.projects },
}));
vi.mock("../../python-env-manager", () => ({ getConfiguredPythonPath: () => "python3" }));

import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import { registerCICDTriggersHandlers } from "../cicd-triggers-handlers";

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
	const handler = state.handlers.get(channel);
	if (!handler) throw new Error(`no handler for ${channel}`);
	return Promise.resolve(handler({}, ...args));
}

describe("CI/CD Triggers handler inputs", () => {
	let projectDir: string;

	beforeEach(() => {
		projectDir = mkdtempSync(path.join(tmpdir(), "cicd-inputs-"));
		state.projects = [{ id: "p1", path: projectDir, autoBuildPath: ".workpilot" }];
		state.spawned = [];
		state.handlers.clear();
		registerCICDTriggersHandlers();
	});

	afterEach(() => {
		rmSync(projectDir, { recursive: true, force: true });
	});

	it.each([
		null,
		{ provider: "circleci" },
		{ provider: "github", branch: "--project=/etc" },
		{ provider: "github", workflow: "../../user/repos" },
		{ provider: "github", pr_url: "file:///etc/hosts" },
	])("refuses the trigger request %j and starts nothing", async (params) => {
		expect(await invoke(IPC_CHANNELS.CICD_TRIGGERS_TRIGGER, projectDir, params)).toEqual({
			success: false,
			error: "Invalid trigger request",
		});
		expect(state.spawned).toEqual([]);
	});

	it("passes a checked request to the runner", async () => {
		await invoke(IPC_CHANNELS.CICD_TRIGGERS_TRIGGER, projectDir, {
			provider: "github",
			branch: "feature/login",
			pr_url: "https://github.com/acme/shop/pull/3",
			workflow: "deploy.yml",
			extra: "--ignored",
		});
		const [args] = state.spawned;
		expect(args.slice(args.indexOf("--action"))).toEqual([
			"--action",
			"trigger",
			"--provider",
			"github",
			"--project",
			projectDir,
			"--pr-url",
			"https://github.com/acme/shop/pull/3",
			"--branch",
			"feature/login",
			"--workflow",
			"deploy.yml",
			"--output-json",
		]);
	});

	it.each([IPC_CHANNELS.CICD_TRIGGERS_GET_RUN_STATUS, IPC_CHANNELS.CICD_TRIGGERS_CANCEL_RUN])(
		"%s takes a provider's run id, digits only",
		async (channel) => {
			for (const id of ["--project=/etc", "5/../../user", "", 5]) {
				expect(await invoke(channel, projectDir, id)).toEqual({ success: false, error: "Invalid run id" });
			}
			expect(await invoke(channel, "/elsewhere", "5")).toMatchObject({ success: false });
			expect(state.spawned).toEqual([]);
			await invoke(channel, projectDir, "123");
			expect(state.spawned[0].slice(-5)).toEqual(["--run-id", "123", "--project", projectDir, "--output-json"]);
		},
	);

	it("lists a bounded number of runs", async () => {
		mkdirSync(path.join(projectDir, ".workpilot"), { recursive: true });
		const runs = Array.from({ length: 60 }, (_, i) => ({ id: String(i) }));
		writeFileSync(path.join(projectDir, ".workpilot", "cicd_runs.json"), JSON.stringify(runs), "utf-8");
		const count = async (limit: unknown) =>
			((await invoke(IPC_CHANNELS.CICD_TRIGGERS_LIST_RUNS, projectDir, limit)) as { data: unknown[] }).data.length;
		expect(await count(5)).toBe(5);
		expect(await count("5")).toBe(50);
		expect(await count(undefined)).toBe(50);
	});
});
