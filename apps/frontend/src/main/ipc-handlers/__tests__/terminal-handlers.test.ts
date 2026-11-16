/**
 * @vitest-environment node
 *
 * The terminal and Claude profile handlers as the renderer reaches them, on
 * a stand-in terminal manager, profile manager and usage monitor: what each
 * channel does, the answer when it fails, and the arguments of the wrong
 * shape that never reach a handler.
 */

import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ipcMain } from "electron";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS, MASKED_SECRET } from "../../../shared/constants";

const state = vi.hoisted(() => ({
	home: "",
	settings: {} as Record<string, unknown> | null,
	settingsError: null as Error | null,
	name: "build" as string | null,
	nameError: null as Error | null,
	madeDirs: [] as string[],
	migrations: [] as unknown[][],
	migrated: true,
	projects: {} as Record<string, unknown>,
	window: null as null | { isDestroyed: () => boolean; webContents: { send: ReturnType<typeof vi.fn> } },
}));

const terminals = vi.hoisted(() => ({
	create: vi.fn(),
	destroy: vi.fn(),
	write: vi.fn(),
	resize: vi.fn(),
	invokeClaudeAsync: vi.fn(),
	setTitle: vi.fn(),
	setWorktreeConfig: vi.fn(),
	getTerminalsForProfileChange: vi.fn(),
	switchClaudeProfile: vi.fn(),
	getSavedSessions: vi.fn(),
	restore: vi.fn(),
	activateDeferredResume: vi.fn(),
	getAvailableSessionDates: vi.fn(),
	getSessionsForDate: vi.fn(),
	restoreSessionsFromDate: vi.fn(),
	isTerminalAlive: vi.fn(),
	updateDisplayOrders: vi.fn(),
}));

const profiles = vi.hoisted(() => ({
	getSettings: vi.fn(),
	getProfile: vi.fn(),
	generateProfileId: vi.fn(),
	saveProfile: vi.fn(),
	deleteProfile: vi.fn(),
	renameProfile: vi.fn(),
	getActiveProfile: vi.fn(),
	setActiveProfile: vi.fn(),
	setProfileToken: vi.fn(),
	getAutoSwitchSettings: vi.fn(),
	updateAutoSwitchSettings: vi.fn(),
	getAccountPriorityOrder: vi.fn(),
	setAccountPriorityOrder: vi.fn(),
}));

const monitor = vi.hoisted(() => ({ value: null as unknown }));

vi.mock("../../claude-profile-manager", () => ({ getClaudeProfileManager: () => profiles }));
vi.mock("../../claude-profile/usage-monitor", () => ({ getUsageMonitor: () => monitor.value }));
vi.mock("../../claude-profile/profile-utils", () => ({
	createProfileDirectory: async (name: string) => {
		const dir = path.join(state.home, ".claude-profiles", name.toLowerCase());
		state.madeDirs.push(dir);
		return dir;
	},
}));
vi.mock("../../claude-profile/session-utils", () => ({
	migrateSession: (...args: unknown[]) => {
		state.migrations.push(args);
		return { success: state.migrated };
	},
}));
vi.mock("../../utils/config-path-validator", () => ({
	isValidConfigDir: (dir: string) => dir.startsWith(state.home),
}));
vi.mock("../../project-store", () => ({ projectStore: { getProject: (id: string) => state.projects[id] } }));
vi.mock("../../settings-utils", () => ({
	readSettingsFileAsync: async () => {
		if (state.settingsError) throw state.settingsError;
		return state.settings;
	},
}));
vi.mock("../../terminal-name-generator", () => ({
	terminalNameGenerator: {
		generateName: async () => {
			if (state.nameError) throw state.nameError;
			return state.name;
		},
	},
}));

import type { TerminalManager } from "../../terminal-manager";
import { initializeUsageMonitorForwarding, registerTerminalHandlers } from "../terminal-handlers";
import { terminalArgsAllowed } from "../terminal/terminal-ipc-guard";

type Usage = EventEmitter & Record<string, ReturnType<typeof vi.fn>>;
let usage: Usage;

const invoke = (channel: string, ...args: unknown[]) =>
	(ipcMain as unknown as { invokeHandler: (c: string, e: unknown, ...a: unknown[]) => Promise<unknown> }).invokeHandler(
		channel,
		{},
		...args,
	);
const send = (channel: string, ...args: unknown[]) => ipcMain.emit(channel, {}, ...args);
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const thrower = (message: unknown) => () => {
	throw message;
};

beforeAll(() => {
	registerTerminalHandlers(terminals as unknown as TerminalManager, () => state.window as never);
});

beforeEach(() => {
	state.home = mkdtempSync(path.join(tmpdir(), "terminal-handlers-"));
	state.settings = {};
	state.settingsError = null;
	state.name = "build";
	state.nameError = null;
	state.madeDirs = [];
	state.migrations = [];
	state.migrated = true;
	state.projects = { "p-1": { id: "p-1" } };
	state.window = { isDestroyed: () => false, webContents: { send: vi.fn() } };
	for (const fn of [...Object.values(terminals), ...Object.values(profiles)]) fn.mockReset();
	usage = Object.assign(new EventEmitter(), {
		stop: vi.fn(),
		start: vi.fn(),
		onProviderRequestIfChanged: vi.fn(),
		getUsageForProvider: vi.fn(),
		getCurrentUsage: vi.fn(),
		getAllProfilesUsage: vi.fn(),
	}) as unknown as Usage;
	monitor.value = usage;
});

afterEach(() => {
	rmSync(state.home, { recursive: true, force: true });
});

describe("the arguments a terminal channel takes", () => {
	it.each([
		[IPC_CHANNELS.TERMINAL_CREATE, [{ id: "t-1", env: { LD_PRELOAD: "/tmp/x.so" } }]],
		[IPC_CHANNELS.TERMINAL_CREATE, [{ id: "t-1", env: { CLAUDE_CONFIG_DIR: "/etc" } }]],
		[IPC_CHANNELS.TERMINAL_CREATE, [{ id: "t-1", shell: "/bin/sh" }]],
		[IPC_CHANNELS.TERMINAL_CREATE, [{ id: "" }]],
		[IPC_CHANNELS.TERMINAL_CREATE, [null]],
		[IPC_CHANNELS.TERMINAL_RESIZE, ["t-1", 0, 24]],
		[IPC_CHANNELS.TERMINAL_RESIZE, ["t-1", 80, 1.5]],
		[IPC_CHANNELS.TERMINAL_INPUT, ["t-1", 42]],
		[IPC_CHANNELS.TERMINAL_INPUT, ["x".repeat(201), "ls"]],
		[IPC_CHANNELS.CLAUDE_PROFILE_SAVE, [{ name: "  " }]],
		[IPC_CHANNELS.CLAUDE_PROFILE_SAVE, [{ name: "Work", configDir: 7 }]],
		[IPC_CHANNELS.CLAUDE_PROFILE_SET_TOKEN, ["p-1", "   "]],
		[IPC_CHANNELS.CLAUDE_PROFILE_UPDATE_AUTO_SWITCH, [{ enabled: true, extra: 1 }]],
		[IPC_CHANNELS.CLAUDE_PROFILE_UPDATE_AUTO_SWITCH, [{ sessionThreshold: 101 }]],
		[IPC_CHANNELS.CLAUDE_PROFILE_UPDATE_AUTO_SWITCH, [{ usageCheckInterval: -1 }]],
		[IPC_CHANNELS.ACCOUNT_PRIORITY_SET, [["oauth-a", 3]]],
		[IPC_CHANNELS.CLAUDE_RETRY_WITH_PROFILE, [{ source: "task", projectId: "p-1" }]],
		[IPC_CHANNELS.ALL_PROFILES_USAGE_REQUEST, ["yes"]],
		[IPC_CHANNELS.TERMINAL_GET_SESSIONS_FOR_DATE, ["../../etc", "/repo"]],
		[IPC_CHANNELS.TERMINAL_RESTORE_SESSION, [{ id: 3 }]],
		[IPC_CHANNELS.TERMINAL_UPDATE_DISPLAY_ORDERS, ["/repo", [{ terminalId: "t-1", displayOrder: -1 }]]],
		[IPC_CHANNELS.TERMINAL_SET_WORKTREE_CONFIG, ["t-1", "main"]],
	])("refuses %s with %j", (channel, args) => {
		expect(terminalArgsAllowed(channel, args)).toBe(false);
	});

	it.each([
		[IPC_CHANNELS.TERMINAL_CREATE, [{ id: "t-1", cwd: "/repo", cols: 80, rows: 24, projectPath: "/repo" }]],
		[IPC_CHANNELS.TERMINAL_CREATE, [{ id: "t-1", skipOAuthToken: true, env: {} }]],
		[IPC_CHANNELS.CLAUDE_PROFILE_SAVE, [{ id: "", name: "Work", isDefault: false }]],
		[IPC_CHANNELS.TERMINAL_SET_WORKTREE_CONFIG, ["t-1", null]],
		[IPC_CHANNELS.TERMINAL_RESTORE_FROM_DATE, ["2026-11-16", "/repo"]],
		[IPC_CHANNELS.USAGE_REQUEST, []],
		[IPC_CHANNELS.CLAUDE_PROFILE_UPDATE_AUTO_SWITCH, [{ enabled: true, usageCheckInterval: 30000, weeklyThreshold: 99 }]],
	])("lets %s through with %j", (channel, args) => {
		expect(terminalArgsAllowed(channel, args)).toBe(true);
	});

	it("takes a profile's folder under the home folder as the terminal's only variable", () => {
		const env = { CLAUDE_CONFIG_DIR: path.join(state.home, ".claude-profiles", "work") };
		expect(terminalArgsAllowed(IPC_CHANNELS.TERMINAL_CREATE, [{ id: "t-1", env }])).toBe(true);
	});

	it("rejects a refused invoke before the handler runs, and drops a refused send", async () => {
		await expect(invoke(IPC_CHANNELS.TERMINAL_DESTROY, "")).rejects.toThrow("Invalid terminal arguments");
		send(IPC_CHANNELS.TERMINAL_INPUT, "t-1", { text: "ls" });
		expect(terminals.destroy).not.toHaveBeenCalled();
		expect(terminals.write).not.toHaveBeenCalled();
	});
});

describe("a terminal", () => {
	it("is created, closed, written to and resized through the manager", async () => {
		terminals.create.mockResolvedValue({ success: true });
		terminals.destroy.mockResolvedValue({ success: true });
		terminals.resize.mockReturnValue(true);
		const options = { id: "t-1", cwd: "/repo" };

		await expect(invoke(IPC_CHANNELS.TERMINAL_CREATE, options)).resolves.toEqual({ success: true });
		await expect(invoke(IPC_CHANNELS.TERMINAL_DESTROY, "t-1")).resolves.toEqual({ success: true });
		send(IPC_CHANNELS.TERMINAL_INPUT, "t-1", "ls\r");
		await expect(invoke(IPC_CHANNELS.TERMINAL_RESIZE, "t-1", 120, 40)).resolves.toEqual({
			success: true,
			data: { success: true },
		});

		expect(terminals.create).toHaveBeenCalledWith(options);
		expect(terminals.write).toHaveBeenCalledWith("t-1", "ls\r");
		expect(terminals.resize).toHaveBeenCalledWith("t-1", 120, 40);
	});

	it("answers the manager's failure to create it", async () => {
		terminals.create.mockRejectedValueOnce(new Error("no pty"));
		await expect(invoke(IPC_CHANNELS.TERMINAL_CREATE, { id: "t-1" })).resolves.toEqual({
			success: false,
			error: "no pty",
		});
		terminals.create.mockRejectedValueOnce("gone");
		await expect(invoke(IPC_CHANNELS.TERMINAL_CREATE, { id: "t-1" })).resolves.toEqual({
			success: false,
			error: "Failed to create terminal (exception)",
		});
	});

	it("starts Claude with the permissions mode of the settings, never one the renderer names", async () => {
		state.settings = { dangerouslySkipPermissions: true };
		send(IPC_CHANNELS.TERMINAL_INVOKE_CLAUDE, "t-1", "/repo");
		await tick();
		state.settings = null;
		send(IPC_CHANNELS.TERMINAL_INVOKE_CLAUDE, "t-2");
		await tick();
		expect(terminals.invokeClaudeAsync.mock.calls).toEqual([
			["t-1", "/repo", undefined, true],
			["t-2", undefined, undefined, false],
		]);
	});

	it("starts nothing when the settings cannot be read, and says so", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		state.settingsError = new Error("unreadable");
		send(IPC_CHANNELS.TERMINAL_INVOKE_CLAUDE, "t-1");
		await tick();
		expect(terminals.invokeClaudeAsync).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalledWith("[terminal-handlers] Failed to invoke Claude:", state.settingsError);
		warn.mockRestore();
	});

	it("is named from its command, or says it could not be", async () => {
		await expect(invoke(IPC_CHANNELS.TERMINAL_GENERATE_NAME, "npm run build")).resolves.toEqual({
			success: true,
			data: "build",
		});
		state.name = null;
		await expect(invoke(IPC_CHANNELS.TERMINAL_GENERATE_NAME, "ls", "/repo")).resolves.toEqual({
			success: false,
			error: "Failed to generate terminal name",
		});
		state.nameError = new Error("model down");
		await expect(invoke(IPC_CHANNELS.TERMINAL_GENERATE_NAME, "ls")).resolves.toEqual({
			success: false,
			error: "model down",
		});
	});

	it("keeps the title and worktree the person gave it", () => {
		const config = { name: "feat", worktreePath: "/repo/.worktrees/feat" };
		send(IPC_CHANNELS.TERMINAL_SET_TITLE, "t-1", "Build");
		send(IPC_CHANNELS.TERMINAL_SET_WORKTREE_CONFIG, "t-1", config);
		send(IPC_CHANNELS.TERMINAL_SET_WORKTREE_CONFIG, "t-1", null);
		expect(terminals.setTitle).toHaveBeenCalledWith("t-1", "Build");
		expect(terminals.setWorktreeConfig.mock.calls).toEqual([
			["t-1", config],
			["t-1", undefined],
		]);
	});

	it("says whether its process is alive", async () => {
		terminals.isTerminalAlive.mockReturnValueOnce(true).mockImplementationOnce(thrower(new Error("no such")));
		await expect(invoke(IPC_CHANNELS.TERMINAL_CHECK_PTY_ALIVE, "t-1")).resolves.toEqual({
			success: true,
			data: { alive: true },
		});
		await expect(invoke(IPC_CHANNELS.TERMINAL_CHECK_PTY_ALIVE, "t-1")).resolves.toEqual({
			success: false,
			error: "no such",
		});
	});
});

describe("terminal sessions", () => {
	it("are listed, restored and reordered for a project", async () => {
		const session = { id: "t-1", cwd: "/repo" };
		terminals.getSavedSessions.mockReturnValue([session]);
		terminals.restore.mockResolvedValue({ success: true, outputBuffer: "$ ls" });
		terminals.getAvailableSessionDates.mockReturnValue([{ date: "2026-11-16" }]);
		terminals.getSessionsForDate.mockReturnValue([session]);
		terminals.restoreSessionsFromDate.mockResolvedValue({ restored: 1 });
		const orders = [{ terminalId: "t-1", displayOrder: 0 }];

		await expect(invoke(IPC_CHANNELS.TERMINAL_GET_SESSIONS, "/repo")).resolves.toEqual({
			success: true,
			data: [session],
		});
		await expect(invoke(IPC_CHANNELS.TERMINAL_RESTORE_SESSION, session, 100, 30)).resolves.toEqual({
			success: true,
			data: { success: true, terminalId: "t-1", outputBuffer: "$ ls", error: undefined },
		});
		await expect(invoke(IPC_CHANNELS.TERMINAL_GET_SESSION_DATES)).resolves.toEqual({
			success: true,
			data: [{ date: "2026-11-16" }],
		});
		await expect(invoke(IPC_CHANNELS.TERMINAL_GET_SESSIONS_FOR_DATE, "2026-11-16", "/repo")).resolves.toEqual({
			success: true,
			data: [session],
		});
		await expect(invoke(IPC_CHANNELS.TERMINAL_RESTORE_FROM_DATE, "2026-11-16", "/repo")).resolves.toEqual({
			success: true,
			data: { restored: 1 },
		});
		await expect(invoke(IPC_CHANNELS.TERMINAL_RESTORE_FROM_DATE, "2026-11-16", "/repo", 132, 50)).resolves
			.toMatchObject({ success: true });
		await expect(invoke(IPC_CHANNELS.TERMINAL_UPDATE_DISPLAY_ORDERS, "/repo", orders)).resolves.toEqual({
			success: true,
		});

		expect(terminals.restore).toHaveBeenCalledWith(session, 100, 30);
		expect(terminals.restoreSessionsFromDate.mock.calls).toEqual([
			["2026-11-16", "/repo", 80, 24],
			["2026-11-16", "/repo", 132, 50],
		]);
		expect(terminals.updateDisplayOrders).toHaveBeenCalledWith("/repo", orders);
	});

	it("answer a failure of the session store with its message, or a default one", async () => {
		const broken = new Error("store locked");
		terminals.getSavedSessions.mockImplementation(thrower(broken));
		terminals.restore.mockRejectedValue("gone");
		terminals.getAvailableSessionDates.mockImplementation(thrower(broken));
		terminals.getSessionsForDate.mockImplementation(thrower("gone"));
		terminals.restoreSessionsFromDate.mockRejectedValue(broken);
		terminals.updateDisplayOrders.mockImplementation(thrower("gone"));

		const answers = await Promise.all([
			invoke(IPC_CHANNELS.TERMINAL_GET_SESSIONS, "/repo"),
			invoke(IPC_CHANNELS.TERMINAL_RESTORE_SESSION, { id: "t-1" }),
			invoke(IPC_CHANNELS.TERMINAL_GET_SESSION_DATES, "/repo"),
			invoke(IPC_CHANNELS.TERMINAL_GET_SESSIONS_FOR_DATE, "2026-11-16", "/repo"),
			invoke(IPC_CHANNELS.TERMINAL_RESTORE_FROM_DATE, "2026-11-16", "/repo"),
			invoke(IPC_CHANNELS.TERMINAL_UPDATE_DISPLAY_ORDERS, "/repo", []),
			invoke(IPC_CHANNELS.TERMINAL_CHECK_PTY_ALIVE, "t-1").then(() =>
				invoke(IPC_CHANNELS.TERMINAL_CHECK_PTY_ALIVE, "t-1"),
			),
		]);
		expect(answers.slice(0, 6).map((a) => (a as { error: string }).error)).toEqual([
			"store locked",
			"Failed to restore terminal session",
			"store locked",
			"Failed to get sessions for date",
			"store locked",
			"Failed to update display orders",
		]);
	});

	it("resume Claude when the terminal becomes active, and say when it could not", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		terminals.activateDeferredResume.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("gone"));
		send(IPC_CHANNELS.TERMINAL_ACTIVATE_DEFERRED_RESUME, "t-1");
		send(IPC_CHANNELS.TERMINAL_ACTIVATE_DEFERRED_RESUME, "t-2");
		await tick();
		expect(terminals.activateDeferredResume.mock.calls).toEqual([["t-1"], ["t-2"]]);
		expect(warn).toHaveBeenCalledTimes(1);
		warn.mockRestore();
	});
});

describe("Claude profiles", () => {
	const stored = {
		id: "work",
		name: "Work",
		isDefault: false,
		oauthToken: "enc:stored-token",
		createdAt: new Date(0),
	};

	it("reach the renderer with their token masked", async () => {
		profiles.getSettings.mockReturnValue({ activeProfileId: "work", profiles: [stored] });
		const result = (await invoke(IPC_CHANNELS.CLAUDE_PROFILES_GET)) as {
			data: { profiles: { oauthToken?: string }[] };
		};
		expect(result.data.profiles[0].oauthToken).toBe(MASKED_SECRET);
		profiles.getSettings.mockImplementation(thrower("broken"));
		await expect(invoke(IPC_CHANNELS.CLAUDE_PROFILES_GET)).resolves.toEqual({
			success: false,
			error: "Failed to get Claude profiles",
		});
	});

	it("saved back with the mask keep their stored token, and come back masked", async () => {
		const configDir = path.join(state.home, "work");
		profiles.getProfile.mockReturnValue(stored);
		profiles.saveProfile.mockImplementation((profile) => profile);

		const result = (await invoke(IPC_CHANNELS.CLAUDE_PROFILE_SAVE, {
			...stored,
			configDir,
			oauthToken: MASKED_SECRET,
		})) as { success: boolean; data: { oauthToken: string } };

		expect(profiles.saveProfile.mock.calls[0][0]).toMatchObject({ oauthToken: "enc:stored-token", configDir });
		expect(result.data.oauthToken).toBe(MASKED_SECRET);
		expect(existsSync(configDir)).toBe(true);
	});

	it("saved with a folder that exists keep it as it is", async () => {
		profiles.saveProfile.mockImplementation((profile) => profile);
		await expect(
			invoke(IPC_CHANNELS.CLAUDE_PROFILE_SAVE, { id: "work", name: "Work", configDir: state.home }),
		).resolves.toMatchObject({ success: true, data: { configDir: state.home } });
	});

	it("new and without a folder get an id and their own folder, made under the home folder", async () => {
		profiles.generateProfileId.mockReturnValue("profile-personal");
		profiles.saveProfile.mockImplementation((profile) => profile);

		await invoke(IPC_CHANNELS.CLAUDE_PROFILE_SAVE, { id: "", name: "Personal", isDefault: false });

		const saved = profiles.saveProfile.mock.calls[0][0];
		expect(saved.id).toBe("profile-personal");
		expect(saved.configDir).toBe(path.join(state.home, ".claude-profiles", "personal"));
		expect(existsSync(saved.configDir)).toBe(true);
		expect(profiles.getProfile).not.toHaveBeenCalled();
	});

	it("are refused a folder outside the home folder, and the default one needs none", async () => {
		profiles.saveProfile.mockImplementation((profile) => profile);
		await expect(
			invoke(IPC_CHANNELS.CLAUDE_PROFILE_SAVE, { id: "work", name: "Work", configDir: "/etc/claude" }),
		).resolves.toMatchObject({ success: false, error: expect.stringContaining("/etc/claude") });
		expect(profiles.saveProfile).not.toHaveBeenCalled();

		await expect(
			invoke(IPC_CHANNELS.CLAUDE_PROFILE_SAVE, { id: "default", name: "Default", isDefault: true }),
		).resolves.toMatchObject({ success: true, data: { id: "default" } });
		expect(state.madeDirs).toEqual([]);

		profiles.saveProfile.mockImplementation(thrower(new Error("disk full")));
		await expect(
			invoke(IPC_CHANNELS.CLAUDE_PROFILE_SAVE, { id: "default", name: "Default", isDefault: true }),
		).resolves.toEqual({ success: false, error: "disk full" });
	});

	it("are deleted and renamed unless the manager refuses", async () => {
		profiles.deleteProfile.mockReturnValueOnce(true).mockReturnValueOnce(false).mockImplementationOnce(thrower("x"));
		profiles.renameProfile.mockReturnValueOnce(true).mockReturnValueOnce(false).mockImplementationOnce(thrower("x"));
		const deletes = [];
		const renames = [];
		for (let i = 0; i < 3; i++) {
			deletes.push(await invoke(IPC_CHANNELS.CLAUDE_PROFILE_DELETE, "work"));
			renames.push(await invoke(IPC_CHANNELS.CLAUDE_PROFILE_RENAME, "work", "Job"));
		}
		expect(deletes).toEqual([
			{ success: true },
			{ success: false, error: "Cannot delete default or last profile" },
			{ success: false, error: "Failed to delete Claude profile" },
		]);
		expect(renames).toEqual([
			{ success: true },
			{ success: false, error: "Profile not found or invalid name" },
			{ success: false, error: "Failed to rename Claude profile" },
		]);
	});

	it("take a token typed or captured for them, unless the profile is unknown", async () => {
		profiles.setProfileToken.mockReturnValueOnce(true).mockReturnValueOnce(false).mockImplementationOnce(thrower("x"));
		const token = "sk-ant-oat01-test-0000"; // pragma: allowlist secret
		await expect(invoke(IPC_CHANNELS.CLAUDE_PROFILE_SET_TOKEN, "work", token, "a@b.test")).resolves.toEqual({
			success: true,
		});
		await expect(invoke(IPC_CHANNELS.CLAUDE_PROFILE_SET_TOKEN, "gone", token)).resolves.toEqual({
			success: false,
			error: "Profile not found",
		});
		await expect(invoke(IPC_CHANNELS.CLAUDE_PROFILE_SET_TOKEN, "work", token)).resolves.toEqual({
			success: false,
			error: "Failed to set OAuth token",
		});
		expect(profiles.setProfileToken).toHaveBeenCalledWith("work", token, "a@b.test");
	});

	it("switch a terminal's profile through the manager", async () => {
		terminals.switchClaudeProfile.mockResolvedValueOnce({ success: true }).mockRejectedValueOnce("x");
		await expect(invoke(IPC_CHANNELS.CLAUDE_PROFILE_SWITCH, "t-1", "work")).resolves.toEqual({ success: true });
		await expect(invoke(IPC_CHANNELS.CLAUDE_PROFILE_SWITCH, "t-1", "work")).resolves.toEqual({
			success: false,
			error: "Failed to switch Claude profile",
		});
	});
});

describe("the active profile", () => {
	beforeEach(() => {
		profiles.getActiveProfile.mockReturnValue({ id: "home", configDir: "/cfg/home" });
		profiles.setActiveProfile.mockReturnValue(true);
		profiles.getProfile.mockReturnValue({ id: "work", configDir: "/cfg/work" });
		terminals.getTerminalsForProfileChange.mockReturnValue([
			{ id: "t-1", cwd: "/repo", claudeSessionId: "s-1" },
			{ id: "t-2", cwd: "/repo" },
		]);
	});

	it("moves each Claude session to the new profile and has the terminals recreated", async () => {
		state.migrated = false;
		await expect(invoke(IPC_CHANNELS.CLAUDE_PROFILE_SET_ACTIVE, "work")).resolves.toEqual({ success: true });
		expect(state.migrations).toEqual([["/cfg/home", "/cfg/work", "/repo", "s-1"]]);
		expect(state.window?.webContents.send).toHaveBeenCalledWith(IPC_CHANNELS.TERMINAL_PROFILE_CHANGED, {
			previousProfileId: "home",
			newProfileId: "work",
			terminals: [
				{ id: "t-1", sessionId: "s-1", sessionMigrated: false },
				{ id: "t-2", sessionId: undefined, sessionMigrated: false },
			],
		});
	});

	it("tells no window that is gone, and moves no session without both folders", async () => {
		profiles.getProfile.mockReturnValue({ id: "work" });
		state.window = { isDestroyed: () => true, webContents: { send: vi.fn() } };
		await invoke(IPC_CHANNELS.CLAUDE_PROFILE_SET_ACTIVE, "work");
		state.window = null;
		await expect(invoke(IPC_CHANNELS.CLAUDE_PROFILE_SET_ACTIVE, "work")).resolves.toEqual({ success: true });
		expect(state.migrations).toEqual([]);
	});

	it("changes nothing when it is already active, and refuses an unknown one", async () => {
		await invoke(IPC_CHANNELS.CLAUDE_PROFILE_SET_ACTIVE, "home");
		expect(terminals.getTerminalsForProfileChange).not.toHaveBeenCalled();
		profiles.setActiveProfile.mockReturnValue(false);
		await expect(invoke(IPC_CHANNELS.CLAUDE_PROFILE_SET_ACTIVE, "gone")).resolves.toEqual({
			success: false,
			error: "Profile not found",
		});
		profiles.getActiveProfile.mockImplementation(thrower("x"));
		await expect(invoke(IPC_CHANNELS.CLAUDE_PROFILE_SET_ACTIVE, "work")).resolves.toEqual({
			success: false,
			error: "Failed to set active Claude profile",
		});
	});

	it("after a rate limit is switched only for a known project and profile", async () => {
		const request = { source: "task", projectId: "p-1", profileId: "work" };
		await expect(invoke(IPC_CHANNELS.CLAUDE_RETRY_WITH_PROFILE, request)).resolves.toEqual({ success: true });
		await expect(
			invoke(IPC_CHANNELS.CLAUDE_RETRY_WITH_PROFILE, { ...request, projectId: "p-9" }),
		).resolves.toEqual({ success: false, error: "Project not found" });
		expect(profiles.setActiveProfile).toHaveBeenCalledTimes(1);
		profiles.setActiveProfile.mockReturnValue(false);
		await expect(invoke(IPC_CHANNELS.CLAUDE_RETRY_WITH_PROFILE, request)).resolves.toEqual({
			success: false,
			error: "Profile not found",
		});
		profiles.setActiveProfile.mockImplementation(thrower("x"));
		await expect(invoke(IPC_CHANNELS.CLAUDE_RETRY_WITH_PROFILE, request)).resolves.toEqual({
			success: false,
			error: "Failed to retry with profile",
		});
	});
});

describe("auto-switching and account order", () => {
	it("are read and saved, and saving restarts the usage monitor", async () => {
		profiles.getAutoSwitchSettings.mockReturnValue({ enabled: true });
		profiles.getAccountPriorityOrder.mockReturnValue(["oauth-work", "api-x"]);

		await expect(invoke(IPC_CHANNELS.CLAUDE_PROFILE_AUTO_SWITCH_SETTINGS)).resolves.toEqual({
			success: true,
			data: { enabled: true },
		});
		await expect(invoke(IPC_CHANNELS.CLAUDE_PROFILE_UPDATE_AUTO_SWITCH, { sessionThreshold: 90 })).resolves.toEqual({
			success: true,
		});
		await expect(invoke(IPC_CHANNELS.ACCOUNT_PRIORITY_GET)).resolves.toEqual({
			success: true,
			data: ["oauth-work", "api-x"],
		});
		await expect(invoke(IPC_CHANNELS.ACCOUNT_PRIORITY_SET, ["api-x", "oauth-work"])).resolves.toEqual({
			success: true,
		});

		expect(profiles.updateAutoSwitchSettings).toHaveBeenCalledWith({ sessionThreshold: 90 });
		expect(usage.stop).toHaveBeenCalled();
		expect(usage.start).toHaveBeenCalled();
		expect(profiles.setAccountPriorityOrder).toHaveBeenCalledWith(["api-x", "oauth-work"]);
	});

	it("answer the manager's failures", async () => {
		profiles.getAutoSwitchSettings.mockImplementation(thrower("x"));
		profiles.updateAutoSwitchSettings.mockImplementation(thrower(new Error("locked")));
		profiles.getAccountPriorityOrder.mockImplementation(thrower("x"));
		profiles.setAccountPriorityOrder.mockImplementation(thrower("x"));
		const answers = [
			await invoke(IPC_CHANNELS.CLAUDE_PROFILE_AUTO_SWITCH_SETTINGS),
			await invoke(IPC_CHANNELS.CLAUDE_PROFILE_UPDATE_AUTO_SWITCH, {}),
			await invoke(IPC_CHANNELS.ACCOUNT_PRIORITY_GET),
			await invoke(IPC_CHANNELS.ACCOUNT_PRIORITY_SET, []),
		];
		expect(answers.map((a) => (a as { error: string }).error)).toEqual([
			"Failed to get auto-switch settings",
			"locked",
			"Failed to get account priority order",
			"Failed to set account priority order",
		]);
		expect(usage.start).not.toHaveBeenCalled();
	});
});

describe("usage", () => {
	it("of a named provider is read fresh, and also sent to the listening views", async () => {
		const snapshot = { provider: "anthropic", sessionPercent: 12 };
		usage.getUsageForProvider.mockResolvedValue(snapshot);
		const heard: unknown[] = [];
		usage.on("usage-updated", (value) => heard.push(value));

		await expect(invoke(IPC_CHANNELS.USAGE_REQUEST, "anthropic")).resolves.toEqual({
			success: true,
			data: snapshot,
		});
		expect(usage.onProviderRequestIfChanged).toHaveBeenCalledWith("anthropic");
		expect(heard).toEqual([snapshot]);
	});

	it("without a provider is the current one, sent to no one when there is none", async () => {
		usage.getCurrentUsage.mockReturnValue(null);
		const heard: unknown[] = [];
		usage.on("usage-updated", (value) => heard.push(value));
		await expect(invoke(IPC_CHANNELS.USAGE_REQUEST)).resolves.toEqual({ success: true, data: null });
		expect(heard).toEqual([]);
		usage.getCurrentUsage.mockImplementation(thrower("x"));
		await expect(invoke(IPC_CHANNELS.USAGE_REQUEST)).resolves.toEqual({
			success: false,
			error: "Failed to get current usage",
		});
	});

	it("of every profile is read, from the cache unless asked otherwise", async () => {
		usage.getAllProfilesUsage.mockResolvedValueOnce({ profiles: [] }).mockResolvedValueOnce(null).mockRejectedValueOnce("x");
		await expect(invoke(IPC_CHANNELS.ALL_PROFILES_USAGE_REQUEST)).resolves.toEqual({
			success: true,
			data: { profiles: [] },
		});
		await invoke(IPC_CHANNELS.ALL_PROFILES_USAGE_REQUEST, true);
		expect(usage.getAllProfilesUsage.mock.calls).toEqual([[false], [true]]);
		await expect(invoke(IPC_CHANNELS.ALL_PROFILES_USAGE_REQUEST)).resolves.toEqual({
			success: false,
			error: "Failed to get all profiles usage",
		});
	});

	it("events reach the window once forwarding starts", () => {
		const window = { webContents: { send: vi.fn() } };
		initializeUsageMonitorForwarding(window as never);
		usage.emit("usage-updated", { a: 1 });
		usage.emit("all-profiles-usage-updated", { b: 2 });
		usage.emit("show-swap-notification", { c: 3 });
		expect(window.webContents.send.mock.calls).toEqual([
			[IPC_CHANNELS.USAGE_UPDATED, { a: 1 }],
			[IPC_CHANNELS.ALL_PROFILES_USAGE_UPDATED, { b: 2 }],
			[IPC_CHANNELS.PROACTIVE_SWAP_NOTIFICATION, { c: 3 }],
		]);
	});
});
