import { parseJevSettings } from "../../shared/utils/jev-settings";
import { execFileSync, spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
} from "node:fs";
import path from "node:path";
import { is } from "@electron-toolkit/utils";
import { app, dialog, ipcMain, session } from "electron";


import type { BrowserWindow } from "electron";
import {
	DEFAULT_AGENT_PROFILES,
	DEFAULT_APP_SETTINGS,
	DEFAULT_SPELL_CHECK_LANGUAGE,
	IPC_CHANNELS,
	SPELL_CHECK_LANGUAGE_MAP,
} from "../../shared/constants";
import { sanitizeProjectFolderName } from "../../shared/utils/project-folder-name";
import type {
	AppSettings,
	IPCResult,
	SourceEnvCheckResult,
	SourceEnvConfig,
} from "../../shared/types";
import type { AgentManager } from "../agent";
import { appEmulatorService } from "../app-emulator-service";
import { setAppLanguage } from "../app-language";
import { notificationService } from "../notification-service";
import {
	setUpdateChannel,
	setUpdateChannelWithDowngradeCheck,
} from "../app-updater";
import { getUsageMonitor } from "../claude-profile/usage-monitor";
import { getClaudeProfileManager } from "../claude-profile-manager";
import {
	configureTools,
	getToolInfo,
	getToolPath,
	isPathFromWrongPlatform,
	preWarmToolCache,
} from "../cli-tool-manager";
import { credentialManager } from "../services/credential-manager";
import { openExternalUrl } from "../open-external";
import { decryptSecret } from "../secret-storage";
import { configurePythonFeatureServices } from "../python-feature-services";
import { rememberUserChosenPath } from "../security/renderer-path";
import {
	maskSettingsSecrets,
	unmaskSettingsUpdate,
} from "../settings-secrets";
import { pushThemeIfChanged } from "../server-ui-preferences";
import { readSettingsFile, writeSettingsFile } from "../settings-utils";
import {
	getPackagedSourceEnvPath,
	SOURCE_ENV_TOKEN_KEY,
	writeSourceEnvFile,
} from "../source-env";
import { testGenerationService } from "../test-generation-service";
import { findEnvLineBreak, parseEnvFile } from "./utils";
import { getCurrentOS } from "../platform";
import { buildCmdConsoleArgs } from "./task/launch-args";
import {
	BACKEND_PATH_REFUSED,
	refusedToolPath,
	refusesBackendPath,
	TOOL_PATH_REFUSED,
} from "../security/tool-path-policy";


/**
 * Get fallback spell check languages when preferred languages are not available
 */
function getFallbackLanguages(availableLanguages: string[]): string[] {
	return availableLanguages.includes(DEFAULT_SPELL_CHECK_LANGUAGE)
		? [DEFAULT_SPELL_CHECK_LANGUAGE]
		: [];
}

/**
 * Opens terminal on Linux using available emulators
 */
function openLinuxTerminal(resolvedPath: string): IPCResult<void> {
	const terminals: Array<{ cmd: string; args: string[]; useCwd?: boolean }> = [
		{ cmd: "gnome-terminal", args: ["--working-directory", resolvedPath] },
		{ cmd: "konsole", args: ["--workdir", resolvedPath] },
		{ cmd: "xfce4-terminal", args: ["--working-directory", resolvedPath] },
		{ cmd: "xterm", args: ["-e", "bash"], useCwd: true },
	];

	for (const { cmd, args, useCwd } of terminals) {
		try {
			execFileSync(cmd, args, {
				stdio: "ignore",
				...(useCwd ? { cwd: resolvedPath } : {}),
			});
			return { success: true };
		} catch {
			// Continue to next terminal
		}
	}

	return {
		success: false,
		error:
			"No supported terminal emulator found. Please install gnome-terminal, konsole, xfce4-terminal, or xterm.",
	};
}

/**
 * Opens terminal based on platform
 */
function openTerminalForPlatform(resolvedPath: string): IPCResult<void> {
	const platform = getCurrentOS();

	if (platform === "darwin") {
		// macOS: Use execFileSync with argument array to prevent injection
		execFileSync("open", ["-a", "Terminal", resolvedPath], { stdio: "ignore" });
		return { success: true };
	}

	if (platform === "win32") {
		// cmd.exe parses its own command line: the path is quoted, not split
		const args = buildCmdConsoleArgs(resolvedPath);
		if (!args) {
			return {
				success: false,
				error: "This folder path cannot be opened in cmd.exe",
			};
		}
		spawn("cmd.exe", args, {
			detached: true,
			stdio: "ignore",
			windowsHide: false,
			windowsVerbatimArguments: true,
		}).unref();
		return { success: true };
	}

	// Linux: Try common terminal emulators
	return openLinuxTerminal(resolvedPath);
}

/**
 * Validates a directory path for terminal opening
 */
function validateDirectoryPath(dirPath: string): IPCResult<string> {
	// Validate dirPath input
	if (!dirPath || typeof dirPath !== "string" || dirPath.trim() === "") {
		return {
			success: false,
			error: "Directory path is required and must be a non-empty string",
		};
	}

	// Resolve to absolute path
	const resolvedPath = path.resolve(dirPath);

	// Verify path exists
	if (!existsSync(resolvedPath)) {
		return {
			success: false,
			error: `Directory does not exist: ${resolvedPath}`,
		};
	}

	// Verify it's a directory
	try {
		if (!statSync(resolvedPath).isDirectory()) {
			return {
				success: false,
				error: `Path is not a directory: ${resolvedPath}`,
			};
		}
	} catch (statError) {
		return {
			success: false,
			error: `Cannot access path: ${resolvedPath} (${statError instanceof Error ? statError.message : String(statError)})`,
		};
	}

	return { success: true, data: resolvedPath };
}

/**
 * Migration: Set agent profile to 'auto' for users who haven't made a selection
 */
function migrateAgentProfileToAuto(settings: AppSettings): boolean {
	if (settings._migratedAgentProfileToAuto) {
		return false;
	}

	// Only set 'auto' if user hasn't made a selection yet
	if (!settings.selectedAgentProfile) {
		settings.selectedAgentProfile = "auto";
	}
	settings._migratedAgentProfileToAuto = true;
	return true;
}

/**
 * Migration: Sync defaultModel with selectedAgentProfile
 */
function migrateDefaultModelSync(settings: AppSettings): boolean {
	if (settings._migratedDefaultModelSync) {
		return false;
	}

	if (settings.selectedAgentProfile) {
		const profile = DEFAULT_AGENT_PROFILES.find(
			(p) => p.id === settings.selectedAgentProfile,
		);
		if (profile) {
			settings.defaultModel = profile.model;
		}
	}
	settings._migratedDefaultModelSync = true;
	return true;
}

/**
 * Migration: Normalize agentFramework to 'workpilot' (formerly 'auto-claude')
 */
function migrateAgentFramework(settings: AppSettings): boolean {
	if (settings.agentFramework && settings.agentFramework !== "workpilot") {
		settings.agentFramework = "workpilot";
		return true;
	}
	return false;
}

/**
 * Migration: Clear CLI tool paths that are from a different platform
 */
function migratePlatformPaths(settings: AppSettings): boolean {
	const pathFields = [
		"pythonPath",
		"gitPath",
		"githubCLIPath",
		"gitlabCLIPath",
		"claudePath",
		"autoBuildPath",
	] as const;
	let changed = false;

	for (const field of pathFields) {
		const pathValue = settings[field];
		if (pathValue && isPathFromWrongPlatform(pathValue)) {
			console.warn(
				`[SETTINGS_GET] Clearing ${field} - path from different platform: ${pathValue}`,
			);
			delete settings[field];
			changed = true;
		}
	}
	return changed;
}

/**
 * Auto-detect autoBuildPath if not set
 */
function setupAutoBuildPath(settings: AppSettings): void {
	if (!settings.autoBuildPath) {
		const detectedPath = detectAutoBuildSourcePath();
		if (detectedPath) {
			settings.autoBuildPath = detectedPath;
		}
	}
}

/**
 * Execute a single backend request with timeout
 */
async function executeRequest<T>(
	url: string,
	options: RequestInit,
): Promise<{ success: boolean; data?: T; error?: string }> {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), 3000);

	try {
		const response = await fetch(url, {
			...options,
			signal: controller.signal,
		});

		clearTimeout(timeoutId);

		if (!response.ok) {
			throw new Error(
				`Backend responded with ${response.status}: ${response.statusText}`,
			);
		}

		const data = await response.json();
		return { success: true, data };
	} catch (error) {
		clearTimeout(timeoutId);
		throw error;
	}
}

/**
 * Handle different types of request errors
 */
function handleRequestError(
	error: unknown,
	attempt: number,
	maxRetries: number,
	url: string,
): { shouldRetry: boolean; result?: { success: boolean; error?: string } } {
	if (error instanceof Error && error.name === "AbortError") {
		console.warn(`[Backend Request] Attempt ${attempt} timed out for ${url}`);
		if (attempt === maxRetries) {
			return {
				shouldRetry: false,
				result: {
					success: false,
					error: `Timeout: Le backend ne répond pas après ${maxRetries} tentatives.`,
				},
			};
		}
		return { shouldRetry: true };
	}

	if (error instanceof Error && error.message.includes("ECONNREFUSED")) {
		return {
			shouldRetry: false,
			result: {
				success: false,
				error: `Backend inaccessible: Veuillez vérifier que le backend est démarré.`,
			},
		};
	}

	console.error(
		`[Backend Request] Attempt ${attempt} failed for ${url}:`,
		error,
	);
	if (attempt === maxRetries) {
		return {
			shouldRetry: false,
			result: {
				success: false,
				error: error instanceof Error ? error.message : "Request failed",
			},
		};
	}
	return { shouldRetry: true };
}

/**
 * Wait before retry with appropriate delay
 */
async function waitForRetry(
	attempt: number,
	isTimeout: boolean,
): Promise<void> {
	const delay = isTimeout ? 1000 * attempt : 500 * attempt;
	await new Promise((resolve) => setTimeout(resolve, delay));
}

/**
 * Auto-detect the workpilot source path relative to the app location.
 * Works across platforms (macOS, Windows, Linux) in both dev and production modes.
 */
const detectAutoBuildSourcePath = (): string | null => {
	const possiblePaths: string[] = [];

	// Development mode paths
	if (is.dev) {
		// In dev, import.meta.dirname is typically apps/frontend/out/main
		// We need to go up to find apps/backend
		possiblePaths.push(
			path.resolve(import.meta.dirname, "..", "..", "..", "backend"), // From out/main -> apps/backend
			path.resolve(process.cwd(), "apps", "backend"), // From cwd (repo root)
		);
	} else {
		// Production mode paths (packaged app)
		// The backend is bundled as extraResources/backend
		// On all platforms, it should be at process.resourcesPath/backend
		possiblePaths.push(
			path.resolve(process.resourcesPath, "backend"), // Primary: extraResources/backend
		);
		// Fallback paths for different app structures
		const appPath = app.getAppPath();
		possiblePaths.push(
			path.resolve(appPath, "..", "backend"), // Sibling to asar
			path.resolve(appPath, "..", "..", "Resources", "backend"), // macOS bundle structure
		);
	}

	// Add process.cwd() as last resort on all platforms
	possiblePaths.push(path.resolve(process.cwd(), "apps", "backend"));

	// Enable debug logging with DEBUG=1
	const debug = process.env.DEBUG === "1" || process.env.DEBUG === "true";

	if (debug) {
		console.warn("[detectAutoBuildSourcePath] Platform:", process.platform);
		console.warn("[detectAutoBuildSourcePath] Is dev:", is.dev);
		console.warn("[detectAutoBuildSourcePath] import.meta.dirname:", import.meta.dirname);
		console.warn(
			"[detectAutoBuildSourcePath] app.getAppPath():",
			app.getAppPath(),
		);
		console.warn("[detectAutoBuildSourcePath] process.cwd():", process.cwd());
		console.warn("[detectAutoBuildSourcePath] Checking paths:", possiblePaths);
	}

	for (const p of possiblePaths) {
		// Use runners/spec_runner.py as marker - this is the file actually needed for task execution
		// This prevents matching legacy 'workpilot/' directories that don't have the runners
		const markerPath = path.join(p, "runners", "spec_runner.py");
		const exists = existsSync(p) && existsSync(markerPath);

		if (debug) {
			console.warn(
				`[detectAutoBuildSourcePath] Checking ${p}: ${exists ? "✓ FOUND" : "✗ not found"}`,
			);
		}

		if (exists) {
			console.warn(
				`[detectAutoBuildSourcePath] Auto-detected source path: ${p}`,
			);
			return p;
		}
	}

	console.warn(
		"[detectAutoBuildSourcePath] Could not auto-detect WorkPilot AI source path. Please configure manually in settings.",
	);
	console.warn(
		"[detectAutoBuildSourcePath] Set DEBUG=1 environment variable for detailed path checking.",
	);
	return null;
};

/**
 * Where the backend's own .env lives (../source-env.ts writes it).
 *
 * In production, the .env file is NOT bundled (excluded in electron-builder config).
 * We store the source .env in app userData directory instead, which is writable.
 * The sourcePath points to the bundled backend for reference, but envPath is in userData.
 *
 * `readByBackend`: in development the file is `<backend>/.env`, which the Python
 * runners load themselves, so it cannot hold `enc:` values. No Python code knows
 * the userData copy: the main process layers it, decrypted, into the backend's
 * subprocess environments (loadBackendEnv).
 */
export const getSourceEnvPath = (): {
	sourcePath: string | null;
	envPath: string | null;
	isProduction: boolean;
	readByBackend: boolean;
} => {
	const savedSettings = readSettingsFile();
	const settings = { ...DEFAULT_APP_SETTINGS, ...savedSettings };

	// Get autoBuildPath from settings or try to auto-detect
	let sourcePath: string | null = settings.autoBuildPath || null;
	if (!sourcePath) {
		sourcePath = detectAutoBuildSourcePath();
	}

	if (!sourcePath) {
		return {
			sourcePath: null,
			envPath: null,
			isProduction: !is.dev,
			readByBackend: is.dev,
		};
	}

	// In production, use userData directory for .env since resources may be read-only
	// In development, use the actual source path
	let envPath: string;
	if (is.dev) {
		envPath = path.join(sourcePath, ".env");
	} else {
		// Production: store .env in userData/backend/.env, where loadBackendEnv reads it
		envPath = getPackagedSourceEnvPath();
		mkdirSync(path.dirname(envPath), { recursive: true });
	}

	return {
		sourcePath,
		envPath,
		isProduction: !is.dev,
		readByBackend: is.dev,
	};
};

/**
 * Helper function to make HTTP requests to backend with retry logic
 */
async function makeBackendRequest<T>(
	url: string,
	options: RequestInit = {},
	maxRetries: number = 2,
): Promise<{ success: boolean; data?: T; error?: string }> {
	for (let attempt = 1; attempt <= maxRetries; attempt++) {
		try {
			return await executeRequest<T>(url, options);
		} catch (error) {
			const errorHandling = handleRequestError(error, attempt, maxRetries, url);

			if (errorHandling.result) {
				return errorHandling.result;
			}

			if (!errorHandling.shouldRetry) {
				break;
			}

			// Wait before retry (timeout errors use exponential backoff)
			const isTimeout = error instanceof Error && error.name === "AbortError";
			await waitForRetry(attempt, isTimeout);
		}
	}

	return { success: false, error: "Max retries exceeded" };
}

/**
 * Register all settings-related IPC handlers
 */
export function registerSettingsHandlers(
	agentManager: AgentManager,
	getMainWindow: () => BrowserWindow | null,
): void {
	// LLM Provider operations
	ipcMain.handle(
		IPC_CHANNELS.PROVIDER_SELECT,
		async (_, provider: string): Promise<IPCResult<string>> => {
			try {
				// CRITICAL: Update CredentialManager and persist to settings.json FIRST,
				// regardless of whether the optional FastAPI backend is running.
				// This ensures SELECTED_LLM_PROVIDER is correctly injected into every
				// agent subprocess so the Python backend routes to the right LLM client.
				// Without this, a task would silently fall back to Anthropic whenever
				// the FastAPI server is down.
				try {
					await credentialManager.setActiveProvider(provider, "oauth");
				} catch (e) {
					console.warn(
						"[IPC:PROVIDER_SELECT] Failed to update CredentialManager:",
						e,
					);
				}

				// Notify UsageMonitor to clear stale caches for the new provider
				try {
					getUsageMonitor().onProviderSwitch(provider);
				} catch (e) {
					console.warn(
						"[IPC:PROVIDER_SELECT] Failed to notify UsageMonitor:",
						e,
					);
				}

				// Optionally notify the FastAPI backend (for LLM router feature).
				// This is best-effort — the backend may not be running for non-router users.
				makeBackendRequest<{ selected: string }>(
					`http://127.0.0.1:9000/providers/select?provider=${encodeURIComponent(provider)}`,
					{ method: "POST", headers: { "Content-Type": "application/json" } },
				);

				return { success: true, data: provider };
			} catch (error) {
				console.error(
					`[IPC:PROVIDER_SELECT] Unexpected error for provider ${provider}:`,
					error,
				);
				return {
					success: false,
					error: error instanceof Error ? error.message : "Unexpected error",
				};
			}
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.PROVIDER_GET_SELECTED,
		async (): Promise<IPCResult<string | null>> => {
			try {
				const result = await makeBackendRequest<{ selected: string | null }>(
					"http://127.0.0.1:9000/providers/selected",
				);

				if (result.success && result.data) {
					return { success: true, data: result.data.selected };
				} else {
					console.error(
						"[IPC:PROVIDER_GET_SELECTED] Failed to get selected provider:",
						result.error,
					);
					return { success: false, error: result.error };
				}
			} catch (error) {
				console.error("[IPC:PROVIDER_GET_SELECTED] Unexpected error:", error);
				return {
					success: false,
					error: error instanceof Error ? error.message : "Unexpected error",
				};
			}
		},
	);
	// ============================================
	// Settings Operations
	// ============================================

	ipcMain.handle(
		IPC_CHANNELS.SETTINGS_GET,
		async (): Promise<IPCResult<AppSettings>> => {
			// Load settings using shared helper and merge with defaults
			const savedSettings = readSettingsFile();
			const settings: AppSettings = {
				...DEFAULT_APP_SETTINGS,
				...savedSettings,
			};
			let needsSave = false;

			// Apply migrations in sequence
			if (migrateAgentProfileToAuto(settings)) needsSave = true;
			if (migrateDefaultModelSync(settings)) needsSave = true;
			if (migrateAgentFramework(settings)) needsSave = true;
			if (migratePlatformPaths(settings)) needsSave = true;

			// Auto-detect autoBuildPath if not set
			setupAutoBuildPath(settings);

			// Persist migration changes
			if (needsSave) {
				try {
					writeSettingsFile(settings);
				} catch (error) {
					console.error("[SETTINGS_GET] Failed to persist migration:", error);
					// Continue anyway - settings will be migrated in-memory for this session
				}
			}

			// Configure CLI tools with current settings
			configureTools({
				pythonPath: settings.pythonPath,
				gitPath: settings.gitPath,
				githubCLIPath: settings.githubCLIPath,
				gitlabCLIPath: settings.gitlabCLIPath,
				claudePath: settings.claudePath,
			});

			// Re-warm cache asynchronously after configuring (non-blocking)
			preWarmToolCache(["claude"]).catch((error) => {
				console.warn("[SETTINGS_GET] Failed to re-warm CLI cache:", error);
			});

			// The renderer learns which credentials are set, never their value (S6)
			return { success: true, data: maskSettingsSecrets(settings) };
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.SETTINGS_CUSTOM_PROVIDER_DISCOVER_MODELS,
		async (): Promise<IPCResult<unknown>> => {
			// URL and key both come from the stored settings, never from the
			// renderer: the key only goes to the URL it was saved with (S6)
			const saved = (readSettingsFile() ?? {}) as Partial<AppSettings>;
			const baseUrl = (saved.customProviderUrl ?? "").trim().replace(/\/+$/, "");
			let url: URL;
			try {
				url = new URL(`${baseUrl}/models`);
			} catch {
				return { success: false, error: "Custom provider URL is invalid" };
			}
			if (url.protocol !== "https:" && url.protocol !== "http:") {
				return { success: false, error: "Custom provider URL is invalid" };
			}
			const key = saved.customProviderApiKey;
			try {
				const response = await fetch(url, {
					headers: key ? { Authorization: `Bearer ${key}` } : undefined,
					signal: AbortSignal.timeout(15000),
				});
				if (!response.ok) {
					return {
						success: false,
						error: `HTTP ${response.status}: ${response.statusText}`,
					};
				}
				return { success: true, data: await response.json() };
			} catch (error) {
				return {
					success: false,
					error:
						error instanceof Error ? error.message : "Failed to discover models",
				};
			}
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.SETTINGS_SAVE,
		async (_, update: Partial<AppSettings>): Promise<IPCResult> => {
			try {
				// Load current settings using shared helper
				const savedSettings = readSettingsFile();
				const currentSettings = { ...DEFAULT_APP_SETTINGS, ...savedSettings };
				// A masked secret coming back keeps its stored value
				const settings = unmaskSettingsUpdate<AppSettings>(
					update ?? {},
					currentSettings,
				);
				// A tool path the main process would run must be one it can trust.
				const refusedField = refusedToolPath(settings, currentSettings);
				if (refusedField) {
					return {
						success: false,
						error: TOOL_PATH_REFUSED,
						data: { field: refusedField },
					};
				}
				if (
					refusesBackendPath(settings, currentSettings, {
						detected: detectAutoBuildSourcePath,
					})
				) {
					return {
						success: false,
						error: BACKEND_PATH_REFUSED,
						data: { field: "autoBuildPath" },
					};
				}
				const newSettings = { ...currentSettings, ...settings };
				if (settings.jev !== undefined)
					newSettings.jev = parseJevSettings(settings.jev);

				// Sync defaultModel when agent profile changes (#414)
				if (settings.selectedAgentProfile) {
					const profile = DEFAULT_AGENT_PROFILES.find(
						(p) => p.id === settings.selectedAgentProfile,
					);
					if (profile) {
						newSettings.defaultModel = profile.model;
					}
				}

				const credentialsSetAt = writeSettingsFile(newSettings);
				// Server mode: the theme follows the person to their other devices.
				pushThemeIfChanged(settings, newSettings);

				// Apply Python path if changed
				if (settings.pythonPath || settings.autoBuildPath) {
					agentManager.configure(settings.pythonPath, settings.autoBuildPath);
					appEmulatorService.configure(
						settings.pythonPath,
						settings.autoBuildPath,
					);
					if (settings.pythonPath) {
						testGenerationService.configure(settings.pythonPath);
						configurePythonFeatureServices(
							settings.pythonPath,
							settings.autoBuildPath,
						);
					}
				}

				// Configure CLI tools if any paths changed
				if (
					settings.pythonPath !== undefined ||
					settings.gitPath !== undefined ||
					settings.githubCLIPath !== undefined ||
					settings.gitlabCLIPath !== undefined ||
					settings.claudePath !== undefined
				) {
					configureTools({
						pythonPath: newSettings.pythonPath,
						gitPath: newSettings.gitPath,
						githubCLIPath: newSettings.githubCLIPath,
						gitlabCLIPath: newSettings.gitlabCLIPath,
						claudePath: newSettings.claudePath,
					});

					// Re-warm cache asynchronously after configuring (non-blocking)
					preWarmToolCache(["claude"]).catch((error) => {
						console.warn("[SETTINGS_SAVE] Failed to re-warm CLI cache:", error);
					});
				}

				// The Telegram approval poller follows the saved channel settings.
				if (settings.needsYou !== undefined || settings.globalTelegramBotToken !== undefined) {
					notificationService.refreshRemote();
				}

				// Update auto-updater channel if betaUpdates setting changed
				if (settings.betaUpdates !== undefined) {
					if (settings.betaUpdates) {
						// Enabling beta updates - just switch channel
						setUpdateChannel("beta");
					} else {
						// Disabling beta updates - switch to stable and check if downgrade is available
						// This will notify the renderer if user is on a prerelease and stable version exists
						setUpdateChannelWithDowngradeCheck("latest", true).catch((err) => {
							console.error(
								"[settings-handlers] Failed to check for stable downgrade:",
								err,
							);
						});
					}
				}

				// The renderer's copy of the dates is stale once a key changed.
				return { success: true, data: { credentialsSetAt } };
			} catch (error) {
				return {
					success: false,
					error:
						error instanceof Error ? error.message : "Failed to save settings",
				};
			}
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.SETTINGS_GET_CLI_TOOLS_INFO,
		async (): Promise<
			IPCResult<{
				python: ReturnType<typeof getToolInfo>;
				git: ReturnType<typeof getToolInfo>;
				gh: ReturnType<typeof getToolInfo>;
				glab: ReturnType<typeof getToolInfo>;
				claude: ReturnType<typeof getToolInfo>;
			}>
		> => {
			try {
				return {
					success: true,
					data: {
						python: getToolInfo("python"),
						git: getToolInfo("git"),
						gh: getToolInfo("gh"),
						glab: getToolInfo("glab"),
						claude: getToolInfo("claude"),
					},
				};
			} catch (error) {
				return {
					success: false,
					error:
						error instanceof Error
							? error.message
							: "Failed to get CLI tools info",
				};
			}
		},
	);

	/**
	 * Read ~/.claude.json to check if Claude Code onboarding is complete.
	 * This allows WorkPilot AI to respect Claude Code's onboarding status and
	 * avoid showing the onboarding wizard to users who have already completed it.
	 */
	ipcMain.handle(
		IPC_CHANNELS.SETTINGS_CLAUDE_CODE_GET_ONBOARDING_STATUS,
		async (): Promise<IPCResult<{ hasCompletedOnboarding: boolean }>> => {
			try {
				const homeDir = app.getPath("home");
				const claudeJsonPath = path.join(homeDir, ".claude.json");

				// If file doesn't exist, user hasn't completed Claude Code onboarding
				if (!existsSync(claudeJsonPath)) {
					return {
						success: true,
						data: { hasCompletedOnboarding: false },
					};
				}

				const content = readFileSync(claudeJsonPath, "utf-8");
				const claudeConfig = JSON.parse(content);

				// Check for hasCompletedOnboarding field
				const hasCompletedOnboarding =
					claudeConfig.hasCompletedOnboarding === true;

				return {
					success: true,
					data: { hasCompletedOnboarding },
				};
			} catch (error) {
				// On error (parse error, read error, etc.), log and return false
				// This ensures we don't block onboarding due to corrupted .claude.json
				console.warn(
					"[SETTINGS_CLAUDE_CODE_GET_ONBOARDING_STATUS] Error reading ~/.claude.json:",
					error,
				);
				return {
					success: true,
					data: { hasCompletedOnboarding: false },
				};
			}
		},
	);

	// ============================================
	// Dialog Operations
	// ============================================

	ipcMain.handle(
		IPC_CHANNELS.DIALOG_SELECT_DIRECTORY,
		async (
			_,
			options?: { title?: string; defaultPath?: string },
		): Promise<string | null> => {
			const mainWindow = getMainWindow();
			if (!mainWindow) return null;

			const result = await dialog.showOpenDialog(mainWindow, {
				properties: ["openDirectory"],
				title:
					typeof options?.title === "string" && options.title
						? options.title
						: "Select Project Directory",
				...(typeof options?.defaultPath === "string" && options.defaultPath
					? { defaultPath: options.defaultPath }
					: {}),
			});

			if (result.canceled || result.filePaths.length === 0) {
				return null;
			}

			// The user picked it: handlers may now act on it before it is a
			// registered project (adding one, checking its git status).
			rememberUserChosenPath(result.filePaths[0]);
			return result.filePaths[0];
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.DIALOG_SELECT_FILES,
		async (
			_,
			options?: {
				title?: string;
				defaultPath?: string;
				multi?: boolean;
				filters?: { name: string; extensions: string[] }[];
			},
		): Promise<string[]> => {
			const mainWindow = getMainWindow();
			if (!mainWindow) return [];

			const properties: ("openFile" | "multiSelections")[] = ["openFile"];
			if (options?.multi) properties.push("multiSelections");

			const result = await dialog.showOpenDialog(mainWindow, {
				properties,
				title: options?.title ?? "Select Files",
				defaultPath: options?.defaultPath,
				filters: options?.filters,
			});

			if (result.canceled) return [];
			for (const filePath of result.filePaths) rememberUserChosenPath(filePath);
			return result.filePaths;
		},
	);

	/**
	 * What the wizard would be creating, and what is already there.
	 *
	 * "Create" and "Open existing folder" are not the same act: the first makes
	 * `<location>/<name>` and registers *that*, so pointing it at a folder that
	 * already holds the code adds an empty sibling instead. The form cannot say
	 * so without looking at the disk, and this is that look.
	 */
	ipcMain.handle(
		IPC_CHANNELS.DIALOG_INSPECT_PROJECT_LOCATION,
		async (
			_,
			location: string,
			name: string,
		): Promise<
			IPCResult<{
				targetPath: string | null;
				targetExists: boolean;
				targetHasEntries: boolean;
				locationIsProject: boolean;
				insideRepository: string | null;
				markers: string[];
			}>
		> => {
			try {
				const empty = {
					targetPath: null,
					targetExists: false,
					targetHasEntries: false,
					locationIsProject: false,
					insideRepository: null,
					markers: [] as string[],
				};
				if (!location || !existsSync(location)) {
					return { success: true, data: empty };
				}

				let entries: string[];
				try {
					entries = readdirSync(location);
				} catch {
					return { success: true, data: empty };
				}

				// Files a project root carries and an ordinary parent folder does
				// not. A folder that merely *contains* projects — `~/repositories`
				// — has none of them, which is what keeps the warning quiet where
				// creating really is what the user meant.
				const markers = entries.filter(
					(entry) =>
						entry === ".git" ||
						/\.(sln|slnx|csproj|fsproj)$/i.test(entry) ||
						[
							"package.json",
							"pnpm-workspace.yaml",
							"Cargo.toml",
							"go.mod",
							"pom.xml",
							"build.gradle",
							"build.gradle.kts",
							"pyproject.toml",
							"requirements.txt",
							"Gemfile",
							"composer.json",
						].includes(entry),
				);

				// A marker at the top level only catches a location that *is* the
				// project root. `…/dotnet` with the solution one level down has
				// none — but it is inside a checkout, and creating a project
				// inside a repository someone already cloned is nearly always the
				// mistake this warning exists for.
				let insideRepository: string | null = null;
				let ancestor = path.dirname(location);
				for (let depth = 0; depth < 12; depth++) {
					if (existsSync(path.join(ancestor, ".git"))) {
						insideRepository = ancestor;
						break;
					}
					const parent = path.dirname(ancestor);
					if (parent === ancestor) break;
					ancestor = parent;
				}

				const sanitized = sanitizeProjectFolderName(name);
				const targetPath = sanitized ? path.join(location, sanitized) : null;
				const targetExists = targetPath !== null && existsSync(targetPath);
				let targetHasEntries = false;
				if (targetExists && targetPath) {
					try {
						targetHasEntries = readdirSync(targetPath).length > 0;
					} catch {
						targetHasEntries = false;
					}
				}

				return {
					success: true,
					data: {
						targetPath,
						targetExists,
						targetHasEntries,
						locationIsProject: markers.length > 0,
						insideRepository,
						markers: markers.slice(0, 4),
					},
				};
			} catch (error) {
				return {
					success: false,
					error:
						error instanceof Error
							? error.message
							: "Failed to inspect project location",
				};
			}
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.DIALOG_CREATE_PROJECT_FOLDER,
		async (
			_,
			location: string,
			name: string,
			initGit: boolean,
		): Promise<
			IPCResult<{ path: string; name: string; gitInitialized: boolean }>
		> => {
			try {
				// Validate inputs
				if (!location || !name) {
					return { success: false, error: "Location and name are required" };
				}

				// Kebab-case the name, folding accents rather than deleting them.
				const sanitizedName = sanitizeProjectFolderName(name);

				if (!sanitizedName) {
					return { success: false, error: "Invalid project name" };
				}

				const projectPath = path.join(location, sanitizedName);

				// Check if folder already exists
				if (existsSync(projectPath)) {
					return {
						success: false,
						error: `Folder "${sanitizedName}" already exists at this location`,
					};
				}

				// Create the directory
				mkdirSync(projectPath, { recursive: true });
				// Created at the user's request: it may be added as a project.
				rememberUserChosenPath(projectPath);

				// Initialize git if requested
				let gitInitialized = false;
				if (initGit) {
					try {
						execFileSync(getToolPath("git"), ["init"], {
							cwd: projectPath,
							stdio: "ignore",
						});
						gitInitialized = true;
					} catch {
						// Git init failed, but folder was created - continue without git
						console.warn("Failed to initialize git repository");
					}
				}

				return {
					success: true,
					data: {
						path: projectPath,
						name: sanitizedName,
						gitInitialized,
					},
				};
			} catch (error) {
				return {
					success: false,
					error:
						error instanceof Error
							? error.message
							: "Failed to create project folder",
				};
			}
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.DIALOG_GET_DEFAULT_PROJECT_LOCATION,
		async (): Promise<string | null> => {
			try {
				// Return user's home directory + common project folders
				const homeDir = app.getPath("home");
				const commonPaths = [
					path.join(homeDir, "Projects"),
					path.join(homeDir, "Developer"),
					path.join(homeDir, "Code"),
					path.join(homeDir, "Documents"),
				];

				// Return the first one that exists, or Documents as fallback
				for (const p of commonPaths) {
					if (existsSync(p)) {
						return p;
					}
				}

				return path.join(homeDir, "Documents");
			} catch {
				return null;
			}
		},
	);

	// ============================================
	// App Info
	// ============================================

	ipcMain.handle(IPC_CHANNELS.APP_VERSION, async (): Promise<string> => {
		// Return the actual bundled version from package.json
		const version = app.getVersion();
		return version;
	});

	// ============================================
	// Shell Operations
	// ============================================

	ipcMain.handle(
		IPC_CHANNELS.SHELL_OPEN_EXTERNAL,
		async (_, url: string): Promise<void> => {
			// La validation du schéma et les replis Linux vivent dans open-external :
			// le rejet remonte jusqu'au renderer, qui l'affiche. Avaler l'erreur ici
			// est ce qui rendait le bouton silencieux quand rien ne s'ouvrait.
			try {
				await openExternalUrl(url);
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				console.warn(`[SHELL_OPEN_EXTERNAL] ${reason}`);
				throw error instanceof Error ? error : new Error(reason);
			}
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.SHELL_OPEN_TERMINAL,
		async (_, dirPath: string): Promise<IPCResult<void>> => {
			try {
				// Validate directory path
				const validation = validateDirectoryPath(dirPath);
				if (!validation.success || !validation.data) {
					return {
						success: false,
						error: validation.error || "Validation failed",
					};
				}

				// Open terminal for the platform
				return openTerminalForPlatform(validation.data);
			} catch (error) {
				const errorMsg =
					error instanceof Error ? error.message : "Unknown error";
				return {
					success: false,
					error: `Failed to open terminal: ${errorMsg}`,
				};
			}
		},
	);

	// ============================================
	// WorkPilot AI Source Environment Operations
	// ============================================

	ipcMain.handle(
		IPC_CHANNELS.AUTOBUILD_SOURCE_ENV_GET,
		async (): Promise<IPCResult<SourceEnvConfig>> => {
			try {
				const { sourcePath, envPath } = getSourceEnvPath();

				// Load global settings to check for global token fallback
				const savedSettings = readSettingsFile();
				const globalSettings = { ...DEFAULT_APP_SETTINGS, ...savedSettings };

				if (!sourcePath) {
					// Even without source path, check global token
					const globalToken = globalSettings.globalClaudeOAuthToken;
					return {
						success: true,
						data: {
							hasClaudeToken: !!globalToken && globalToken.length > 0,
							envExists: false,
						},
					};
				}

				const envExists = envPath ? existsSync(envPath) : false;
				let hasClaudeToken = false;

				// First, check source .env file
				if (envExists && envPath) {
					const content = readFileSync(envPath, "utf-8");
					const stored = parseEnvFile(content)[SOURCE_ENV_TOKEN_KEY];
					// Undefined while the keyring cannot decrypt it: the global token stands in
					const token = stored ? decryptSecret(stored) : undefined;
					hasClaudeToken = !!token && token.length > 0;
				}

				// Fallback to global settings if no token in source .env
				if (!hasClaudeToken && globalSettings.globalClaudeOAuthToken) {
					hasClaudeToken = true;
				}

				return {
					success: true,
					// Whether a token is set, never the token itself (S6)
					data: {
						hasClaudeToken,
						sourcePath,
						envExists,
					},
				};
			} catch (error) {
				// Log the error for debugging in production
				console.error("[AUTOBUILD_SOURCE_ENV_GET] Error:", error);
				return {
					success: false,
					error:
						error instanceof Error ? error.message : "Failed to get source env",
				};
			}
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.AUTOBUILD_SOURCE_ENV_UPDATE,
		async (
			_,
			config: { claudeOAuthToken?: string; claudeProfileId?: string },
		): Promise<IPCResult> => {
			try {
				// A Claude profile's token is read here: the renderer only sees it masked
				const profileId = config?.claudeProfileId;
				let token = config?.claudeOAuthToken;
				if (profileId !== undefined) {
					// Decrypted here: the profile keeps it encrypted at rest
					const profileToken =
						typeof profileId === "string"
							? getClaudeProfileManager().getProfileToken(profileId)
							: undefined;
					if (!profileToken) {
						return {
							success: false,
							error: "Selected profile does not have a valid token",
						};
					}
					token = profileToken;
				}
				// Revalidated here (rule S6): the file holds one variable per line.
				if (
					token !== undefined &&
					(typeof token !== "string" ||
						token.includes("\0") ||
						findEnvLineBreak(token) !== null)
				) {
					return { success: false, error: "Invalid Claude OAuth token" };
				}

				const { sourcePath, envPath, readByBackend } = getSourceEnvPath();

				if (!sourcePath || !envPath) {
					return {
						success: false,
						error:
							"Auto-build source path not configured. Please set it in Settings.",
					};
				}

				// Read existing content or start fresh (avoiding TOCTOU race condition)
				let existingVars: Record<string, string> = {};
				try {
					const content = readFileSync(envPath, "utf-8");
					existingVars = parseEnvFile(content);
					// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
				} catch (error: any) {
					if (error.code === "ENOENT") {
						// File doesn't exist - start with empty vars (expected for first-time setup)
					} else if (error.code === "EACCES") {
						return {
							success: false,
							error: `Permission denied reading environment file: ${envPath}`,
						};
					} else {
						return {
							success: false,
							error: `Unexpected error reading environment file: ${error.message}`,
						};
					}
				}

				// Update with new values
				if (token !== undefined) {
					existingVars[SOURCE_ENV_TOKEN_KEY] = token;
				}

				// Encrypted unless Python reads the file; 0600 and a warning otherwise
				writeSourceEnvFile({ envPath, readByBackend }, existingVars);

				return { success: true };
			} catch (error) {
				return {
					success: false,
					error:
						error instanceof Error
							? error.message
							: "Failed to update source env",
				};
			}
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.AUTOBUILD_SOURCE_ENV_CHECK_TOKEN,
		async (): Promise<IPCResult<SourceEnvCheckResult>> => {
			try {
				const { sourcePath, envPath, isProduction } = getSourceEnvPath();

				// Load global settings to check for global token fallback
				const savedSettings = readSettingsFile();
				const globalSettings = { ...DEFAULT_APP_SETTINGS, ...savedSettings };

				// Check global token first as it's the primary method
				const globalToken = globalSettings.globalClaudeOAuthToken;
				const hasGlobalToken = !!globalToken && globalToken.length > 0;

				if (!sourcePath) {
					// In production, no source path is acceptable if global token exists
					if (hasGlobalToken) {
						return {
							success: true,
							data: {
								hasToken: true,
								sourcePath: isProduction ? app.getPath("userData") : undefined,
							},
						};
					}
					return {
						success: true,
						data: {
							hasToken: false,
							error: isProduction
								? "Please configure Claude OAuth token in Settings > API Configuration"
								: "Auto-build source path not configured",
						},
					};
				}

				// Check source .env file
				let hasEnvToken = false;
				if (envPath && existsSync(envPath)) {
					const content = readFileSync(envPath, "utf-8");
					const vars = parseEnvFile(content);
					const token = vars.CLAUDE_CODE_OAUTH_TOKEN;
					hasEnvToken = !!token && token.length > 0;
				}

				// Token exists if either source .env has it OR global settings has it
				const hasToken = hasEnvToken || hasGlobalToken;

				return {
					success: true,
					data: {
						hasToken,
						sourcePath,
					},
				};
			} catch (error) {
				// Log the error for debugging in production
				console.error("[AUTOBUILD_SOURCE_ENV_CHECK_TOKEN] Error:", error);
				return {
					success: false,
					error:
						error instanceof Error
							? error.message
							: "Failed to check source token",
				};
			}
		},
	);

	// ============================================
	// Spell Check Operations
	// ============================================

	/**
	 * Set spell check languages based on app language.
	 * Called when renderer's i18n language changes to sync spell checker.
	 */
	ipcMain.handle(
		IPC_CHANNELS.SPELLCHECK_SET_LANGUAGES,
		async (_, language: string): Promise<IPCResult<{ success: boolean }>> => {
			try {
				// Validate language parameter
				if (!language || typeof language !== "string") {
					return {
						success: false,
						error: "Invalid language parameter",
					};
				}

				// Update tracked app language for context menu labels
				setAppLanguage(language);

				// Get spell check languages for this app language
				const spellCheckLanguages = SPELL_CHECK_LANGUAGE_MAP[language] || [
					DEFAULT_SPELL_CHECK_LANGUAGE,
				];

				// Get available languages on this system
				const availableLanguages =
					session.defaultSession.availableSpellCheckerLanguages;

				// Filter to only available languages
				const validLanguages = spellCheckLanguages.filter((lang) =>
					availableLanguages.includes(lang),
				);

				// Fallback to default if none of the preferred languages are available
				const languagesToSet =
					validLanguages.length > 0
						? validLanguages
						: getFallbackLanguages(availableLanguages);

				if (languagesToSet.length > 0) {
					session.defaultSession.setSpellCheckerLanguages(languagesToSet);
				} else {
					console.warn(
						`[SPELLCHECK] No valid spell check languages available for: ${language}`,
					);
				}

				return {
					success: true,
					data: { success: true },
				};
			} catch (error) {
				console.error("[SPELLCHECK_SET_LANGUAGES] Error:", error);
				return {
					success: false,
					error:
						error instanceof Error
							? error.message
							: "Failed to set spell check languages",
				};
			}
		},
	);
}
