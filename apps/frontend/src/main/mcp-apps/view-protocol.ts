/**
 * `workpilot-mcp-app://<token>/`: where an MCP App view is served from.
 *
 * Why a scheme of its own: the renderer's CSP (`script-src 'self' blob:`)
 * would apply to a `srcdoc` or `blob:` frame too, and block the view's inline
 * scripts; loosening it would loosen the app. A document served here carries
 * the view's own policy (`view-csp.ts`), as a header and as a `<meta>`.
 *
 * What holds the view in:
 * - the frame is `sandbox="allow-scripts"`, without `allow-same-origin`: an
 *   opaque origin, no storage, no cookies, no access to the app's window;
 * - the token is random and names one view, for as long as its frame is
 *   open; any other path, method or token answers 404;
 * - a frame showing a view navigates nowhere else (`isMcpAppFrameNavigationAllowed`),
 *   which keeps a view from leaving its own policy behind.
 */

import { randomBytes } from "node:crypto";
import { buildViewCsp, withCspMeta } from "./view-csp";
import type { McpAppViewFile } from "./view-store";

export const MCP_APP_SCHEME = "workpilot-mcp-app";
const MAX_OPEN_VIEWS = 16;

interface OpenView {
	taskId: string;
	html: string;
	csp: string;
}

const open = new Map<string, OpenView>();

/** Serve one view until `closeMcpAppView`; the oldest is dropped past the cap. */
export function openMcpAppView(taskId: string, view: McpAppViewFile): { token: string; url: string } {
	const token = randomBytes(16).toString("hex");
	const csp = buildViewCsp(view.ui);
	open.set(token, { taskId, html: withCspMeta(view.html, csp), csp });
	while (open.size > MAX_OPEN_VIEWS) {
		const oldest = open.keys().next().value;
		if (oldest === undefined) break;
		open.delete(oldest);
	}
	return { token, url: `${MCP_APP_SCHEME}://${token}/` };
}

export function closeMcpAppView(token: unknown): boolean {
	return typeof token === "string" && open.delete(token);
}

/** Close every view of a task (the task panel closed, the task was deleted). */
export function closeMcpAppViewsOf(taskId: string): void {
	for (const [token, view] of open) {
		if (view.taskId === taskId) open.delete(token);
	}
}

export interface ServedView {
	status: number;
	headers: Record<string, string>;
	body: string;
}

const NOT_FOUND: ServedView = {
	status: 404,
	headers: { "Content-Type": "text/plain; charset=utf-8" },
	body: "Not found",
};

/** The answer for one request on the scheme. */
export function serveMcpAppRequest(method: string, rawUrl: string): ServedView {
	if (method !== "GET") return NOT_FOUND;
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		return NOT_FOUND;
	}
	if (url.protocol !== `${MCP_APP_SCHEME}:` || url.pathname !== "/" || url.search) {
		return NOT_FOUND;
	}
	const view = open.get(url.hostname);
	if (!view) return NOT_FOUND;
	return {
		status: 200,
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"Content-Security-Policy": view.csp,
			"Cache-Control": "no-store",
			"Referrer-Policy": "no-referrer",
			"X-Content-Type-Options": "nosniff",
			"Cross-Origin-Resource-Policy": "same-origin",
		},
		body: view.html,
	};
}

/**
 * Whether a frame may go to `targetUrl`. A frame showing a view stays on it;
 * the app's own frames are not this policy's business.
 */
export function isMcpAppFrameNavigationAllowed(
	frameUrl: string | undefined,
	targetUrl: string,
): boolean {
	if (!frameUrl?.startsWith(`${MCP_APP_SCHEME}:`)) return true;
	try {
		const from = new URL(frameUrl);
		const to = new URL(targetUrl);
		return to.protocol === from.protocol && to.host === from.host && to.pathname === "/";
	} catch {
		return false;
	}
}

/** For tests. */
export function _resetMcpAppViews(): void {
	open.clear();
}
