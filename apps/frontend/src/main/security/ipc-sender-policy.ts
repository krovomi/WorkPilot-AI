/**
 * Only the app's own page, in the main window's top frame, calls the main
 * process.
 *
 * The preload bridge exposes every IPC channel to whatever page runs in the
 * main window. The navigation guards of `index.ts` keep that page the app's,
 * and a subframe gets no preload; this is the check on the receiving side
 * (security.md, S6: what crosses a boundary is revalidated by the side that
 * receives it). `installIpcSenderPolicy` wraps `ipcMain.handle` and
 * `ipcMain.on`: a message from another webContents, from a subframe, from a
 * frame already gone, or from a page that is not the app's never reaches its
 * handler.
 */

import type { IpcMain } from "electron";

/** What a handler returns when the sender is refused. */
export const SENDER_REFUSED = "ipc-sender-refused";

interface SenderWindow {
	webContents: unknown;
}

export interface SenderPolicy {
	/** The window whose page may call the main process. */
	getMainWindow: () => SenderWindow | null;
	/** The dev server URL while developing; the app loads file:// otherwise. */
	devServerUrl?: string;
}

/** What the check reads of an `IpcMainEvent` or `IpcMainInvokeEvent`. */
export interface SenderEvent {
	sender: { mainFrame: unknown };
	senderFrame: { url: string } | null;
}

function isAppUrl(raw: string, devServerUrl: string | undefined): boolean {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return false;
	}
	if (!devServerUrl) return url.protocol === "file:";
	try {
		return url.origin === new URL(devServerUrl).origin;
	} catch {
		return false;
	}
}

export function isTrustedSender(
	event: SenderEvent,
	policy: SenderPolicy,
): boolean {
	const window = policy.getMainWindow();
	if (!window || event.sender !== window.webContents) return false;
	let frame: { url: string } | null;
	try {
		frame = event.senderFrame;
	} catch {
		// Electron throws when the frame navigated or was destroyed meanwhile.
		return false;
	}
	if (!frame || frame !== event.sender.mainFrame) return false;
	return isAppUrl(frame.url, policy.devServerUrl);
}

let installed = false;

/** Wrap `ipc.handle` and `ipc.on` once, before any handler is registered. */
export function installIpcSenderPolicy(
	ipc: Pick<IpcMain, "handle" | "on">,
	policy: SenderPolicy,
): void {
	if (installed) return;
	installed = true;
	const handle = ipc.handle.bind(ipc);
	const on = ipc.on.bind(ipc);

	ipc.handle = ((channel: string, listener: Parameters<IpcMain["handle"]>[1]) =>
		handle(channel, (event, ...args) => {
			if (!isTrustedSender(event as unknown as SenderEvent, policy)) {
				console.warn(`[ipc-sender-policy] refused ${channel}`);
				return { success: false, error: SENDER_REFUSED };
			}
			return listener(event, ...args);
		})) as IpcMain["handle"];

	ipc.on = ((channel: string, listener: Parameters<IpcMain["on"]>[1]) =>
		on(channel, (event, ...args) => {
			if (!isTrustedSender(event as unknown as SenderEvent, policy)) {
				console.warn(`[ipc-sender-policy] refused ${channel}`);
				return;
			}
			listener(event, ...args);
		})) as IpcMain["on"];
}

/** For tests: let the next `installIpcSenderPolicy` wrap again. */
export function resetIpcSenderPolicyForTests(): void {
	installed = false;
}
