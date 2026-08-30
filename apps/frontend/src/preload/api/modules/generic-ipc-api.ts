/**
 * Generic IPC API
 *
 * The escape hatch for renderer code that talks to a channel no typed module
 * covers. `invoke` already existed — parked, for no reason anyone recorded, on
 * `CopilotOAuthAPI` — but its listener counterpart did not, so
 * `electronAPI.on(...)` and `electronAPI.onIpcEvent(...)` were called in four
 * places against a method the bridge never defined:
 *
 *   - `credentialService` subscribed to `credential:updated`, `usage:changed`
 *     and `provider:switched`, and got none of them;
 *   - `cross-language-translation-store` subscribed to the translation stream,
 *     so the pane stayed empty until the final result landed.
 *
 * `ElectronAPI` carries an `[x: string]: any` index signature, so none of it
 * ever failed to compile.
 *
 * Prefer a typed module (see `flaky-tests-api.ts`) for anything durable; this
 * is for one-off channels and for code that picks its channel at runtime.
 */

import { createIpcListener, invokeIpc, sendIpc } from "./ipc-utils";

export interface GenericIpcAPI {
	/** Invoke any channel and await its reply. */
	// biome-ignore lint/suspicious/noExplicitAny: a generic escape hatch
	invoke: (channel: string, ...args: any[]) => Promise<any>;
	/**
	 * Fire a channel without awaiting a reply — the `ipcMain.on` counterpart.
	 * `context-mesh-store` has always called it against a bridge that never
	 * defined it, while `context-mesh-handlers` listened on the other end.
	 */
	// biome-ignore lint/suspicious/noExplicitAny: a generic escape hatch
	send: (channel: string, ...args: any[]) => void;
	/** Subscribe to any channel. Returns the unsubscribe function. */
	// biome-ignore lint/suspicious/noExplicitAny: a generic escape hatch
	on: (channel: string, callback: (...args: any[]) => void) => () => void;
	/** Alias of `on`, for callers that spell it out. */
	onIpcEvent: (
		channel: string,
		// biome-ignore lint/suspicious/noExplicitAny: a generic escape hatch
		callback: (...args: any[]) => void,
	) => () => void;
}

export const createGenericIpcAPI = (): GenericIpcAPI => ({
	// biome-ignore lint/suspicious/noExplicitAny: a generic escape hatch
	invoke: (channel: string, ...args: any[]) => invokeIpc(channel, ...args),

	// biome-ignore lint/suspicious/noExplicitAny: a generic escape hatch
	send: (channel: string, ...args: any[]) => sendIpc(channel, ...args),

	// biome-ignore lint/suspicious/noExplicitAny: a generic escape hatch
	on: (channel: string, callback: (...args: any[]) => void) =>
		createIpcListener(channel, callback),

	// biome-ignore lint/suspicious/noExplicitAny: a generic escape hatch
	onIpcEvent: (channel: string, callback: (...args: any[]) => void) =>
		createIpcListener(channel, callback),
});
