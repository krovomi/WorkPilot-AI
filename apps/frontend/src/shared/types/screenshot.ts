/**
 * Screenshot capture types
 *
 * Shared types for screenshot functionality across main, preload, and renderer processes.
 */

/**
 * Represents a screenshot source (screen or window) available for capture
 */
export interface ScreenshotSource {
	/** Unique identifier for the source */
	id: string;
	/** Display name of the source (e.g., "Screen 1", "Chrome") */
	name: string;
	/** Base64 encoded PNG thumbnail preview */
	thumbnail: string;
}

/**
 * Options for capturing a screenshot
 */
export interface ScreenshotCaptureOptions {
	/** The ID of the source to capture */
	sourceId: string;
}

/**
 * Why a screenshot call failed, as a stable code: the main process never sends
 * an English sentence, the renderer shows `tasks:screenshot.errors.codes.<code>`.
 * What the operating system said stays in the main process's log.
 */
export const SCREENSHOT_ERROR_CODES = [
	"sources_failed",
	"invalid_source",
	"source_not_found",
	"capture_failed",
] as const;

export type ScreenshotErrorCode = (typeof SCREENSHOT_ERROR_CODES)[number];

/** The answer to `SCREENSHOT_GET_SOURCES`. */
export interface ScreenshotSourcesResult {
	success: boolean;
	data?: ScreenshotSource[];
	error?: ScreenshotErrorCode;
	/** Development build: capture is unavailable (no screen recording permission) */
	devMode?: boolean;
}

/** The answer to `SCREENSHOT_CAPTURE`: the capture as a base64 PNG data URL. */
export interface ScreenshotCaptureResult {
	success: boolean;
	data?: string;
	error?: ScreenshotErrorCode;
}
