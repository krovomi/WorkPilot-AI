/**
 * Screenshot API
 *
 * Provides screenshot capture functionality via IPC to the main process.
 * Uses Electron's desktopCapturer to capture screens and windows.
 */

import { ipcRenderer } from "electron";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import type {
	ScreenshotCaptureOptions,
	ScreenshotCaptureResult,
	ScreenshotSource,
	ScreenshotSourcesResult,
} from "../../shared/types/screenshot";

// Re-export types for convenience
export type { ScreenshotSource, ScreenshotCaptureOptions };

export interface ScreenshotAPI {
	getSources: () => Promise<ScreenshotSourcesResult>;
	capture: (options: ScreenshotCaptureOptions) => Promise<ScreenshotCaptureResult>;
}

export const createScreenshotAPI = (): ScreenshotAPI => ({
	getSources: () => ipcRenderer.invoke(IPC_CHANNELS.SCREENSHOT_GET_SOURCES),
	capture: (options) =>
		ipcRenderer.invoke(IPC_CHANNELS.SCREENSHOT_CAPTURE, options),
});
