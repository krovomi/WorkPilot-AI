/**
 * The terminals of the app and the Claude profiles they run with: create,
 * write to, resize and close a terminal, start Claude in it, name it, keep
 * and restore its session by day; the profiles (never their token, rule S6),
 * the active one, auto-switching and the order accounts are tried in; the
 * usage the monitor reads. Every argument is checked by
 * `terminal/terminal-ipc-guard.ts` before a handler runs.
 */

import { existsSync, mkdirSync } from "node:fs";
import type { BrowserWindow } from "electron";
import { IPC_CHANNELS } from "../../shared/constants";
import type {
	AllProfilesUsage,
	ClaudeAutoSwitchSettings,
	ClaudeProfile,
	ClaudeProfileSettings,
	IPCResult,
	RetryWithProfileRequest,
	TerminalCreateOptions,
	TerminalRestoreResult,
	TerminalSession,
	TerminalWorktreeConfig,
	UsageSnapshot,
} from "../../shared/types";
import { createProfileDirectory } from "../claude-profile/profile-utils";
import { maskClaudeProfile, maskClaudeProfileSettings, unmaskClaudeProfile } from "../claude-profile/renderer-view";
import { migrateSession } from "../claude-profile/session-utils";
import { getUsageMonitor } from "../claude-profile/usage-monitor";
import { getClaudeProfileManager } from "../claude-profile-manager";
import { projectStore } from "../project-store";
import { readSettingsFileAsync } from "../settings-utils";
import type { TerminalManager } from "../terminal-manager";
import { terminalNameGenerator } from "../terminal-name-generator";
import { isValidConfigDir } from "../utils/config-path-validator";
import { terminalIpcMain } from "./terminal/terminal-ipc-guard";

/** `run`'s answer, or its error as a failed answer (`fallback` when it has no message). */
async function answer<T>(fallback: string, run: () => IPCResult<T> | Promise<IPCResult<T>>): Promise<IPCResult<T>> {
	try {
		return await run();
	} catch (error) {
		return { success: false, error: error instanceof Error ? error.message : fallback };
	}
}

const done = <T>(data?: T): IPCResult<T> => (data === undefined ? { success: true } : { success: true, data });
const refused = (error: string): IPCResult<never> => ({ success: false, error });

/**
 * The profile the settings send, ready to save: its stored token kept when
 * the renderer sent back the mask, an id when new, and for a profile other
 * than the default its own folder under the home folder, made if missing.
 */
async function profileToSave(received: ClaudeProfile): Promise<ClaudeProfile | string> {
	const manager = getClaudeProfileManager();
	const profile = unmaskClaudeProfile(received, received.id ? manager.getProfile(received.id) : undefined);
	if (!profile.id) profile.id = manager.generateProfileId(profile.name);
	if (profile.isDefault) return profile;
	if (!profile.configDir) profile.configDir = await createProfileDirectory(profile.name);
	if (!isValidConfigDir(profile.configDir)) {
		return `Invalid config directory path: ${profile.configDir}. Config directories must be within the user's home directory.`;
	}
	if (!existsSync(profile.configDir)) mkdirSync(profile.configDir, { recursive: true });
	return profile;
}

/**
 * Makes `profileId` the active profile. When it changes, each terminal's
 * Claude session moves to the new profile's folder and the renderer is told
 * to recreate the terminals, whose environment cannot change in place.
 */
function setActiveProfile(
	terminalManager: TerminalManager,
	getMainWindow: () => BrowserWindow | null,
	profileId: string,
): IPCResult {
	const manager = getClaudeProfileManager();
	const previous = manager.getActiveProfile();
	if (!manager.setActiveProfile(profileId)) return refused("Profile not found");
	if (previous.id === profileId) return done();

	const from = previous.configDir;
	const to = manager.getProfile(profileId)?.configDir;
	const terminals = terminalManager.getTerminalsForProfileChange().map((terminal) => ({
		id: terminal.id,
		sessionId: terminal.claudeSessionId,
		sessionMigrated:
			terminal.claudeSessionId && from && to
				? migrateSession(from, to, terminal.cwd, terminal.claudeSessionId).success
				: false,
	}));

	const window = getMainWindow();
	if (window && !window.isDestroyed()) {
		window.webContents.send(IPC_CHANNELS.TERMINAL_PROFILE_CHANGED, {
			previousProfileId: previous.id,
			newProfileId: profileId,
			terminals,
		});
	}
	return done();
}

function registerTerminalOperations(terminalManager: TerminalManager): void {
	terminalIpcMain.handle(IPC_CHANNELS.TERMINAL_CREATE, (_, options: TerminalCreateOptions) =>
		answer("Failed to create terminal (exception)", () => terminalManager.create(options)),
	);

	terminalIpcMain.handle(IPC_CHANNELS.TERMINAL_DESTROY, (_, id: string) => terminalManager.destroy(id));

	terminalIpcMain.on(IPC_CHANNELS.TERMINAL_INPUT, (_, id: string, data: string) => {
		terminalManager.write(id, data);
	});

	terminalIpcMain.handle(IPC_CHANNELS.TERMINAL_RESIZE, (_, id: string, cols: number, rows: number) => {
		const success = terminalManager.resize(id, cols, rows);
		return { success, data: { success } };
	});

	terminalIpcMain.on(IPC_CHANNELS.TERMINAL_INVOKE_CLAUDE, (_, id: string, cwd?: string) => {
		// YOLO mode (skip permissions) is read from the settings, never from the renderer
		readSettingsFileAsync()
			.then((settings) =>
				terminalManager.invokeClaudeAsync(id, cwd, undefined, settings?.dangerouslySkipPermissions === true),
			)
			.catch((error) => console.warn("[terminal-handlers] Failed to invoke Claude:", error));
	});

	terminalIpcMain.handle(IPC_CHANNELS.TERMINAL_GENERATE_NAME, (_, command: string, cwd?: string) =>
		answer<string>("Failed to generate terminal name", async () => {
			const name = await terminalNameGenerator.generateName(command, cwd);
			return name ? done(name) : refused("Failed to generate terminal name");
		}),
	);

	terminalIpcMain.on(IPC_CHANNELS.TERMINAL_SET_TITLE, (_, id: string, title: string) => {
		terminalManager.setTitle(id, title);
	});

	terminalIpcMain.on(
		IPC_CHANNELS.TERMINAL_SET_WORKTREE_CONFIG,
		(_, id: string, config: TerminalWorktreeConfig | undefined) => {
			terminalManager.setWorktreeConfig(id, config ?? undefined);
		},
	);

	terminalIpcMain.handle(IPC_CHANNELS.TERMINAL_CHECK_PTY_ALIVE, (_, terminalId: string) =>
		answer("Failed to check terminal status", () => done({ alive: terminalManager.isTerminalAlive(terminalId) })),
	);
}

function registerSessionHandlers(terminalManager: TerminalManager): void {
	terminalIpcMain.handle(IPC_CHANNELS.TERMINAL_GET_SESSIONS, (_, projectPath: string) =>
		answer<TerminalSession[]>("Failed to get terminal sessions", () =>
			done(terminalManager.getSavedSessions(projectPath)),
		),
	);

	terminalIpcMain.handle(
		IPC_CHANNELS.TERMINAL_RESTORE_SESSION,
		(_, session: TerminalSession, cols?: number, rows?: number) =>
			answer<TerminalRestoreResult>("Failed to restore terminal session", async () => {
				const result = await terminalManager.restore(session, cols, rows);
				return {
					success: result.success,
					data: {
						success: result.success,
						terminalId: session.id,
						outputBuffer: result.outputBuffer,
						error: result.error,
					},
				};
			}),
	);

	terminalIpcMain.on(IPC_CHANNELS.TERMINAL_ACTIVATE_DEFERRED_RESUME, (_, id: string) => {
		terminalManager
			.activateDeferredResume(id)
			.catch((error) => console.warn("[terminal-handlers] Failed to activate deferred resume:", error));
	});

	terminalIpcMain.handle(IPC_CHANNELS.TERMINAL_GET_SESSION_DATES, (_, projectPath?: string) =>
		answer("Failed to get session dates", () => done(terminalManager.getAvailableSessionDates(projectPath))),
	);

	terminalIpcMain.handle(IPC_CHANNELS.TERMINAL_GET_SESSIONS_FOR_DATE, (_, date: string, projectPath: string) =>
		answer("Failed to get sessions for date", () => done(terminalManager.getSessionsForDate(date, projectPath))),
	);

	terminalIpcMain.handle(
		IPC_CHANNELS.TERMINAL_RESTORE_FROM_DATE,
		(_, date: string, projectPath: string, cols = 80, rows = 24) =>
			answer("Failed to restore sessions from date", async () =>
				done(await terminalManager.restoreSessionsFromDate(date, projectPath, cols, rows)),
			),
	);

	terminalIpcMain.handle(
		IPC_CHANNELS.TERMINAL_UPDATE_DISPLAY_ORDERS,
		(_, projectPath: string, orders: Array<{ terminalId: string; displayOrder: number }>) =>
			answer("Failed to update display orders", () => {
				terminalManager.updateDisplayOrders(projectPath, orders);
				return done();
			}),
	);
}

function registerProfileHandlers(terminalManager: TerminalManager, getMainWindow: () => BrowserWindow | null): void {
	terminalIpcMain.handle(IPC_CHANNELS.CLAUDE_PROFILES_GET, () =>
		answer<ClaudeProfileSettings>("Failed to get Claude profiles", () =>
			// Which profiles have a token, never the token (S6)
			done(maskClaudeProfileSettings(getClaudeProfileManager().getSettings())),
		),
	);

	terminalIpcMain.handle(IPC_CHANNELS.CLAUDE_PROFILE_SAVE, (_, received: ClaudeProfile) =>
		answer<ClaudeProfile>("Failed to save Claude profile", async () => {
			const profile = await profileToSave(received);
			if (typeof profile === "string") return refused(profile);
			return done(maskClaudeProfile(getClaudeProfileManager().saveProfile(profile)));
		}),
	);

	terminalIpcMain.handle(IPC_CHANNELS.CLAUDE_PROFILE_DELETE, (_, profileId: string) =>
		answer("Failed to delete Claude profile", () =>
			getClaudeProfileManager().deleteProfile(profileId) ? done() : refused("Cannot delete default or last profile"),
		),
	);

	terminalIpcMain.handle(IPC_CHANNELS.CLAUDE_PROFILE_RENAME, (_, profileId: string, newName: string) =>
		answer("Failed to rename Claude profile", () =>
			getClaudeProfileManager().renameProfile(profileId, newName)
				? done()
				: refused("Profile not found or invalid name"),
		),
	);

	terminalIpcMain.handle(IPC_CHANNELS.CLAUDE_PROFILE_SET_ACTIVE, (_, profileId: string) =>
		answer("Failed to set active Claude profile", () => setActiveProfile(terminalManager, getMainWindow, profileId)),
	);

	terminalIpcMain.handle(IPC_CHANNELS.CLAUDE_PROFILE_SWITCH, (_, terminalId: string, profileId: string) =>
		answer("Failed to switch Claude profile", () => terminalManager.switchClaudeProfile(terminalId, profileId)),
	);

	// A token captured from a terminal or typed in the settings
	terminalIpcMain.handle(
		IPC_CHANNELS.CLAUDE_PROFILE_SET_TOKEN,
		(_, profileId: string, token: string, email?: string) =>
			answer("Failed to set OAuth token", () =>
				getClaudeProfileManager().setProfileToken(profileId, token, email) ? done() : refused("Profile not found"),
			),
	);

	terminalIpcMain.handle(IPC_CHANNELS.CLAUDE_PROFILE_AUTO_SWITCH_SETTINGS, () =>
		answer<ClaudeAutoSwitchSettings>("Failed to get auto-switch settings", () =>
			done(getClaudeProfileManager().getAutoSwitchSettings()),
		),
	);

	terminalIpcMain.handle(
		IPC_CHANNELS.CLAUDE_PROFILE_UPDATE_AUTO_SWITCH,
		(_, settings: Partial<ClaudeAutoSwitchSettings>) =>
			answer("Failed to update auto-switch settings", () => {
				getClaudeProfileManager().updateAutoSwitchSettings(settings);
				// The monitor reads the settings when it starts
				const monitor = getUsageMonitor();
				monitor.stop();
				monitor.start();
				return done();
			}),
	);

	terminalIpcMain.handle(IPC_CHANNELS.ACCOUNT_PRIORITY_GET, () =>
		answer<string[]>("Failed to get account priority order", () =>
			done(getClaudeProfileManager().getAccountPriorityOrder()),
		),
	);

	terminalIpcMain.handle(IPC_CHANNELS.ACCOUNT_PRIORITY_SET, (_, order: string[]) =>
		answer("Failed to set account priority order", () => {
			getClaudeProfileManager().setAccountPriorityOrder(order);
			return done();
		}),
	);

	// After a rate limit, the operation of a project runs again under another
	// profile: the view that started it re-submits it once the profile is active.
	terminalIpcMain.handle(IPC_CHANNELS.CLAUDE_RETRY_WITH_PROFILE, (_, request: RetryWithProfileRequest) =>
		answer("Failed to retry with profile", () => {
			if (!projectStore.getProject(request.projectId)) return refused("Project not found");
			if (!getClaudeProfileManager().setActiveProfile(request.profileId)) return refused("Profile not found");
			return done();
		}),
	);
}

function registerUsageHandlers(): void {
	// Fresh usage, also emitted so the views that listen stay in step
	terminalIpcMain.handle(IPC_CHANNELS.USAGE_REQUEST, (_, providerName?: string) =>
		answer<UsageSnapshot | null>("Failed to get current usage", async () => {
			const monitor = getUsageMonitor();
			let usage: UsageSnapshot | null;
			if (providerName) {
				// Caches reset only when the provider really changed, not on every poll
				monitor.onProviderRequestIfChanged(providerName);
				usage = await monitor.getUsageForProvider(providerName);
			} else {
				usage = monitor.getCurrentUsage();
			}
			if (usage) monitor.emit("usage-updated", usage);
			return done(usage) as IPCResult<UsageSnapshot | null>;
		}),
	);

	terminalIpcMain.handle(IPC_CHANNELS.ALL_PROFILES_USAGE_REQUEST, (_, forceRefresh = false) =>
		answer<AllProfilesUsage | null>("Failed to get all profiles usage", async () => ({
			success: true,
			data: await getUsageMonitor().getAllProfilesUsage(forceRefresh),
		})),
	);
}

/**
 * Register all terminal-related IPC handlers
 */
export function registerTerminalHandlers(
	terminalManager: TerminalManager,
	getMainWindow: () => BrowserWindow | null,
): void {
	registerTerminalOperations(terminalManager);
	registerSessionHandlers(terminalManager);
	registerProfileHandlers(terminalManager, getMainWindow);
	registerUsageHandlers();
}

/**
 * Forwards the usage monitor's events to the renderer; called once the main
 * window exists.
 */
export function initializeUsageMonitorForwarding(mainWindow: BrowserWindow): void {
	const monitor = getUsageMonitor();
	monitor.on("usage-updated", (usage: UsageSnapshot) => {
		mainWindow.webContents.send(IPC_CHANNELS.USAGE_UPDATED, usage);
	});
	monitor.on("all-profiles-usage-updated", (allProfilesUsage: AllProfilesUsage) => {
		mainWindow.webContents.send(IPC_CHANNELS.ALL_PROFILES_USAGE_UPDATED, allProfilesUsage);
	});
	monitor.on("show-swap-notification", (notification: unknown) => {
		mainWindow.webContents.send(IPC_CHANNELS.PROACTIVE_SWAP_NOTIFICATION, notification);
	});
}
