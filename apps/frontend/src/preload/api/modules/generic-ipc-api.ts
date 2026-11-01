/**
 * Generic IPC API
 *
 * The escape hatch for renderer code that talks to a channel no typed module
 * covers yet. `invoke` already existed — parked, for no reason anyone
 * recorded, on `CopilotOAuthAPI` — but its listener counterpart did not, so
 * `electronAPI.on(...)` and `electronAPI.onIpcEvent(...)` were called against
 * a method the bridge never defined.
 *
 * It used to forward *any* channel name to `ipcRenderer`, which made every
 * `ipcMain` handler of the main process reachable from the renderer, whether
 * a page ever needed it or not. It now forwards only the channels listed
 * below — one list per direction — and refuses everything else: `invoke`
 * rejects, `send` / `on` / `onIpcEvent` throw, and `ipcRenderer` is never
 * reached. The channel parameter is typed with the same lists, so an unlisted
 * literal does not compile either.
 *
 * These lists are meant to shrink, not grow. A channel that already has a
 * typed method must be called through it (enforced by
 * `__tests__/generic-ipc-allowlist.test.ts`), and a new channel gets a typed
 * method rather than an entry here. Moving a feature off the passthrough is
 * one module and its store: `time-travel-api.ts` retired eleven entries.
 */

import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import { createIpcListener, invokeIpc, sendIpc } from "./ipc-utils";

/** Channels the renderer may `invoke` without a typed method. */
export const GENERIC_INVOKE_CHANNELS = [
	// Browser agent (browser-agent-store, TaskVisualProof)
	IPC_CHANNELS.BROWSER_AGENT_GET_DASHBOARD,
	IPC_CHANNELS.BROWSER_AGENT_CAPTURE_SCREENSHOT,
	IPC_CHANNELS.BROWSER_AGENT_SET_BASELINE,
	IPC_CHANNELS.BROWSER_AGENT_COMPARE,
	IPC_CHANNELS.BROWSER_AGENT_DELETE_BASELINE,
	IPC_CHANNELS.BROWSER_AGENT_RUN_TESTS,
	IPC_CHANNELS.BROWSER_AGENT_GET_SCREENSHOT_IMAGE,
	// CI/CD triggers (cicd-triggers-store)
	"cicdTriggers:getConfig",
	"cicdTriggers:setConfig",
	"cicdTriggers:listRuns",
	"cicdTriggers:trigger",
	// Context mesh (context-mesh-store)
	IPC_CHANNELS.CONTEXT_MESH_GET_PROJECTS,
	IPC_CHANNELS.CONTEXT_MESH_GET_PATTERNS,
	IPC_CHANNELS.CONTEXT_MESH_GET_HANDBOOK,
	IPC_CHANNELS.CONTEXT_MESH_GET_SKILL_TRANSFERS,
	IPC_CHANNELS.CONTEXT_MESH_GET_RECOMMENDATIONS,
	IPC_CHANNELS.CONTEXT_MESH_GET_SUMMARY,
	IPC_CHANNELS.CONTEXT_MESH_REGISTER_PROJECT,
	IPC_CHANNELS.CONTEXT_MESH_UNREGISTER_PROJECT,
	IPC_CHANNELS.CONTEXT_MESH_DELETE_PATTERN,
	IPC_CHANNELS.CONTEXT_MESH_DELETE_HANDBOOK_ENTRY,
	IPC_CHANNELS.CONTEXT_MESH_UPDATE_TRANSFER_STATUS,
	IPC_CHANNELS.CONTEXT_MESH_UPDATE_RECOMMENDATION_STATUS,
	IPC_CHANNELS.CONTEXT_MESH_STOP_ANALYSIS,
	// Cross-language translation (cross-language-translation-store)
	"crossLangTranslation:getSupportedLanguages",
	"crossLangTranslation:translate",
	"crossLangTranslation:cancel",
	"crossLangTranslation:getHistory",
	"crossLangTranslation:clearHistory",
	// Credentials, providers and usage (providerService, CleanProviderSection)
	"providers:getConfiguredProviders",
	"credential:testProvider",
	"usage:getData",
	"usage:getAllData",
	// GitHub Copilot (githubCopilotService)
	"github-copilot:getStatus",
	"github-copilot:getConfig",
	"github-copilot:setToken",
	"github-copilot:removeToken",
	"github-copilot:authenticate",
	"github-copilot:logout",
	"github-copilot:testConnection",
	"github-copilot:refreshStatus",
	"github-copilot:getEnv",
	// Live companion (live-companion-store)
	IPC_CHANNELS.LIVE_COMPANION_START,
	IPC_CHANNELS.LIVE_COMPANION_STOP,
	IPC_CHANNELS.LIVE_COMPANION_GET_STATE,
	IPC_CHANNELS.LIVE_COMPANION_GET_CONFIG,
	IPC_CHANNELS.LIVE_COMPANION_UPDATE_CONFIG,
	IPC_CHANNELS.LIVE_COMPANION_GET_SUGGESTIONS,
	IPC_CHANNELS.LIVE_COMPANION_DISMISS_SUGGESTION,
	IPC_CHANNELS.LIVE_COMPANION_APPLY_SUGGESTION,
	IPC_CHANNELS.LIVE_COMPANION_GET_TAKEOVERS,
	IPC_CHANNELS.LIVE_COMPANION_ACCEPT_TAKEOVER,
	IPC_CHANNELS.LIVE_COMPANION_DECLINE_TAKEOVER,
	// MCP marketplace (mcp-marketplace-store)
	IPC_CHANNELS.MCP_MARKETPLACE_GET_CATALOG,
	IPC_CHANNELS.MCP_MARKETPLACE_GET_INSTALLED,
	IPC_CHANNELS.MCP_MARKETPLACE_INSTALL,
	IPC_CHANNELS.MCP_MARKETPLACE_UNINSTALL,
	IPC_CHANNELS.MCP_MARKETPLACE_TOGGLE_SERVER,
	IPC_CHANNELS.MCP_MARKETPLACE_GET_BUILDER_PROJECTS,
	IPC_CHANNELS.MCP_MARKETPLACE_SAVE_BUILDER,
	IPC_CHANNELS.MCP_MARKETPLACE_DELETE_BUILDER,
	// Plugin marketplace (plugin-marketplace-store, PluginCreatorWizard)
	"pluginMarketplace:getCatalog",
	"pluginMarketplace:getInstalled",
	"pluginMarketplace:install",
	"pluginMarketplace:uninstall",
	"pluginMarketplace:toggle",
	"pluginMarketplace:create",
	"pluginMarketplace:openLocalFolder",
	// Spec approval (spec-approval-store)
	"specApproval:getSpec",
	// Cooperative pause (task-store pauseTask / resumeTask)
	"TASK_PAUSE",
	"TASK_RESUME",
] as const;

/** Channels the renderer may `send` (fire and forget) without a typed method. */
export const GENERIC_SEND_CHANNELS = [
	// Context mesh (context-mesh-store runAnalysis)
	IPC_CHANNELS.CONTEXT_MESH_RUN_ANALYSIS,
] as const;

/** Channels the renderer may subscribe to without a typed method. */
export const GENERIC_LISTEN_CHANNELS = [
	// Cross-language translation (cross-language-translation-store)
	"crossLangTranslation:streamChunk",
] as const;

export type GenericInvokeChannel = (typeof GENERIC_INVOKE_CHANNELS)[number];
export type GenericSendChannel = (typeof GENERIC_SEND_CHANNELS)[number];
export type GenericListenChannel = (typeof GENERIC_LISTEN_CHANNELS)[number];

const INVOKE_ALLOWED: ReadonlySet<string> = new Set(GENERIC_INVOKE_CHANNELS);
const SEND_ALLOWED: ReadonlySet<string> = new Set(GENERIC_SEND_CHANNELS);
const LISTEN_ALLOWED: ReadonlySet<string> = new Set(GENERIC_LISTEN_CHANNELS);

/**
 * The renderer is not trusted: types are erased at runtime, so the channel is
 * checked here, on every call. Anything but a listed string is refused — the
 * value is never coerced, so an object cannot pass itself off as a channel.
 */
function isAllowed(allowed: ReadonlySet<string>, channel: unknown): boolean {
	return typeof channel === "string" && allowed.has(channel);
}

function refusal(direction: string, channel: unknown): Error {
	const name =
		typeof channel === "string" ? JSON.stringify(channel) : typeof channel;
	return new Error(
		`IPC ${direction} refused: channel ${name} is not exposed to the renderer`,
	);
}

export interface GenericIpcAPI {
	/** Invoke an allowlisted channel and await its reply. */
	// biome-ignore lint/suspicious/noExplicitAny: callers type the reply themselves
	invoke: (channel: GenericInvokeChannel, ...args: any[]) => Promise<any>;
	/**
	 * Fire an allowlisted channel without awaiting a reply — the `ipcMain.on`
	 * counterpart. `context-mesh-store` has always called it against a bridge
	 * that never defined it, while `context-mesh-handlers` listened on the
	 * other end.
	 */
	// biome-ignore lint/suspicious/noExplicitAny: callers type the payload themselves
	send: (channel: GenericSendChannel, ...args: any[]) => void;
	/** Subscribe to an allowlisted channel. Returns the unsubscribe function. */
	on: (
		channel: GenericListenChannel,
		// biome-ignore lint/suspicious/noExplicitAny: callers type the payload themselves
		callback: (...args: any[]) => void,
	) => () => void;
	/** Alias of `on`, for callers that spell it out. */
	onIpcEvent: (
		channel: GenericListenChannel,
		// biome-ignore lint/suspicious/noExplicitAny: callers type the payload themselves
		callback: (...args: any[]) => void,
	) => () => void;
}

function listen(
	channel: unknown,
	callback: (...args: unknown[]) => void,
): () => void {
	if (!isAllowed(LISTEN_ALLOWED, channel)) {
		throw refusal("listen", channel);
	}
	return createIpcListener(channel as GenericListenChannel, callback);
}

export const createGenericIpcAPI = (): GenericIpcAPI => ({
	invoke: (channel, ...args) =>
		isAllowed(INVOKE_ALLOWED, channel)
			? invokeIpc(channel, ...args)
			: Promise.reject(refusal("invoke", channel)),

	send: (channel, ...args) => {
		if (!isAllowed(SEND_ALLOWED, channel)) {
			throw refusal("send", channel);
		}
		sendIpc(channel, ...args);
	},

	on: (channel, callback) => listen(channel, callback),

	onIpcEvent: (channel, callback) => listen(channel, callback),
});
