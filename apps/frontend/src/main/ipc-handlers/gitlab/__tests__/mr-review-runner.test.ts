/**
 * @vitest-environment node
 *
 * Where the forge reviews find their Python runner: in the app's backend
 * (`runners/github/runner.py`, `runners/gitlab/runner.py`), wherever the app
 * runs from. The GitLab merge request review starts that runner with the
 * backend's Python, on the project's folder.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	project: undefined as unknown,
	run: vi.fn(),
}));
vi.mock("../../../project-store", () => ({ projectStore: { getProject: () => state.project } }));
vi.mock("../../server-review-jobs", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../server-review-jobs")>()),
	serverProjectOf: () => null,
}));
vi.mock("../../../services/page-llm-config", () => ({
	getPageFeatureSettings: () => ({ model: "sonnet", thinkingLevel: "medium" }),
}));
vi.mock("../../github/utils/runner-env", () => ({ getRunnerEnv: async () => ({}) }));
vi.mock("../utils", async (importOriginal) => ({
	...(await importOriginal<typeof import("../utils")>()),
	getGitLabConfig: async () => null,
}));
vi.mock("../../github/utils/subprocess-runner", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../github/utils/subprocess-runner")>()),
	runPythonSubprocess: state.run,
}));

import { type BrowserWindow, app, ipcMain } from "electron";
import { IPC_CHANNELS } from "../../../../shared/constants";
import {
	findAppBackendPath,
	getBackendPath,
	getPythonPath,
	validateGitHubModule,
} from "../../github/utils/subprocess-runner";
import { registerMRReviewHandlers } from "../mr-review-handlers";

let appRoot: string;
let projectDir: string;
const send = vi.fn();
const window = { webContents: { send } } as unknown as BrowserWindow;
const backend = () => path.join(appRoot, "apps", "backend");
const installRunner = (forge: "github" | "gitlab") => {
	mkdirSync(path.join(backend(), "runners", forge), { recursive: true });
	writeFileSync(path.join(backend(), "runners", forge, "runner.py"), "");
};
const review = (channel: string = IPC_CHANNELS.GITLAB_MR_REVIEW) =>
	(ipcMain as unknown as { emit: (c: string, ...a: unknown[]) => boolean }).emit(channel, {}, "p", 3);
const sent = (channel: string) => send.mock.calls.filter((c) => c[0] === channel);

registerMRReviewHandlers(() => window);

beforeEach(() => {
	appRoot = mkdtempSync(path.join(tmpdir(), "forge-app-"));
	projectDir = mkdtempSync(path.join(tmpdir(), "forge-project-"));
	vi.spyOn(process, "cwd").mockReturnValue(appRoot);
	state.project = { id: "p", path: projectDir, autoBuildPath: ".workpilot" };
	state.run.mockReset();
	state.run.mockReturnValue({
		process: { pid: 1, kill: () => true },
		promise: Promise.resolve({ success: false, error: "stopped by the test" }),
	});
	send.mockReset();
});

afterEach(() => {
	vi.restoreAllMocks();
	rmSync(appRoot, { recursive: true, force: true });
	rmSync(projectDir, { recursive: true, force: true });
});

describe("findAppBackendPath", () => {
	it("finds the backend that holds the runner where the app runs from", () => {
		installRunner("gitlab");

		expect(findAppBackendPath(path.join("runners", "gitlab", "runner.py"))).toBe(backend());
		expect(findAppBackendPath(path.join("runners", "github", "runner.py"))).toBeNull();
		expect(getBackendPath()).toBeNull();

		installRunner("github");
		expect(getBackendPath()).toBe(backend());
	});

	it("finds the backend next to the packaged app, and does without the app when there is none", () => {
		const packaged = path.join(appRoot, "resources");
		mkdirSync(path.join(packaged, "backend", "runners", "github"), { recursive: true });
		writeFileSync(path.join(packaged, "backend", "runners", "github", "runner.py"), "");
		vi.spyOn(app, "getAppPath").mockReturnValue(path.join(packaged, "app.asar"));
		expect(getBackendPath()).toBe(path.join(packaged, "backend"));

		vi.spyOn(app, "getAppPath").mockImplementation(() => {
			throw new Error("no app");
		});
		expect(getBackendPath()).toBeNull();
		installRunner("github");
		expect(getBackendPath()).toBe(backend());
	});

	it("tells the GitHub review the app's backend has no runner", async () => {
		const validation = await validateGitHubModule();

		expect(validation).toMatchObject({ valid: false, runnerAvailable: false });
		expect(validation.error).toBe("GitHub automation module not installed: the app's backend has no GitHub runner.");
	});
});

describe("GITLAB_MR_REVIEW", () => {
	it("runs the app's GitLab runner with the backend's Python, on the project", async () => {
		installRunner("gitlab");

		review();
		await vi.waitFor(() => expect(state.run).toHaveBeenCalled());

		const [options] = state.run.mock.calls[0] as [{ pythonPath: string; args: string[]; cwd: string }];
		expect(options.pythonPath).toBe(getPythonPath(backend()));
		expect(options.cwd).toBe(backend());
		expect(options.args.slice(0, 3)).toEqual([
			path.join(backend(), "runners", "gitlab", "runner.py"),
			"--project",
			projectDir,
		]);
		expect(options.args.slice(-2)).toEqual(["review-mr", "3"]);
		await vi.waitFor(() => expect(sent(IPC_CHANNELS.GITLAB_MR_REVIEW_ERROR)).toHaveLength(1));
	});

	it.each([[IPC_CHANNELS.GITLAB_MR_REVIEW], [IPC_CHANNELS.GITLAB_MR_FOLLOWUP_REVIEW]])(
		"%s says the runner is missing when the app's backend has none",
		async (channel) => {
			review(channel);

			await vi.waitFor(() => expect(sent(IPC_CHANNELS.GITLAB_MR_REVIEW_ERROR)).toHaveLength(1));
			expect(JSON.stringify(sent(IPC_CHANNELS.GITLAB_MR_REVIEW_ERROR)[0])).toContain("GitLab runners not found");
			expect(state.run).not.toHaveBeenCalled();
		},
	);
});
