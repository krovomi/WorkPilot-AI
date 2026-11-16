/**
 * GitLab sign-in through the glab CLI, as `github/oauth-handlers.ts` does it
 * with gh. The renderer names an instance by its host (or URL), checked by
 * `glabHost`; glab runs by its resolved path, without a shell; the renderer
 * never receives the token glab holds, only MASKED_SECRET.
 */

import { execFileSync, spawn } from "node:child_process";
import { ipcMain } from "electron";
import { IPC_CHANNELS, MASKED_SECRET } from "../../../shared/constants";
import type { IPCResult } from "../../../shared/types";
import { getToolPath } from "../../cli-tool-manager";
import { findExecutable, getAugmentedEnv } from "../../env-utils";
import { openExternalUrl } from "../../open-external";
import { getCurrentOS } from "../../platform";
import { openTerminalWithCommand } from "../claude-code-handlers";
import type { GitLabAuthStartResult } from "./types";
import { getGlabToken, glabHost, glabHostArgs, runGlab } from "./utils";

const INVALID_INSTANCE = "Invalid GitLab instance";

function message(error: unknown, fallback: string): string {
	return error instanceof Error ? error.message : fallback;
}

/** The install command of glab on this OS, run in the user's terminal. */
export function glabInstallCommand(os: string): string {
	if (os === "darwin") return "brew install glab";
	if (os === "win32") return "winget install --id GitLab.glab";
	return "sudo snap install glab || brew install glab";
}

/** Whether glab is installed, and its version. */
export function registerCheckGlabCli(): void {
	ipcMain.handle(
		IPC_CHANNELS.GITLAB_CHECK_CLI,
		async (): Promise<IPCResult<{ installed: boolean; version?: string }>> => {
			const glabPath = findExecutable("glab");
			if (!glabPath) return { success: true, data: { installed: false } };
			try {
				const version = execFileSync(glabPath, ["--version"], {
					encoding: "utf-8",
					stdio: "pipe",
					env: getAugmentedEnv(),
				})
					.trim()
					.split("\n")[0];
				return { success: true, data: { installed: true, version } };
			} catch {
				return { success: true, data: { installed: false } };
			}
		},
	);
}

/** Opens the user's terminal on this OS's install command of glab. */
export function registerInstallGlabCli(): void {
	ipcMain.handle(
		IPC_CHANNELS.GITLAB_INSTALL_CLI,
		async (): Promise<IPCResult<{ command: string }>> => {
			const command = glabInstallCommand(getCurrentOS());
			try {
				await openTerminalWithCommand(command);
				return { success: true, data: { command } };
			} catch (error) {
				return {
					success: false,
					error: `Failed to open terminal for installation: ${message(error, "Unknown error")}`,
				};
			}
		},
	);
}

/** Whether glab is signed in to the instance, and as whom. */
export function registerCheckGlabAuth(): void {
	ipcMain.handle(
		IPC_CHANNELS.GITLAB_CHECK_AUTH,
		async (
			_event,
			instance?: unknown,
		): Promise<IPCResult<{ authenticated: boolean; username?: string }>> => {
			const host = glabHost(instance);
			if (!host) return { success: false, error: INVALID_INSTANCE };
			try {
				await runGlab(["auth", "status", ...glabHostArgs(host)]);
			} catch {
				return { success: true, data: { authenticated: false } };
			}
			try {
				const username = (
					await runGlab(["api", "user", "--jq", ".username", ...glabHostArgs(host)])
				).trim();
				return {
					success: true,
					data: { authenticated: true, ...(username ? { username } : {}) },
				};
			} catch {
				return { success: true, data: { authenticated: true } };
			}
		},
	);
}

/** The first URL of `text` on `host`, the page glab asks to open. */
export function signInUrlOn(text: string, host: string): string | undefined {
	for (const [candidate] of text.matchAll(/https?:\/\/[^\s"'<>]+/g)) {
		try {
			if (new URL(candidate).host === host) return candidate;
		} catch {
			// Not a URL after all: keep looking.
		}
	}
	return undefined;
}

/**
 * Runs `glab auth login --web` for the instance. The sign-in page glab prints
 * is opened once, by `openExternalUrl`, and only on the instance's host.
 */
export function registerStartGlabAuth(): void {
	ipcMain.handle(
		IPC_CHANNELS.GITLAB_START_AUTH,
		async (
			_event,
			instance?: unknown,
		): Promise<IPCResult<GitLabAuthStartResult>> => {
			const host = glabHost(instance);
			if (!host) return { success: false, error: INVALID_INSTANCE };
			const data: GitLabAuthStartResult = {
				deviceCode: "",
				verificationUrl: `https://${host}/-/profile/personal_access_tokens`,
				userCode: "",
			};

			return new Promise((resolve) => {
				const glab = spawn(
					getToolPath("glab"),
					["auth", "login", "--web", ...glabHostArgs(host)],
					{ stdio: ["pipe", "pipe", "pipe"], env: getAugmentedEnv() },
				);
				let errorOutput = "";
				let browserOpened = false;

				glab.stdout?.on("data", (chunk: Buffer) => {
					if (browserOpened) return;
					const url = signInUrlOn(chunk.toString("utf-8"), host);
					if (!url) return;
					browserOpened = true;
					openExternalUrl(url).catch(() => {
						// The page can still be opened from the instance's own link.
					});
				});
				glab.stderr?.on("data", (chunk: Buffer) => {
					errorOutput += chunk.toString("utf-8");
				});
				glab.on("close", (code) => {
					if (code === 0) {
						resolve({ success: true, data });
					} else {
						resolve({
							success: false,
							error: errorOutput || `Authentication failed with exit code ${code}`,
							data,
						});
					}
				});
				glab.on("error", (error) => {
					resolve({ success: false, error: error.message, data });
				});
			});
		},
	);
}

/**
 * Whether glab holds a token for the instance. The renderer gets the mask,
 * never the token (rule S6); saving the settings with the mask and the OAuth
 * method writes the token glab holds then, from the main (`oauth-token.ts`).
 */
export function registerGetGlabToken(): void {
	ipcMain.handle(
		IPC_CHANNELS.GITLAB_GET_TOKEN,
		async (_event, instance?: unknown): Promise<IPCResult<{ token: string }>> => {
			const host = glabHost(instance);
			if (!host) return { success: false, error: INVALID_INSTANCE };
			if (!(await getGlabToken(host))) {
				return {
					success: false,
					error: "No token found. Please authenticate first.",
				};
			}
			return { success: true, data: { token: MASKED_SECRET } };
		},
	);
}

/** The user glab is signed in as on the instance. */
export function registerGetGlabUser(): void {
	ipcMain.handle(
		IPC_CHANNELS.GITLAB_GET_USER,
		async (
			_event,
			instance?: unknown,
		): Promise<IPCResult<{ username: string; name?: string }>> => {
			const host = glabHost(instance);
			if (!host) return { success: false, error: INVALID_INSTANCE };
			try {
				const user = JSON.parse(
					await runGlab(["api", "user", ...glabHostArgs(host)]),
				) as { username?: unknown; name?: unknown };
				if (typeof user?.username !== "string") {
					return { success: false, error: "Failed to get user info" };
				}
				return {
					success: true,
					data: {
						username: user.username,
						...(typeof user.name === "string" ? { name: user.name } : {}),
					},
				};
			} catch (error) {
				return { success: false, error: message(error, "Failed to get user info") };
			}
		},
	);
}

interface GlabProject {
	path_with_namespace?: unknown;
	description?: unknown;
	visibility?: unknown;
}

/** The projects of the signed-in user on the instance. */
export function registerListUserProjects(): void {
	ipcMain.handle(
		IPC_CHANNELS.GITLAB_LIST_USER_PROJECTS,
		async (
			_event,
			instance?: unknown,
		): Promise<
			IPCResult<{
				projects: Array<{
					pathWithNamespace: string;
					description: string | null;
					visibility: string;
				}>;
			}>
		> => {
			const host = glabHost(instance);
			if (!host) return { success: false, error: INVALID_INSTANCE };
			try {
				const listed = JSON.parse(
					await runGlab(["repo", "list", "--mine", "-F", "json", ...glabHostArgs(host)]),
				) as unknown;
				if (!Array.isArray(listed)) {
					return { success: false, error: "Failed to list projects" };
				}
				const projects = (listed as GlabProject[])
					.filter((p) => typeof p?.path_with_namespace === "string")
					.map((p) => ({
						pathWithNamespace: p.path_with_namespace as string,
						description: typeof p.description === "string" ? p.description : null,
						visibility: typeof p.visibility === "string" ? p.visibility : "private",
					}));
				return { success: true, data: { projects } };
			} catch (error) {
				return { success: false, error: message(error, "Failed to list projects") };
			}
		},
	);
}

/** Register all GitLab OAuth handlers. */
export function registerGitlabOAuthHandlers(): void {
	registerCheckGlabCli();
	registerInstallGlabCli();
	registerCheckGlabAuth();
	registerStartGlabAuth();
	registerGetGlabToken();
	registerGetGlabUser();
	registerListUserProjects();
}
