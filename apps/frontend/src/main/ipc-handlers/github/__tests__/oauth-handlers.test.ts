/**
 * @vitest-environment node
 *
 * The gh CLI sign-in and the repository setup of the GitHub modal, against a
 * stand-in gh and git (child_process). Every command is an argument list, the
 * renderer's names and options are checked before any command runs, the
 * browser is opened by the main process, and the renderer learns that gh
 * holds a token, never its value.
 */

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ExecResult = string | Error;
const state = vi.hoisted(() => ({
	ghPath: "/usr/bin/gh" as string | null,
	/** Answers of execFileSync, keyed by `<tool> <args>`; missing ones throw. */
	sync: new Map<string, ExecResult>(),
	/** Answer of the async `gh api user --jq .login` calls, in order. */
	logins: [] as ExecResult[],
	spawned: [] as { child: FakeChild; command: string; args: string[] }[],
	spawnThrows: null as Error | null,
	openExternal: vi.fn(async (_url: string) => undefined),
}));

class FakeChild extends EventEmitter {
	stdout = new EventEmitter();
	stderr = new EventEmitter();
}

const key = (command: string, args: readonly string[]) =>
	[command, ...args].join(" ");

vi.mock("node:child_process", () => {
	const execFileSync = vi.fn((command: string, args: string[]) => {
		const answer = state.sync.get(key(command, args));
		if (answer === undefined) throw new Error(`no answer for ${key(command, args)}`);
		if (answer instanceof Error) throw answer;
		return answer;
	});
	const execFile = vi.fn(
		(
			_command: string,
			_args: string[],
			_options: unknown,
			callback: (error: Error | null, result?: { stdout: string }) => void,
		) => {
			const answer = state.logins.shift() ?? new Error("not logged in");
			if (answer instanceof Error) callback(answer);
			else callback(null, { stdout: answer });
		},
	);
	const spawn = vi.fn((command: string, args: string[]) => {
		if (state.spawnThrows) throw state.spawnThrows;
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
	findExecutable: () => state.ghPath,
	getAugmentedEnv: () => ({ PATH: "/tools" }),
}));

vi.mock("../../../open-external", () => ({
	openExternalUrl: state.openExternal,
}));

import { execFileSync } from "node:child_process";
import { BrowserWindow, ipcMain } from "electron";
import { IPC_CHANNELS, MASKED_SECRET } from "../../../../shared/constants";
import {
	isValidCreateRepoOptions,
	isValidGitHubRepo,
	isValidGitHubRepoName,
	registerGithubOAuthHandlers,
} from "../oauth-handlers";

type Result = {
	success: boolean;
	error?: string;
	data?: Record<string, unknown> | string | string[];
};
const invoke = (channel: string, ...args: unknown[]): Promise<Result> =>
	(
		ipcMain as unknown as {
			invokeHandler: (c: string, e: unknown, ...a: unknown[]) => Promise<Result>;
		}
	).invokeHandler(channel, {}, ...args);

const GH = "/tools/gh";
const GIT = "/tools/git";
const answer = (command: string, args: string[], value: ExecResult) =>
	state.sync.set(key(command, args), value);
const ran = () =>
	vi.mocked(execFileSync).mock.calls.map(([command, args]) =>
		key(command as string, args as string[]),
	);

/** The mock's list of open windows (`__mocks__/electron.ts`). */
const openWindows = (BrowserWindow as unknown as { openWindows: BrowserWindow[] }).openWindows;
const window = new BrowserWindow();
const send = vi.fn();
window.webContents.send = send;
const sent = () => send.mock.calls as [string, unknown][];

registerGithubOAuthHandlers();

beforeEach(() => {
	state.ghPath = "/usr/bin/gh";
	state.sync.clear();
	state.logins = [];
	state.spawned = [];
	state.spawnThrows = null;
	state.openExternal.mockReset();
	state.openExternal.mockResolvedValue(undefined);
	vi.mocked(execFileSync).mockClear();
	send.mockClear();
	openWindows.splice(0, openWindows.length, window);
});

afterEach(() => {
	openWindows.splice(0);
});

describe("GITHUB_CHECK_CLI", () => {
	it("reports gh missing without running anything", async () => {
		state.ghPath = null;

		const result = await invoke(IPC_CHANNELS.GITHUB_CHECK_CLI);

		expect(result).toEqual({ success: true, data: { installed: false } });
		expect(ran()).toEqual([]);
	});

	it("reads the first line of gh --version", async () => {
		answer(GH, ["--version"], "gh version 2.80.0 (2026-10-01)\nhttps://github.com/cli/cli\n");

		const result = await invoke(IPC_CHANNELS.GITHUB_CHECK_CLI);

		expect(result).toEqual({
			success: true,
			data: { installed: true, version: "gh version 2.80.0 (2026-10-01)" },
		});
	});

	it("reports gh missing when it does not run", async () => {
		const result = await invoke(IPC_CHANNELS.GITHUB_CHECK_CLI);

		expect(result).toEqual({ success: true, data: { installed: false } });
	});
});

describe("GITHUB_CHECK_AUTH", () => {
	it("is authenticated with the login gh answers", async () => {
		answer(GH, ["auth", "status"], "Logged in to github.com");
		answer(GH, ["api", "user", "--jq", ".login"], "octocat\n");

		const result = await invoke(IPC_CHANNELS.GITHUB_CHECK_AUTH);

		expect(result).toEqual({
			success: true,
			data: { authenticated: true, username: "octocat" },
		});
	});

	it("is authenticated without a login when the user call fails", async () => {
		answer(GH, ["auth", "status"], "Logged in to github.com");

		const result = await invoke(IPC_CHANNELS.GITHUB_CHECK_AUTH);

		expect(result).toEqual({ success: true, data: { authenticated: true } });
	});

	it("is not authenticated when gh auth status fails", async () => {
		answer(GH, ["auth", "status"], new Error("You are not logged into any GitHub hosts"));

		const result = await invoke(IPC_CHANNELS.GITHUB_CHECK_AUTH);

		expect(result).toEqual({ success: true, data: { authenticated: false } });
	});
});

describe("GITHUB_START_AUTH", () => {
	const DEVICE_URL = "https://github.com/login/device";

	async function start() {
		const pending = invoke(IPC_CHANNELS.GITHUB_START_AUTH);
		// The login before the flow is read asynchronously, then gh is spawned.
		await vi.waitFor(() => expect(state.spawned).toHaveLength(1));
		return { pending, ...state.spawned[0] };
	}

	it("runs gh auth login by its path, shows the code at once and opens the device page", async () => {
		state.logins = [new Error("not logged in"), "octocat\n"];
		const { pending, child, command, args } = await start();

		expect(command).toBe(GH);
		expect(args).toEqual(["auth", "login", "--web", "--scopes", "repo"]);

		child.stderr.emit("data", Buffer.from("! First copy your one-time code: ABCD 1234\n"));
		await vi.waitFor(() =>
			expect(sent()).toContainEqual([
				IPC_CHANNELS.GITHUB_AUTH_DEVICE_CODE,
				{ deviceCode: "ABCD-1234", authUrl: DEVICE_URL, browserOpened: true },
			]),
		);
		expect(state.openExternal).toHaveBeenCalledWith(DEVICE_URL);

		// A later chunk does not open the page a second time.
		child.stdout.emit("data", Buffer.from("code: EFGH-5678 Press Enter\n"));
		child.emit("close", 0);

		await expect(pending).resolves.toEqual({
			success: true,
			data: {
				success: true,
				message: "Successfully authenticated with GitHub",
				deviceCode: "ABCD-1234",
				authUrl: DEVICE_URL,
				browserOpened: true,
				fallbackUrl: undefined,
			},
		});
		expect(state.openExternal).toHaveBeenCalledTimes(1);
		expect(sent()).toContainEqual([
			IPC_CHANNELS.GITHUB_AUTH_CHANGED,
			{ oldUsername: null, newUsername: "octocat" },
		]);
	});

	it("waits for a chunk that holds the code, and gives the page back when the browser does not open", async () => {
		state.openExternal.mockRejectedValue(new Error("no browser"));
		state.logins = ["octocat\n", "octocat\n"];
		const { pending, child } = await start();

		child.stdout.emit("data", Buffer.from("Opening github.com in your browser\n"));
		child.stdout.emit("data", Buffer.from("verification code: WXYZ-0000\n"));
		await vi.waitFor(() =>
			expect(sent()).toContainEqual([
				IPC_CHANNELS.GITHUB_AUTH_DEVICE_CODE,
				{ deviceCode: "WXYZ-0000", authUrl: DEVICE_URL, browserOpened: false },
			]),
		);
		child.emit("close", 0);

		const result = await pending;
		expect(result.data).toMatchObject({
			success: true,
			message: "Authentication successful. Browser could not be opened automatically.",
			browserOpened: false,
			fallbackUrl: DEVICE_URL,
		});
		// Same account before and after: no change to announce.
		expect(sent().map(([channel]) => channel)).not.toContain(
			IPC_CHANNELS.GITHUB_AUTH_CHANGED,
		);
	});

	it("announces nothing when the login cannot be read after a successful sign-in", async () => {
		// gh answers an empty login before the flow, and fails after it.
		state.logins = ["\n"];
		const { pending, child } = await start();
		child.emit("close", 0);

		const result = await pending;
		expect(result.success).toBe(true);
		expect(result.data).toMatchObject({ deviceCode: undefined, browserOpened: false });
		expect(sent()).toEqual([]);
	});

	it("fails with gh's output, and the page to finish by hand", async () => {
		const { pending, child } = await start();
		child.stderr.emit("data", Buffer.from("authentication cancelled"));
		child.emit("close", 1);

		await expect(pending).resolves.toEqual({
			success: false,
			error: "authentication cancelled",
			data: {
				success: false,
				deviceCode: undefined,
				authUrl: DEVICE_URL,
				browserOpened: false,
				fallbackUrl: DEVICE_URL,
				message:
					"Authentication failed. Please visit the URL manually to complete authentication.",
			},
		});
	});

	it("names the exit code when gh printed nothing", async () => {
		const { pending, child } = await start();
		child.emit("close", 2);

		await expect(pending).resolves.toMatchObject({
			success: false,
			error: "Authentication failed with exit code 2",
		});
	});

	it("fails when gh cannot start", async () => {
		const { pending, child } = await start();
		child.emit("error", new Error("spawn gh ENOENT"));

		await expect(pending).resolves.toMatchObject({
			success: false,
			error: "spawn gh ENOENT",
			data: { browserOpened: false, fallbackUrl: DEVICE_URL },
		});
	});

	it("fails when spawning throws", async () => {
		state.spawnThrows = new Error("EPERM");

		await expect(invoke(IPC_CHANNELS.GITHUB_START_AUTH)).resolves.toMatchObject({
			success: false,
			error: "EPERM",
			data: { success: false, fallbackUrl: DEVICE_URL },
		});
	});

	it("names an unknown error when spawning throws something else", async () => {
		state.spawnThrows = "boom" as unknown as Error;

		await expect(invoke(IPC_CHANNELS.GITHUB_START_AUTH)).resolves.toMatchObject({
			success: false,
			error: "Unknown error",
		});
	});
});

describe("GITHUB_GET_TOKEN", () => {
	it("answers the mask, never gh's token", async () => {
		answer(GH, ["auth", "token"], "gho-test-0000\n");

		const result = await invoke(IPC_CHANNELS.GITHUB_GET_TOKEN);

		expect(result).toEqual({ success: true, data: { token: MASKED_SECRET } });
		expect(JSON.stringify(result)).not.toContain("gho-test-0000");
	});

	it("fails when gh holds no token", async () => {
		answer(GH, ["auth", "token"], "  \n");

		await expect(invoke(IPC_CHANNELS.GITHUB_GET_TOKEN)).resolves.toEqual({
			success: false,
			error: "No token found. Please authenticate first.",
		});
	});

	it("fails with gh's error", async () => {
		answer(GH, ["auth", "token"], new Error("not logged in"));

		await expect(invoke(IPC_CHANNELS.GITHUB_GET_TOKEN)).resolves.toEqual({
			success: false,
			error: "not logged in",
		});
	});
});

describe("GITHUB_GET_USER", () => {
	it("reads the login and the name", async () => {
		answer(GH, ["api", "user"], JSON.stringify({ login: "octocat", name: "Mona" }));

		await expect(invoke(IPC_CHANNELS.GITHUB_GET_USER)).resolves.toEqual({
			success: true,
			data: { username: "octocat", name: "Mona" },
		});
	});

	it("fails when the answer is not JSON", async () => {
		answer(GH, ["api", "user"], "<html>");

		const result = await invoke(IPC_CHANNELS.GITHUB_GET_USER);
		expect(result.success).toBe(false);
		expect(result.error).toBeTruthy();
	});
});

describe("GITHUB_LIST_USER_REPOS", () => {
	const LIST = ["repo", "list", "--limit", "100", "--json", "nameWithOwner,description,isPrivate"];

	it("lists by an argument list, without a shell", async () => {
		answer(
			GH,
			LIST,
			JSON.stringify([
				{ nameWithOwner: "octocat/shop", description: "Shop", isPrivate: true },
				{ nameWithOwner: "octocat/blog", description: null, isPrivate: false },
			]),
		);

		await expect(invoke(IPC_CHANNELS.GITHUB_LIST_USER_REPOS)).resolves.toEqual({
			success: true,
			data: {
				repos: [
					{ fullName: "octocat/shop", description: "Shop", isPrivate: true },
					{ fullName: "octocat/blog", description: null, isPrivate: false },
				],
			},
		});
	});

	it("fails with gh's error", async () => {
		answer(GH, LIST, new Error("HTTP 401"));

		await expect(invoke(IPC_CHANNELS.GITHUB_LIST_USER_REPOS)).resolves.toEqual({
			success: false,
			error: "HTTP 401",
		});
	});
});

describe("GITHUB_DETECT_REPO", () => {
	const ORIGIN = ["remote", "get-url", "origin"];

	it.each([
		["https://github.com/acme/shop.git", "acme/shop"],
		["git@github.com:acme/shop.git", "acme/shop"],
		["https://github.com/acme/shop", "acme/shop"],
	])("reads %s as %s", async (url, repo) => {
		answer(GIT, ORIGIN, `${url}\n`);

		await expect(invoke(IPC_CHANNELS.GITHUB_DETECT_REPO, "/repo")).resolves.toEqual({
			success: true,
			data: repo,
		});
	});

	it("refuses a remote elsewhere than GitHub", async () => {
		answer(GIT, ORIGIN, "https://gitlab.com/acme/shop.git\n");

		await expect(invoke(IPC_CHANNELS.GITHUB_DETECT_REPO, "/repo")).resolves.toEqual({
			success: false,
			error: "Remote URL is not a GitHub repository",
		});
	});

	it("fails without an origin", async () => {
		answer(GIT, ORIGIN, new Error("No such remote 'origin'"));

		await expect(invoke(IPC_CHANNELS.GITHUB_DETECT_REPO, "/repo")).resolves.toEqual({
			success: false,
			error: "No such remote 'origin'",
		});
	});
});

describe("GITHUB_GET_BRANCHES", () => {
	const branches = (repo: string) => [
		"api",
		`repos/${repo}/branches`,
		"--paginate",
		"--jq",
		".[].name",
	];

	it("lists the branch names of owner/repo", async () => {
		answer(GH, branches("acme/shop"), "main\ndevelop\n\n");

		await expect(
			invoke(IPC_CHANNELS.GITHUB_GET_BRANCHES, "acme/shop", MASKED_SECRET),
		).resolves.toEqual({ success: true, data: ["main", "develop"] });
	});

	it.each([
		"../..",
		"acme/..",
		"acme/shop/extra",
		"-acme/shop",
		"acme/-shop",
		"acme shop/x",
		42,
	])("refuses %s before running gh", async (repo) => {
		const result = await invoke(IPC_CHANNELS.GITHUB_GET_BRANCHES, repo, "");

		expect(result).toEqual({
			success: false,
			error: "Invalid repository format. Expected: owner/repo",
		});
		expect(ran()).toEqual([]);
	});

	it("fails with gh's error", async () => {
		answer(GH, branches("acme/shop"), new Error("HTTP 404"));

		await expect(
			invoke(IPC_CHANNELS.GITHUB_GET_BRANCHES, "acme/shop", ""),
		).resolves.toEqual({ success: false, error: "HTTP 404" });
	});
});

describe("GITHUB_CREATE_REPO", () => {
	const LOGIN = ["api", "user", "--jq", ".login"];
	const ORIGIN = ["remote", "get-url", "origin"];
	const opts = { projectPath: "/repo" };

	it("creates a private personal repository, then points origin at it", async () => {
		answer(GH, LOGIN, "octocat\n");
		const create = ["repo", "create", "shop", "--source", "/repo", "--private", "--description", "A shop", "--push"];
		answer(GH, create, "created");
		answer(GIT, ORIGIN, "git@github.com:octocat/shop.git\n");
		answer(GIT, ["remote", "set-url", "origin", "https://github.com/octocat/shop.git"], "");
		answer(GIT, ["branch", "--set-upstream-to=origin/main", "main"], new Error("no branch main"));
		answer(GIT, ["branch", "--set-upstream-to=origin/master", "master"], "");

		const result = await invoke(IPC_CHANNELS.GITHUB_CREATE_REPO, "shop", {
			...opts,
			isPrivate: true,
			description: "A shop",
		});

		expect(result).toEqual({
			success: true,
			data: { fullName: "octocat/shop", url: "https://github.com/octocat/shop" },
		});
		expect(ran()).toEqual([
			key(GH, LOGIN),
			key(GH, create),
			key(GIT, ORIGIN),
			key(GIT, ["remote", "set-url", "origin", "https://github.com/octocat/shop.git"]),
			key(GIT, ["branch", "--set-upstream-to=origin/main", "main"]),
			key(GIT, ["branch", "--set-upstream-to=origin/master", "master"]),
		]);
	});

	it("creates a public repository of an organization and adds origin when there is none", async () => {
		answer(GH, LOGIN, "octocat\n");
		answer(GH, ["repo", "create", "acme/shop", "--source", "/repo", "--public", "--push"], "");
		answer(GIT, ORIGIN, new Error("No such remote"));
		answer(GIT, ["remote", "add", "origin", "https://github.com/acme/shop.git"], "");
		answer(GIT, ["branch", "--set-upstream-to=origin/main", "main"], "");

		const result = await invoke(IPC_CHANNELS.GITHUB_CREATE_REPO, "shop", {
			...opts,
			owner: "acme",
		});

		expect(result.data).toEqual({
			fullName: "acme/shop",
			url: "https://github.com/acme/shop",
		});
		expect(ran()).toContain(key(GIT, ["remote", "add", "origin", "https://github.com/acme/shop.git"]));
		expect(ran()).not.toContain(key(GIT, ["branch", "--set-upstream-to=origin/master", "master"]));
	});

	it("leaves an origin that already points at the repository, and succeeds when origin cannot be set", async () => {
		answer(GH, LOGIN, "octocat\n");
		answer(GH, ["repo", "create", "shop", "--source", "/repo", "--public", "--push"], "");
		answer(GIT, ORIGIN, "https://github.com/octocat/shop.git\n");

		const kept = await invoke(IPC_CHANNELS.GITHUB_CREATE_REPO, "shop", opts);
		expect(kept.success).toBe(true);
		expect(ran().some((command) => command.includes("set-url"))).toBe(false);

		// No origin, and adding it fails: the repository exists all the same.
		answer(GIT, ORIGIN, new Error("No such remote"));
		const unset = await invoke(IPC_CHANNELS.GITHUB_CREATE_REPO, "shop", opts);
		expect(unset.success).toBe(true);
	});

	it("fails with gh's error when the repository cannot be created", async () => {
		answer(GH, LOGIN, "octocat\n");

		const result = await invoke(IPC_CHANNELS.GITHUB_CREATE_REPO, "shop", opts);

		expect(result.success).toBe(false);
		expect(result.error).toContain("repo create shop");
	});

	it("names the failure when gh throws something that is not an error", async () => {
		vi.mocked(execFileSync).mockImplementationOnce(() => {
			throw "boom";
		});

		await expect(
			invoke(IPC_CHANNELS.GITHUB_CREATE_REPO, "shop", opts),
		).resolves.toEqual({ success: false, error: "Failed to create repository" });
	});

	it.each(["..", ".", "-shop", "shop name", "shop/x", "", 7])(
		"refuses the name %s before running anything",
		async (name) => {
			const result = await invoke(IPC_CHANNELS.GITHUB_CREATE_REPO, name, opts);

			expect(result.success).toBe(false);
			expect(result.error).toMatch(/^Invalid repository name/);
			expect(ran()).toEqual([]);
		},
	);

	it.each([
		["no options", undefined],
		["no project", {}],
		["an owner with a slash", { ...opts, owner: "acme/x" }],
		["an owner that is an option", { ...opts, owner: "--help" }],
		["a description too long", { ...opts, description: "x".repeat(351) }],
		["a description that is not text", { ...opts, description: 3 }],
		["a visibility that is not a boolean", { ...opts, isPrivate: "yes" }],
	])("refuses %s before running anything", async (_label, options) => {
		const result = await invoke(IPC_CHANNELS.GITHUB_CREATE_REPO, "shop", options);

		expect(result).toEqual({ success: false, error: "Invalid repository options" });
		expect(ran()).toEqual([]);
	});
});

describe("GITHUB_ADD_REMOTE", () => {
	const ORIGIN = ["remote", "get-url", "origin"];
	const ADD = ["remote", "add", "origin", "https://github.com/acme/shop.git"];

	it("replaces an existing origin", async () => {
		answer(GIT, ORIGIN, "https://github.com/old/repo.git");
		answer(GIT, ["remote", "remove", "origin"], "");
		answer(GIT, ADD, "");

		await expect(
			invoke(IPC_CHANNELS.GITHUB_ADD_REMOTE, "/repo", "acme/shop"),
		).resolves.toEqual({
			success: true,
			data: { remoteUrl: "https://github.com/acme/shop.git" },
		});
		expect(ran()).toEqual([
			key(GIT, ORIGIN),
			key(GIT, ["remote", "remove", "origin"]),
			key(GIT, ADD),
		]);
	});

	it("adds origin when there is none", async () => {
		answer(GIT, ADD, "");

		const result = await invoke(IPC_CHANNELS.GITHUB_ADD_REMOTE, "/repo", "acme/shop");

		expect(result.success).toBe(true);
		expect(ran()).toEqual([key(GIT, ORIGIN), key(GIT, ADD)]);
	});

	it("fails with git's error", async () => {
		await expect(
			invoke(IPC_CHANNELS.GITHUB_ADD_REMOTE, "/repo", "acme/shop"),
		).resolves.toMatchObject({ success: false, error: expect.stringContaining("remote add") });
	});

	it("names the failure when git throws something that is not an error", async () => {
		vi.mocked(execFileSync)
			.mockImplementationOnce(() => {
				throw new Error("No such remote");
			})
			.mockImplementationOnce(() => {
				throw "boom";
			});

		await expect(
			invoke(IPC_CHANNELS.GITHUB_ADD_REMOTE, "/repo", "acme/shop"),
		).resolves.toEqual({ success: false, error: "Failed to add remote" });
	});

	it("refuses a reference that is not owner/repo", async () => {
		await expect(
			invoke(IPC_CHANNELS.GITHUB_ADD_REMOTE, "/repo", "acme/shop.git/../x"),
		).resolves.toEqual({
			success: false,
			error: "Invalid repository format. Expected: owner/repo",
		});
		expect(ran()).toEqual([]);
	});
});

describe("GITHUB_LIST_ORGS", () => {
	const ORGS = ["api", "user/orgs", "--jq", ".[] | {login: .login, avatarUrl: .avatar_url}"];

	it("reads one organization per line and skips a line that is not JSON", async () => {
		answer(
			GH,
			ORGS,
			`${JSON.stringify({ login: "acme", avatarUrl: "https://avatars/acme" })}\nnot json\n${JSON.stringify({ login: "umbrella" })}\n`,
		);

		await expect(invoke(IPC_CHANNELS.GITHUB_LIST_ORGS)).resolves.toEqual({
			success: true,
			data: {
				orgs: [
					{ login: "acme", avatarUrl: "https://avatars/acme" },
					{ login: "umbrella", avatarUrl: undefined },
				],
			},
		});
	});

	it("answers no organization when gh fails", async () => {
		answer(GH, ORGS, new Error("HTTP 403"));

		await expect(invoke(IPC_CHANNELS.GITHUB_LIST_ORGS)).resolves.toEqual({
			success: true,
			data: { orgs: [] },
		});
	});
});

describe("a command that throws something that is not an error", () => {
	it.each([
		[IPC_CHANNELS.GITHUB_CHECK_CLI, [], { success: true, data: { installed: false } }],
		[IPC_CHANNELS.GITHUB_CHECK_AUTH, [], { success: true, data: { authenticated: false } }],
		[IPC_CHANNELS.GITHUB_GET_TOKEN, [], { success: false, error: "Failed to get token" }],
		[IPC_CHANNELS.GITHUB_GET_USER, [], { success: false, error: "Failed to get user info" }],
		[IPC_CHANNELS.GITHUB_LIST_USER_REPOS, [], { success: false, error: "Failed to list repositories" }],
		[IPC_CHANNELS.GITHUB_DETECT_REPO, ["/repo"], { success: false, error: "Failed to detect GitHub repository" }],
		[IPC_CHANNELS.GITHUB_GET_BRANCHES, ["acme/shop", ""], { success: false, error: "Failed to get branches" }],
		[IPC_CHANNELS.GITHUB_LIST_ORGS, [], { success: true, data: { orgs: [] } }],
	])("%s answers its own failure", async (channel, args, expected) => {
		vi.mocked(execFileSync).mockImplementation(() => {
			throw "boom";
		});
		try {
			await expect(invoke(channel, ...args)).resolves.toEqual(expected);
		} finally {
			vi.mocked(execFileSync).mockReset();
		}
	});

	it("checks the login after gh auth status the same way", async () => {
		answer(GH, ["auth", "status"], "Logged in");
		vi.mocked(execFileSync)
			.mockImplementationOnce(() => "Logged in")
			.mockImplementationOnce(() => {
				throw "boom";
			});

		await expect(invoke(IPC_CHANNELS.GITHUB_CHECK_AUTH)).resolves.toEqual({
			success: true,
			data: { authenticated: true },
		});
	});

	it("still shows the code when the browser fails with something that is not an error", async () => {
		state.openExternal.mockRejectedValue("no browser");
		const pending = invoke(IPC_CHANNELS.GITHUB_START_AUTH);
		await vi.waitFor(() => expect(state.spawned).toHaveLength(1));
		const { child } = state.spawned[0];

		child.stdout.emit("data", Buffer.from("one-time code: ABCD-1234"));
		await vi.waitFor(() => expect(sent()).toHaveLength(1));
		child.emit("close", 0);

		await expect(pending).resolves.toMatchObject({ data: { browserOpened: false } });
	});
});

describe("the checks of the renderer's names", () => {
	it("takes GitHub's own names", () => {
		expect(isValidGitHubRepo("octo-cat/my.repo_1")).toBe(true);
		expect(isValidGitHubRepo("jdoe_acme/shop")).toBe(true);
		expect(isValidGitHubRepoName(".github")).toBe(true);
		expect(isValidCreateRepoOptions({ projectPath: "/repo", owner: "" })).toBe(true);
		expect(
			isValidCreateRepoOptions({
				projectPath: "/repo",
				owner: "acme",
				description: "A shop",
				isPrivate: false,
			}),
		).toBe(true);
	});

	it("refuses an owner longer than GitHub allows", () => {
		expect(isValidGitHubRepo(`${"a".repeat(40)}/shop`)).toBe(false);
		expect(isValidCreateRepoOptions({ projectPath: "" })).toBe(false);
		expect(isValidCreateRepoOptions(null)).toBe(false);
	});
});
