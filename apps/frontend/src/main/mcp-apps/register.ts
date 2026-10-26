/**
 * Wires the MCP App scheme and its frame guard into Electron.
 *
 * `registerMcpAppScheme` runs before `app.whenReady()` (Electron requires
 * it); `serveMcpAppScheme` after. The scheme is `standard` and `secure` so a
 * view gets a real URL and a secure context; it is not `bypassCSP`, not
 * `corsEnabled`, and has no fetch API: nothing on it can be fetched from the
 * app's pages, only framed.
 */

import { type BrowserWindow, protocol } from "electron";
import {
	isMcpAppFrameNavigationAllowed,
	MCP_APP_SCHEME,
	serveMcpAppRequest,
} from "./view-protocol";

export function registerMcpAppScheme(): void {
	protocol.registerSchemesAsPrivileged([
		{ scheme: MCP_APP_SCHEME, privileges: { standard: true, secure: true } },
	]);
}

export function serveMcpAppScheme(): void {
	protocol.handle(MCP_APP_SCHEME, (request) => {
		const served = serveMcpAppRequest(request.method, request.url);
		return new Response(served.body, {
			status: served.status,
			headers: served.headers,
		});
	});
}

export function guardMcpAppFrames(window: BrowserWindow): void {
	window.webContents.on("will-frame-navigate", (event) => {
		if (event.isMainFrame) return;
		if (!isMcpAppFrameNavigationAllowed(event.frame?.url, event.url)) {
			event.preventDefault();
			console.warn("[main] Blocked an MCP App view's navigation to:", event.url);
		}
	});
}
