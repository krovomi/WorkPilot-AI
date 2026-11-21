/**
 * Screenshot IPC Handlers
 *
 * Provides screenshot capture functionality using Electron's desktopCapturer API.
 * Users can capture screenshots of their entire screen or individual application windows.
 *
 * Note: Screenshot capture may not work in development mode (app.isPackaged === false)
 * due to macOS screen recording permission requirements for unsigned builds.
 * In dev mode, the handler returns a devMode flag so the UI can show a helpful message.
 */
import { debugLog } from "../../shared/utils/debug-logger";
import { app, desktopCapturer, ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import type {
	ScreenshotCaptureResult,
	ScreenshotSource,
	ScreenshotSourcesResult,
} from "../../shared/types/screenshot";

/**
 * Register screenshot capture handlers
 */
export function registerScreenshotHandlers(): void {
	/**
	 * Get available screenshot sources (screens and windows)
	 *
	 * In development mode (app.isPackaged === false), returns devMode: true
	 * instead of attempting to get sources, as screen recording permissions
	 * typically aren't granted to unsigned development builds on macOS.
	 */
	ipcMain.handle(IPC_CHANNELS.SCREENSHOT_GET_SOURCES, async (): Promise<ScreenshotSourcesResult> => {
		// Check if running in development mode
		// Dev builds don't have screen recording permissions on macOS
		if (!app.isPackaged) {
			return {
				success: false,
				devMode: true,
			};
		}

		try {
			const sources = await desktopCapturer.getSources({
				types: ["screen", "window"],
				thumbnailSize: {
					width: 320,
					height: 240,
				},
			});

			return {
				success: true,
				data: sources.map(
					(source): ScreenshotSource => ({
						id: source.id,
						name: source.name,
						thumbnail: source.thumbnail.toDataURL(),
					}),
				),
			};
		} catch (error) {
			// The OS's reason stays in the log; the renderer gets a code it translates.
			console.error("Failed to get screenshot sources:", error);
			return { success: false, error: "sources_failed" };
		}
	});

	/**
	 * Capture screenshot from selected source
	 * Returns full resolution screenshot as base64 PNG
	 */
	ipcMain.handle(
		IPC_CHANNELS.SCREENSHOT_CAPTURE,
		async (_event, options: unknown): Promise<ScreenshotCaptureResult> => {
			// The renderer is not trusted: the source id is checked here
			const sourceId =
				typeof options === "object" && options !== null
					? (options as { sourceId?: unknown }).sourceId
					: undefined;
			if (typeof sourceId !== "string" || sourceId === "") {
				return { success: false, error: "invalid_source" };
			}

			try {
				const sources = await desktopCapturer.getSources({
					types: ["screen", "window"],
					thumbnailSize: {
						// Capture at 2x resolution for retina display support
						width: 3840,
						height: 2160,
					},
				});

				const selectedSource = sources.find((s) => s.id === sourceId);
				if (!selectedSource) {
					return { success: false, error: "source_not_found" };
				}

				// Return the thumbnail which is our high-res capture
				const dataUrl = selectedSource.thumbnail.toDataURL();

				return {
					success: true,
					data: dataUrl,
				};
			} catch (error) {
				console.error("Failed to capture screenshot:", error);
				return { success: false, error: "capture_failed" };
			}
		},
	);

	debugLog("[IPC] Screenshot handlers registered");
}
