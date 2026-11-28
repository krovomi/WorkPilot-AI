/**
 * @vitest-environment node
 *
 * The auto-fix configuration in `.workpilot/github/config.json`, as the
 * renderer reads and saves it: the runner's other settings are kept, a token
 * is never written there (the runner gets its tokens elsewhere), and an
 * auto-fix start the guard refuses never reaches its handler.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ project: undefined as unknown }));
vi.mock("../../../project-store", () => ({ projectStore: { getProject: () => state.project } }));

import { type BrowserWindow, ipcMain } from "electron";
import { IPC_CHANNELS } from "../../../../shared/constants";
import type { AgentManager } from "../../../agent/agent-manager";
import { registerAutoFixHandlers } from "../autofix-handlers";

const mock = ipcMain as unknown as {
	invokeHandler: (c: string, e: unknown, ...a: unknown[]) => Promise<unknown>;
	emit: (c: string, ...a: unknown[]) => boolean;
};
const send = vi.fn();
const window = { webContents: { send } } as unknown as BrowserWindow;
registerAutoFixHandlers({} as AgentManager, () => window);

const CONFIG = {
	enabled: true,
	labels: ["auto-fix", "bug"],
	requireHumanApproval: false,
	model: "sonnet",
	thinkingLevel: "high",
};

let projectDir: string;
const configFile = () => path.join(projectDir, ".workpilot", "github", "config.json");

beforeEach(() => {
	projectDir = mkdtempSync(path.join(tmpdir(), "autofix-config-"));
	state.project = { id: "p", path: projectDir, autoBuildPath: ".workpilot" };
	send.mockReset();
});

afterEach(() => {
	rmSync(projectDir, { recursive: true, force: true });
});

describe("GITHUB_AUTOFIX_SAVE_CONFIG", () => {
	it("keeps the runner's other settings and drops any token found in the file", async () => {
		mkdirSync(path.dirname(configFile()), { recursive: true });
		writeFileSync(
			configFile(),
			JSON.stringify({ pr_review_enabled: true, bot_token: "ghp-test-0000", token: "ghp-test-1111" }),
		);

		await expect(mock.invokeHandler(IPC_CHANNELS.GITHUB_AUTOFIX_SAVE_CONFIG, {}, "p", CONFIG)).resolves.toBe(true);

		expect(JSON.parse(readFileSync(configFile(), "utf-8"))).toEqual({
			pr_review_enabled: true,
			auto_fix_enabled: true,
			auto_fix_labels: ["auto-fix", "bug"],
			require_human_approval: false,
			model: "sonnet",
			thinking_level: "high",
		});
		await expect(mock.invokeHandler(IPC_CHANNELS.GITHUB_AUTOFIX_GET_CONFIG, {}, "p")).resolves.toEqual(CONFIG);
	});

	it("refuses a configuration of another shape, and writes nothing", async () => {
		await expect(
			mock.invokeHandler(IPC_CHANNELS.GITHUB_AUTOFIX_SAVE_CONFIG, {}, "p", { ...CONFIG, labels: "auto-fix" }),
		).rejects.toThrow("Invalid auto-fix arguments");
		await expect(mock.invokeHandler(IPC_CHANNELS.GITHUB_AUTOFIX_GET_CONFIG, {}, "p")).resolves.toMatchObject({
			enabled: false,
			labels: ["auto-fix"],
		});
	});
});

describe("GITHUB_AUTOFIX_START", () => {
	it("starts on an issue number, and drops anything else", async () => {
		mock.emit(IPC_CHANNELS.GITHUB_AUTOFIX_START, {}, "p", "7/../../user");
		mock.emit(IPC_CHANNELS.GITHUB_AUTOFIX_START, {}, "p", 7);

		await vi.waitFor(() => expect(send).toHaveBeenCalled());
		expect(send).toHaveBeenCalledTimes(1);
		expect(send).toHaveBeenCalledWith(IPC_CHANNELS.GITHUB_AUTOFIX_ERROR, "p", {
			error: "No GitHub configuration found",
		});
	});
});
