/**
 * Accessibility Agent API
 *
 * Renderer-side bridge to the WCAG accessibility scanner runner.
 */

import type { A11yReport } from "../../../shared/types/accessibility";
import { createIpcListener, invokeIpc } from "./ipc-utils";
import { IPC_CHANNELS } from "../../../shared/constants/ipc";

export interface AccessibilityRunOptions {
	projectPath: string;
	targetLevel?: "A" | "AA" | "AAA";
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
});
