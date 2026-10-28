import { ipcRenderer } from "electron";
import { IPC_CHANNELS } from "../../shared/constants";
import type {
	AppSettings,
	IPCResult,
	NeedsYouTestResult,
	SourceEnvCheckResult,
	SourceEnvConfig,
	ToolDetectionResult,
} from "../../shared/types";

export interface SettingsAPI {
	// App Settings
	getSettings: () => Promise<IPCResult<AppSettings>>;
	saveSettings: (settings: Partial<AppSettings>) => Promise<IPCResult>;
	/** Send a test "needs you" to the remote channels as saved. */
	testNeedsYou: () => Promise<IPCResult<NeedsYouTestResult>>;
	/** A desktop "needs you" was clicked: open that task. */
	onNeedsYouOpenTask: (callback: (taskId: string, projectId: string) => void) => () => void;
	/** Main asks the app to apply a remote plan approval; answer with reportNeedsYouApproval. */
	onNeedsYouApprovePlan: (callback: (requestId: string, taskId: string) => void) => () => void;
	reportNeedsYouApproval: (requestId: string, outcome: "approved" | "notPending") => Promise<void>;

	// CLI Tools Detection
	getCliToolsInfo: () => Promise<
		IPCResult<{
			python: ToolDetectionResult;
			git: ToolDetectionResult;
			gh: ToolDetectionResult;
			// `settings-handlers` detecte aussi glab et le renvoie ; seul ce type
			// l'omettait, et l'index signature d'`ElectronAPI` cachait l'ecart a
			// `GeneralSettings`, qui l'affiche.
			glab: ToolDetectionResult;
			claude: ToolDetectionResult;
		}>
	>;

	// Claude Code onboarding status
	getClaudeCodeOnboardingStatus: () => Promise<
		IPCResult<{ hasCompletedOnboarding: boolean }>
	>;

	// App Info
	getAppVersion: () => Promise<string>;

	// WorkPilot AI Source Environment
	getSourceEnv: () => Promise<IPCResult<SourceEnvConfig>>;
	updateSourceEnv: (config: {
		claudeOAuthToken?: string;
		/** A Claude profile whose token main copies (the renderer never holds it) */
		claudeProfileId?: string;
	}) => Promise<IPCResult>;
	checkSourceToken: () => Promise<IPCResult<SourceEnvCheckResult>>;

	// Sentry error reporting
	notifySentryStateChanged: (enabled: boolean) => void;
	getSentryDsn: () => Promise<string>;
	getSentryConfig: () => Promise<{
		dsn: string;
		tracesSampleRate: number;
		profilesSampleRate: number;
	}>;

	// Spell check
	setSpellCheckLanguages: (
		language: string,
	) => Promise<IPCResult<{ success: boolean }>>;

	// The custom provider's `/models` response, fetched by main with the stored key
	discoverCustomProviderModels: () => Promise<IPCResult<unknown>>;

	// LLM Provider operations
	selectProvider: (provider: string) => Promise<IPCResult<string>>;
	getSelectedProvider: () => Promise<IPCResult<string | null>>;
}

export const createSettingsAPI = (): SettingsAPI => ({
	// App Settings
	getSettings: (): Promise<IPCResult<AppSettings>> =>
		ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET),

	saveSettings: (settings: Partial<AppSettings>): Promise<IPCResult> =>
		ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_SAVE, settings),

	testNeedsYou: (): Promise<IPCResult<NeedsYouTestResult>> =>
		ipcRenderer.invoke(IPC_CHANNELS.NEEDS_YOU_TEST),

	onNeedsYouOpenTask: (callback: (taskId: string, projectId: string) => void): (() => void) => {
		const handler = (_event: Electron.IpcRendererEvent, taskId: string, projectId: string): void =>
			callback(taskId, projectId);
		ipcRenderer.on(IPC_CHANNELS.NEEDS_YOU_OPEN_TASK, handler);
		return () => ipcRenderer.removeListener(IPC_CHANNELS.NEEDS_YOU_OPEN_TASK, handler);
	},

	onNeedsYouApprovePlan: (callback: (requestId: string, taskId: string) => void): (() => void) => {
		const handler = (_event: Electron.IpcRendererEvent, requestId: string, taskId: string): void =>
			callback(requestId, taskId);
		ipcRenderer.on(IPC_CHANNELS.NEEDS_YOU_APPROVE_PLAN, handler);
		return () => ipcRenderer.removeListener(IPC_CHANNELS.NEEDS_YOU_APPROVE_PLAN, handler);
	},

	reportNeedsYouApproval: (requestId: string, outcome: "approved" | "notPending"): Promise<void> =>
		ipcRenderer.invoke(IPC_CHANNELS.NEEDS_YOU_APPROVAL_RESULT, requestId, outcome),

	discoverCustomProviderModels: (): Promise<IPCResult<unknown>> =>
		ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_CUSTOM_PROVIDER_DISCOVER_MODELS),

	// CLI Tools Detection
	getCliToolsInfo: (): Promise<
		IPCResult<{
			python: ToolDetectionResult;
			git: ToolDetectionResult;
			gh: ToolDetectionResult;
			// `settings-handlers` detecte aussi glab et le renvoie ; seul ce type
			// l'omettait, et l'index signature d'`ElectronAPI` cachait l'ecart a
			// `GeneralSettings`, qui l'affiche.
			glab: ToolDetectionResult;
			claude: ToolDetectionResult;
		}>
	> => ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET_CLI_TOOLS_INFO),

	// Claude Code onboarding status
	getClaudeCodeOnboardingStatus: (): Promise<
		IPCResult<{ hasCompletedOnboarding: boolean }>
	> =>
		ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_CLAUDE_CODE_GET_ONBOARDING_STATUS),

	// App Info
	getAppVersion: (): Promise<string> =>
		ipcRenderer.invoke(IPC_CHANNELS.APP_VERSION),

	// WorkPilot AI Source Environment
	getSourceEnv: (): Promise<IPCResult<SourceEnvConfig>> =>
		ipcRenderer.invoke(IPC_CHANNELS.AUTOBUILD_SOURCE_ENV_GET),

	updateSourceEnv: (config: {
		claudeOAuthToken?: string;
		claudeProfileId?: string;
	}): Promise<IPCResult> =>
		ipcRenderer.invoke(IPC_CHANNELS.AUTOBUILD_SOURCE_ENV_UPDATE, config),

	checkSourceToken: (): Promise<IPCResult<SourceEnvCheckResult>> =>
		ipcRenderer.invoke(IPC_CHANNELS.AUTOBUILD_SOURCE_ENV_CHECK_TOKEN),

	// Sentry error reporting - notify main process when setting changes
	notifySentryStateChanged: (enabled: boolean): void =>
		ipcRenderer.send(IPC_CHANNELS.SENTRY_STATE_CHANGED, enabled),

	// Get Sentry DSN from main process (loaded from environment variable)
	getSentryDsn: (): Promise<string> =>
		ipcRenderer.invoke(IPC_CHANNELS.GET_SENTRY_DSN),

	// Get full Sentry config from main process (DSN + sample rates)
	getSentryConfig: (): Promise<{
		dsn: string;
		tracesSampleRate: number;
		profilesSampleRate: number;
	}> => ipcRenderer.invoke(IPC_CHANNELS.GET_SENTRY_CONFIG),

	// Spell check - sync spell checker language with app language
	setSpellCheckLanguages: (
		language: string,
	): Promise<IPCResult<{ success: boolean }>> =>
		ipcRenderer.invoke(IPC_CHANNELS.SPELLCHECK_SET_LANGUAGES, language),

	// LLM Provider operations
	selectProvider: (provider: string): Promise<IPCResult<string>> =>
		ipcRenderer.invoke(IPC_CHANNELS.PROVIDER_SELECT, provider),

	getSelectedProvider: (): Promise<IPCResult<string | null>> =>
		ipcRenderer.invoke(IPC_CHANNELS.PROVIDER_GET_SELECTED),
});
