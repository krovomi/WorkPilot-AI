/**
 * @vitest-environment node
 *
 * The glab CLI sign-in of the GitLab settings, against a stand-in glab
 * (child_process). The renderer names an instance by its host, as the
 * settings page sends it; every command is an argument list run by glab's
 * resolved path; the browser is opened by the main process on the instance's
 * host only; the renderer learns that glab holds a token, never its value.
 */

import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Answer = string | Error;
const state = vi.hoisted(() => ({
	glabPath: "/usr/bin/glab" as string | null,
	/** Answers of glab, keyed by its arguments; missing ones fail. */
	answers: new Map<string, Answer>(),
	calls: [] as { command: string; args: string[] }[],
	spawned: [] as { child: FakeChild; command: string; args: string[] }[],
	openExternal: vi.fn(async (_url: string) => undefined),
	openTerminal: vi.fn(async (_command: string) => undefined),
	os: "linux",
}));

class FakeChild extends EventEmitter {
	stdout = new EventEmitter();
	stderr = new EventEmitter();
}

function answerFor(command: string, args: string[]): string {
	state.calls.push({ command, args });
	const answer = state.answers.get(args.join(" "));
	if (answer === undefined) throw new Error(`glab: no answer for ${args.join(" ")}`);
	if (answer instanceof Error) throw answer;
	return answer;
}

vi.mock("node:child_process", () => {
	const execFileSync = vi.fn((command: string, args: string[]) => answerFor(command, args));
	const execFile = vi.fn(
		(
			command: string,
			args: string[],
			_options: unknown,
			callback: (error: Error | null, result?: { stdout: string }) => void,
		) => {
			try {
				callback(null, { stdout: answerFor(command, args) });
			} catch (error) {
				callback(error as Error);
			}
		},
	);
	const spawn = vi.fn((command: string, args: string[]) => {
		const child = new FakeChild();
		state.spawned.push({ child, command, args });
		return child;
	});
	const module = { execFileSync, execFile, spawn };
	return { ...module, default: module };
});

vi.mock("../../../cli-tool-manager", () => ({
	getToolPath: (tool: string) => `/tools/${tool}`,
}));
vi.mock("../../../env-utils", () => ({
	findExecutable: () => state.glabPath,
	getAugmentedEnv: () => ({ PATH: "/tools" }),
}));
vi.mock("../../../open-external", () => ({ openExternalUrl: state.openExternal }));
vi.mock("../../../platform", () => ({ getCurrentOS: () => state.os }));
vi.mock("../../claude-code-handlers", () => ({
	openTerminalWithCommand: state.openTerminal,
}));

import { ipcMain } from "electron";
import { IPC_CHANNELS, MASKED_SECRET } from "../../../../shared/constants";
import {
	glabInstallCommand,
	registerGitlabOAuthHandlers,
	signInUrlOn,
} from "../oauth-handlers";

const invoke = (channel: string, ...args: unknown[]) =>
	(
		ipcMain as unknown as {
			invokeHandler: (c: string, e: unknown, ...a: unknown[]) => Promise<unknown>;
		}
	).invokeHandler(channel, {}, ...args);

beforeEach(() => {
	state.glabPath = "/usr/bin/glab";
	state.answers.clear();
	state.calls = [];
	state.spawned = [];
	state.openExternal.mockReset().mockResolvedValue(undefined);
	state.openTerminal.mockReset().mockResolvedValue(undefined);
	state.os = "linux";
	(ipcMain as unknown as { removeAllListeners: () => void }).removeAllListeners?.();
	registerGitlabOAuthHandlers();
});

describe("the glab CLI", () => {
	it("reports glab's version, run by the path where it was found", async () => {
		state.answers.set("--version", "glab 1.50.0 (2026-10-01)\nmore");
		await expect(invoke(IPC_CHANNELS.GITLAB_CHECK_CLI)).resolves.toEqual({
			success: true,
			data: { installed: true, version: "glab 1.50.0 (2026-10-01)" },
		});
		expect(state.calls[0].command).toBe("/usr/bin/glab");
	});

	it("is not installed when it is missing or does not run", async () => {
		state.glabPath = null;
		await expect(invoke(IPC_CHANNELS.GITLAB_CHECK_CLI)).resolves.toEqual({
			success: true,
			data: { installed: false },
		});
		state.glabPath = "/usr/bin/glab";
		await expect(invoke(IPC_CHANNELS.GITLAB_CHECK_CLI)).resolves.toEqual({
			success: true,
			data: { installed: false },
		});
	});

	it("installs with this OS's package manager, in the user's terminal", async () => {
		expect(glabInstallCommand("darwin")).toBe("brew install glab");
		expect(glabInstallCommand("win32")).toBe("winget install --id GitLab.glab");
		expect(glabInstallCommand("linux")).toBe("sudo snap install glab || brew install glab");

		state.os = "darwin";
		await expect(invoke(IPC_CHANNELS.GITLAB_INSTALL_CLI)).resolves.toEqual({
			success: true,
			data: { command: "brew install glab" },
		});
		expect(state.openTerminal).toHaveBeenCalledWith("brew install glab");
	});

	it("says why the terminal did not open", async () => {
		state.openTerminal.mockRejectedValueOnce(new Error("no terminal"));
		await expect(invoke(IPC_CHANNELS.GITLAB_INSTALL_CLI)).resolves.toEqual({
			success: false,
			error: "Failed to open terminal for installation: no terminal",
		});
		state.openTerminal.mockRejectedValueOnce("down");
		await expect(invoke(IPC_CHANNELS.GITLAB_INSTALL_CLI)).resolves.toMatchObject({
			error: "Failed to open terminal for installation: Unknown error",
		});
	});
});

describe("the instance the renderer names", () => {
	it("is the host the settings page sends, not gitlab.com", async () => {
		state.answers.set("auth status --hostname=gitlab.acme.dev", "ok");
		state.answers.set("api user --jq .username --hostname=gitlab.acme.dev", "ada\n");

		await expect(invoke(IPC_CHANNELS.GITLAB_CHECK_AUTH, "gitlab.acme.dev")).resolves.toEqual({
			success: true,
			data: { authenticated: true, username: "ada" },
		});
		expect(state.calls.every((c) => c.command === "/tools/glab")).toBe(true);
	});

	it("keeps a port, drops a scheme and a path, and needs no host for gitlab.com", async () => {
		state.answers.set("auth status --hostname=gitlab.acme.dev:8443", "ok");
		state.answers.set("api user --jq .username --hostname=gitlab.acme.dev:8443", "");
		await expect(
			invoke(IPC_CHANNELS.GITLAB_CHECK_AUTH, "https://gitlab.acme.dev:8443/sub/"),
		).resolves.toEqual({ success: true, data: { authenticated: true } });

		state.answers.set("auth status", "ok");
		state.answers.set("api user --jq .username", "linus");
		await expect(invoke(IPC_CHANNELS.GITLAB_CHECK_AUTH)).resolves.toMatchObject({
			data: { username: "linus" },
		});
		await expect(invoke(IPC_CHANNELS.GITLAB_CHECK_AUTH, "gitlab.com")).resolves.toMatchObject({
			data: { username: "linus" },
		});
	});

	it.each([
		["a credential", "https://ada:pat-test-0000@gitlab.acme.dev"],
		["another protocol", "ftp://gitlab.acme.dev"],
		["an option", "-oProxyCommand=x"],
		["not a string", 42],
		["not a host", "https://"],
	])("is refused when it holds %s, before glab runs", async (_what, instance) => {
		for (const channel of [
			IPC_CHANNELS.GITLAB_CHECK_AUTH,
			IPC_CHANNELS.GITLAB_START_AUTH,
			IPC_CHANNELS.GITLAB_GET_TOKEN,
			IPC_CHANNELS.GITLAB_GET_USER,
			IPC_CHANNELS.GITLAB_LIST_USER_PROJECTS,
		]) {
			await expect(invoke(channel, instance)).resolves.toEqual({
				success: false,
				error: "Invalid GitLab instance",
			});
		}
		expect(state.calls).toEqual([]);
		expect(state.spawned).toEqual([]);
	});
});

describe("the sign-in", () => {
	it("is not signed in when glab says so", async () => {
		state.answers.set("auth status", new Error("not logged in"));
		await expect(invoke(IPC_CHANNELS.GITLAB_CHECK_AUTH)).resolves.toEqual({
			success: true,
			data: { authenticated: false },
		});
	});

	it("is signed in without a name when glab cannot read the user", async () => {
		state.answers.set("auth status", "ok");
		await expect(invoke(IPC_CHANNELS.GITLAB_CHECK_AUTH)).resolves.toEqual({
			success: true,
			data: { authenticated: true },
		});
	});

	it("runs glab auth login and opens its page on the instance only, once", async () => {
		const pending = invoke(IPC_CHANNELS.GITLAB_START_AUTH, "gitlab.acme.dev");
		const [{ child, command, args }] = state.spawned;
		expect(command).toBe("/tools/glab");
		expect(args).toEqual(["auth", "login", "--web", "--hostname=gitlab.acme.dev"]);

		child.stdout.emit("data", Buffer.from("See https://evil.example/login first"));
		child.stdout.emit("data", Buffer.from("no link here"));
		child.stdout.emit(
			"data",
			Buffer.from("Open https://gitlab.acme.dev/oauth/authorize?x=1 in your browser"),
		);
		child.stdout.emit("data", Buffer.from("Again https://gitlab.acme.dev/oauth/other"));
		child.emit("close", 0);

		await expect(pending).resolves.toEqual({
			success: true,
			data: {
				deviceCode: "",
				verificationUrl: "https://gitlab.acme.dev/-/profile/personal_access_tokens",
				userCode: "",
			},
		});
		expect(state.openExternal).toHaveBeenCalledTimes(1);
		expect(state.openExternal).toHaveBeenCalledWith(
			"https://gitlab.acme.dev/oauth/authorize?x=1",
		);
	});

	it("still resolves when the browser does not open", async () => {
		state.openExternal.mockRejectedValueOnce(new Error("no browser"));
		const pending = invoke(IPC_CHANNELS.GITLAB_START_AUTH);
		const [{ child }] = state.spawned;
		child.stdout.emit("data", Buffer.from("https://gitlab.com/oauth/authorize"));
		child.emit("close", 0);
		await expect(pending).resolves.toMatchObject({ success: true });
	});

	it("says why glab failed: its error output, its exit code, or its spawn error", async () => {
		let pending = invoke(IPC_CHANNELS.GITLAB_START_AUTH);
		state.spawned[0].child.stderr.emit("data", Buffer.from("denied"));
		state.spawned[0].child.emit("close", 1);
		await expect(pending).resolves.toMatchObject({ success: false, error: "denied" });

		pending = invoke(IPC_CHANNELS.GITLAB_START_AUTH);
		state.spawned[1].child.emit("close", 2);
		await expect(pending).resolves.toMatchObject({
			success: false,
			error: "Authentication failed with exit code 2",
		});

		pending = invoke(IPC_CHANNELS.GITLAB_START_AUTH);
		state.spawned[2].child.emit("error", new Error("ENOENT"));
		await expect(pending).resolves.toMatchObject({ success: false, error: "ENOENT" });
	});

	it("finds the instance's link among others", () => {
		expect(signInUrlOn("a https://x.dev/1 b https://gitlab.com/2", "gitlab.com")).toBe(
			"https://gitlab.com/2",
		);
		expect(signInUrlOn("https://[bad/ then nothing", "gitlab.com")).toBeUndefined();
	});
});

describe("the token", () => {
	it("reaches the renderer as the mask, never as its value", async () => {
		state.answers.set("auth token --hostname=gitlab.acme.dev", "glpat-test-0000\n");
		const result = await invoke(IPC_CHANNELS.GITLAB_GET_TOKEN, "gitlab.acme.dev");
		expect(result).toEqual({ success: true, data: { token: MASKED_SECRET } });
		expect(JSON.stringify(result)).not.toContain("glpat-test-0000");
	});

	it("is missing when glab holds none or fails", async () => {
		state.answers.set("auth token", "  \n");
		await expect(invoke(IPC_CHANNELS.GITLAB_GET_TOKEN)).resolves.toEqual({
			success: false,
			error: "No token found. Please authenticate first.",
		});
		state.answers.set("auth token", new Error("not logged in"));
		await expect(invoke(IPC_CHANNELS.GITLAB_GET_TOKEN)).resolves.toMatchObject({
			success: false,
		});
	});
});

describe("the user and their projects", () => {
	it("gives the user's name, and their display name when it is text", async () => {
		state.answers.set("api user", JSON.stringify({ username: "ada", name: "Ada L." }));
		await expect(invoke(IPC_CHANNELS.GITLAB_GET_USER)).resolves.toEqual({
			success: true,
			data: { username: "ada", name: "Ada L." },
		});
		state.answers.set("api user", JSON.stringify({ username: "ada", name: 7 }));
		await expect(invoke(IPC_CHANNELS.GITLAB_GET_USER)).resolves.toEqual({
			success: true,
			data: { username: "ada" },
		});
	});

	it("fails on a user without a name, on what is not JSON, and on glab's error", async () => {
		state.answers.set("api user", "null");
		await expect(invoke(IPC_CHANNELS.GITLAB_GET_USER)).resolves.toEqual({
			success: false,
			error: "Failed to get user info",
		});
		state.answers.set("api user", "<html>");
		await expect(invoke(IPC_CHANNELS.GITLAB_GET_USER)).resolves.toMatchObject({
			success: false,
		});
		state.answers.set("api user", new Error("401"));
		await expect(invoke(IPC_CHANNELS.GITLAB_GET_USER)).resolves.toEqual({
			success: false,
			error: "401",
		});
	});

	it("lists the user's projects, keeping only entries with a path", async () => {
		state.answers.set(
			"repo list --mine -F json --hostname=gitlab.acme.dev",
			JSON.stringify([
				{ path_with_namespace: "acme/shop", description: "Shop", visibility: "internal" },
				{ path_with_namespace: "acme/blog", description: null },
				{ description: "no path" },
				null,
			]),
		);
		await expect(
			invoke(IPC_CHANNELS.GITLAB_LIST_USER_PROJECTS, "gitlab.acme.dev"),
		).resolves.toEqual({
			success: true,
			data: {
				projects: [
					{ pathWithNamespace: "acme/shop", description: "Shop", visibility: "internal" },
					{ pathWithNamespace: "acme/blog", description: null, visibility: "private" },
				],
			},
		});
	});

	it("fails on a list that is not one, and on glab's error", async () => {
		state.answers.set("repo list --mine -F json", JSON.stringify({ message: "nope" }));
		await expect(invoke(IPC_CHANNELS.GITLAB_LIST_USER_PROJECTS)).resolves.toEqual({
			success: false,
			error: "Failed to list projects",
		});
		state.answers.set("repo list --mine -F json", new Error("timeout"));
		await expect(invoke(IPC_CHANNELS.GITLAB_LIST_USER_PROJECTS)).resolves.toEqual({
			success: false,
			error: "timeout",
		});
	});
});
