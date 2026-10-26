import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { McpAppViewOpened } from "../../../shared/types";
import { cn } from "../../lib/utils";
import { createMcpAppBridge, type McpAppBridge, MIN_VIEW_HEIGHT } from "./mcp-app-bridge";

export interface McpAppFrameProps {
	readonly taskId: string;
	readonly viewId: string;
	readonly hostVersion: string;
}

const INITIAL_HEIGHT = 320;

/**
 * One MCP App view, in a frame that holds it in.
 *
 * `sandbox="allow-scripts"` and nothing else: no `allow-same-origin` (the
 * view runs in an opaque origin, with no storage and no reach into the app),
 * no forms, no popups, no top navigation. The document comes from the main
 * process's own scheme with the view's CSP; messages are taken only from this
 * frame's window (`event.source`).
 */
export function McpAppFrame({ taskId, viewId, hostVersion }: McpAppFrameProps) {
	const { t, i18n } = useTranslation(["tasks"]);
	const frame = useRef<HTMLIFrameElement>(null);
	const [opened, setOpened] = useState<McpAppViewOpened | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [height, setHeight] = useState(INITIAL_HEIGHT);
	// Read when the view asks, so a late version or a language change never
	// restarts a view that is already showing its call.
	const host = useRef({ hostVersion, i18n });
	host.current = { hostVersion, i18n };

	useEffect(() => {
		const api = globalThis.electronAPI;
		let cancelled = false;
		let token: string | null = null;
		setOpened(null);
		setError(null);
		setHeight(INITIAL_HEIGHT);
		if (typeof api?.openMcpAppView !== "function") {
			setError(t("tasks:mcpApps.unavailable"));
			return;
		}
		void api
			.openMcpAppView(taskId, viewId)
			.then((result) => {
				if (!result.success || !result.data) {
					if (!cancelled) setError(result.error ?? t("tasks:mcpApps.unavailable"));
					return;
				}
				token = result.data.token;
				if (cancelled) {
					void api.closeMcpAppView(token);
					return;
				}
				setOpened(result.data);
			})
			.catch(() => {
				if (!cancelled) setError(t("tasks:mcpApps.unavailable"));
			});
		return () => {
			cancelled = true;
			if (token) void api.closeMcpAppView(token);
		};
	}, [taskId, viewId, t]);

	useEffect(() => {
		if (!opened) return;
		const post = (message: Record<string, unknown>) => {
			// An opaque origin has no name to target: the window itself is the target.
			frame.current?.contentWindow?.postMessage(message, "*");
		};
		const bridge: McpAppBridge = createMcpAppBridge({
			post,
			toolInput: opened.toolInput,
			toolResult: opened.toolResult,
			hostVersion: () => host.current.hostVersion,
			context: () => ({
				theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
				locale: host.current.i18n.language,
				containerWidth: frame.current?.clientWidth ?? 0,
			}),
			onHeight: setHeight,
		});
		const onMessage = (event: MessageEvent) => {
			if (!frame.current || event.source !== frame.current.contentWindow) return;
			bridge.receive(event.data);
		};
		window.addEventListener("message", onMessage);
		return () => {
			window.removeEventListener("message", onMessage);
			bridge.teardown();
		};
	}, [opened]);

	if (error) {
		return <p className="text-xs text-muted-foreground">{error}</p>;
	}
	if (!opened) {
		return (
			<div className="flex items-center gap-2 text-xs text-muted-foreground">
				<Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
				{t("tasks:mcpApps.loading")}
			</div>
		);
	}
	return (
		<iframe
			ref={frame}
			src={opened.url}
			title={t("tasks:mcpApps.frameTitle", { server: opened.server, tool: opened.tool })}
			sandbox="allow-scripts"
			referrerPolicy="no-referrer"
			className={cn(
				"w-full rounded-md bg-background",
				opened.prefersBorder ? "border border-border" : "border-0",
			)}
			style={{ height: Math.max(MIN_VIEW_HEIGHT, height) }}
			data-testid="mcp-app-frame"
		/>
	);
}
