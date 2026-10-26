/**
 * The host side of MCP Apps (2026-01-26), for one view in the task panel.
 *
 * The view and the app speak JSON-RPC over `postMessage`. This host shows a
 * call that already happened: it answers `ui/initialize`, then sends the
 * call's arguments and result once the view says it is ready, and follows
 * the view's height. It declares no capability, and refuses what it does not
 * offer — calling a tool, reading a resource, sending a message to the
 * agent, opening a link, changing the model's context: a view is the
 * server's content, and nothing it sends acts on the task.
 */

export const MCP_APPS_PROTOCOL_VERSION = "2026-01-26";
export const MIN_VIEW_HEIGHT = 80;
export const MAX_VIEW_HEIGHT = 1200;
const METHOD_NOT_FOUND = -32601;

export interface HostContext {
	theme: "light" | "dark";
	locale: string;
	containerWidth: number;
}

export interface McpAppBridgeOptions {
	/** Posts a message to the view's window (and only to it). */
	post: (message: Record<string, unknown>) => void;
	toolInput: Record<string, unknown>;
	toolResult: Record<string, unknown>;
	hostVersion: () => string;
	context: () => HostContext;
	onHeight: (height: number) => void;
}

export interface McpAppBridge {
	/** One message from the view's window; anything else is ignored. */
	receive: (data: unknown) => void;
	/** Tell the view it is going away. */
	teardown: () => void;
	readonly initialized: boolean;
}

type JsonRpcId = string | number;

function isId(value: unknown): value is JsonRpcId {
	return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

export function clampHeight(height: unknown): number | null {
	if (typeof height !== "number" || !Number.isFinite(height)) return null;
	return Math.min(MAX_VIEW_HEIGHT, Math.max(MIN_VIEW_HEIGHT, Math.round(height)));
}

export function createMcpAppBridge(options: McpAppBridgeOptions): McpAppBridge {
	let initialized = false;
	let sentCall = false;
	let nextId = 1;

	const reply = (id: JsonRpcId, result: Record<string, unknown>) =>
		options.post({ jsonrpc: "2.0", id, result });
	const refuse = (id: JsonRpcId, method: string) =>
		options.post({
			jsonrpc: "2.0",
			id,
			error: { code: METHOD_NOT_FOUND, message: `${method} is not available in this host` },
		});
	const notify = (method: string, params: Record<string, unknown>) =>
		options.post({ jsonrpc: "2.0", method, params });

	const hostContext = () => {
		const context = options.context();
		return {
			theme: context.theme,
			displayMode: "inline",
			availableDisplayModes: ["inline"],
			containerDimensions: { width: context.containerWidth, maxHeight: MAX_VIEW_HEIGHT },
			locale: context.locale,
			platform: "desktop",
		};
	};

	const sendCall = () => {
		if (sentCall) return;
		sentCall = true;
		notify("ui/notifications/tool-input", { arguments: options.toolInput });
		notify("ui/notifications/tool-result", options.toolResult);
	};

	return {
		get initialized() {
			return initialized;
		},
		receive(data: unknown) {
			if (!data || typeof data !== "object") return;
			const message = data as Record<string, unknown>;
			if (message.jsonrpc !== "2.0" || typeof message.method !== "string") return;
			const method = message.method.slice(0, 100);
			const params =
				message.params && typeof message.params === "object"
					? (message.params as Record<string, unknown>)
					: {};
			const id = isId(message.id) ? message.id : undefined;

			if (id === undefined) {
				// Notifications.
				if (method === "ui/notifications/initialized" && initialized) sendCall();
				if (method === "ui/notifications/size-changed") {
					const height = clampHeight(params.height);
					if (height !== null) options.onHeight(height);
				}
				return;
			}
			switch (method) {
				case "ui/initialize":
					initialized = true;
					reply(id, {
						protocolVersion: MCP_APPS_PROTOCOL_VERSION,
						hostCapabilities: {},
						hostInfo: { name: "WorkPilot AI", version: options.hostVersion() },
						hostContext: hostContext(),
					});
					return;
				case "ping":
					reply(id, {});
					return;
				case "ui/request-display-mode":
					reply(id, { mode: "inline" });
					return;
				default:
					refuse(id, method);
			}
		},
		teardown() {
			if (!initialized) return;
			options.post({
				jsonrpc: "2.0",
				id: `teardown-${nextId++}`,
				method: "ui/resource-teardown",
				params: {},
			});
		},
	};
}
