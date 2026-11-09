/**
 * Accessibility Agent API
 *
 * Renderer-side bridge to the WCAG accessibility scanner runner.
 */

import type {
	A11yDynamicReport,
	A11yExportFormat,
	A11yFixOutcome,
	A11yFixRequest,
	A11yReport,
	WcagLevel,
} from "../../../shared/types/accessibility";
import { createIpcListener, invokeIpc } from "./ipc-utils";
import { IPC_CHANNELS } from "../../../shared/constants/ipc";

export interface AccessibilityRunOptions {
	projectPath: string;
	targetLevel?: "A" | "AA" | "AAA";
	/** The language a page-lang fix would declare. */
	pageLang?: string;
}

export interface AccessibilityEvent {
	type: "start" | "progress" | "complete";
	data: { status?: string; violations?: number; filesScanned?: number };
}

export interface AccessibilityAPI {
	runAccessibilityScan: (options: AccessibilityRunOptions) => Promise<A11yReport>;
	cancelAccessibilityScan: () => Promise<boolean>;
	onAccessibilityEvent: (
		callback: (event: AccessibilityEvent) => void,
	) => () => void;
	onAccessibilityResult: (
		callback: (report: A11yReport) => void,
	) => () => void;
	onAccessibilityError: (callback: (error: string) => void) => () => void;
	/** The App Emulator's URL when an app is running, else null. */
	getAccessibilityAppUrl: () => Promise<string | null>;
	/** Scan the running app at `url` (localhost only), or the App Emulator's. */
	runAccessibilityDynamicScan: (options: { url?: string; targetLevel?: WcagLevel }) => Promise<A11yDynamicReport>;
	/** Make fixes on a review card (worktree + branch), never in the checkout. */
	fixAccessibilityViolations: (request: A11yFixRequest) => Promise<A11yFixOutcome>;
	/** Save the report as HTML, CSV or PDF; resolves to the path, or null if cancelled. */
	exportAccessibilityReport: (options: {
		format: A11yExportFormat;
		report: A11yReport;
		title?: string;
	}) => Promise<string | null>;
}

export const createAccessibilityAPI = (): AccessibilityAPI => ({
	runAccessibilityScan: (options: AccessibilityRunOptions) =>
		invokeIpc<A11yReport>(IPC_CHANNELS.ACCESSIBILITY_RUN, options),

	cancelAccessibilityScan: () => invokeIpc<boolean>(IPC_CHANNELS.ACCESSIBILITY_CANCEL),

	onAccessibilityEvent: (callback) =>
		createIpcListener<[AccessibilityEvent]>(
			IPC_CHANNELS.ACCESSIBILITY_EVENT,
			(payload) => callback(payload),
		),

	onAccessibilityResult: (callback) =>
		createIpcListener<[A11yReport]>(IPC_CHANNELS.ACCESSIBILITY_RESULT, (payload) =>
			callback(payload),
		),

	onAccessibilityError: (callback) =>
		createIpcListener<[string]>(IPC_CHANNELS.ACCESSIBILITY_ERROR, (payload) =>
			callback(payload),
		),

	getAccessibilityAppUrl: () => invokeIpc<string | null>(IPC_CHANNELS.ACCESSIBILITY_APP_URL),

	runAccessibilityDynamicScan: (options) =>
		invokeIpc<A11yDynamicReport>(IPC_CHANNELS.ACCESSIBILITY_DYNAMIC, options),

	fixAccessibilityViolations: (request) =>
		invokeIpc<A11yFixOutcome>(IPC_CHANNELS.ACCESSIBILITY_FIX, request),

	exportAccessibilityReport: (options) =>
		invokeIpc<string | null>(IPC_CHANNELS.ACCESSIBILITY_EXPORT, options),
});
