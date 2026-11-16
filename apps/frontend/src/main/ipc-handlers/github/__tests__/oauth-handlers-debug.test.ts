/**
 * @vitest-environment node
 *
 * Under DEBUG=true the gh sign-in handlers say what they do on the console,
 * and a token gh hands over is not among what they say.
 */

import { afterAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
	process.env.DEBUG = "true";
});

vi.mock("node:child_process", () => {
	const execFileSync = vi.fn((_command: string, args: string[]) => {
		if (args.join(" ") === "auth token") return "gho-test-0000\n";
		throw new Error("not installed");
	});
	const module = { execFileSync, execFile: vi.fn(), spawn: vi.fn() };
	return { ...module, default: module };
});
vi.mock("../../../cli-tool-manager", () => ({ getToolPath: (tool: string) => tool }));
vi.mock("../../../env-utils", () => ({
	findExecutable: () => null,
	getAugmentedEnv: () => ({}),
}));

import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../../../shared/constants";
import { registerGithubOAuthHandlers } from "../oauth-handlers";

const invoke = (channel: string, ...args: unknown[]): Promise<unknown> =>
	(
		ipcMain as unknown as {
			invokeHandler: (c: string, e: unknown, ...a: unknown[]) => Promise<unknown>;
		}
	).invokeHandler(channel, {}, ...args);

afterAll(() => {
	delete process.env.DEBUG;
});

describe("debug logging", () => {
	it("writes each step, with and without data, and never the token", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		registerGithubOAuthHandlers();

		await invoke(IPC_CHANNELS.GITHUB_CHECK_CLI);
		await invoke(IPC_CHANNELS.GITHUB_GET_TOKEN);
		await invoke(IPC_CHANNELS.GITHUB_GET_BRANCHES, "acme/shop", "");

		expect(warn).toHaveBeenCalledWith("[GitHub OAuth] Registering GitHub OAuth handlers");
		expect(warn).toHaveBeenCalledWith(
			"[GitHub OAuth] getGitHubBranches handler called",
			{ repo: "acme/shop" },
		);
		expect(JSON.stringify(warn.mock.calls)).not.toContain("gho-test-0000");
		warn.mockRestore();
	});
});
