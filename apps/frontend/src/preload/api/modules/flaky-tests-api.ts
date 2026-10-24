/**
 * Flaky Tests API
 *
 * Renderer-side bridge to the flaky tests runner.
 */

import type { FlakyReport } from "../../../shared/types/flaky-tests";
import { createIpcListener, invokeIpc } from "./ipc-utils";
import { IPC_CHANNELS } from "../../../shared/constants/ipc";

export interface FlakyTestsRunOptions {
	projectPath: string;
}

export interface FlakyTestsEvent {
	type: "start" | "progress" | "complete";
	data: { status?: string; flakyCount?: number; totalTests?: number };
}

export interface FlakyTestsAPI {
	runFlakyTestsScan: (options: FlakyTestsRunOptions) => Promise<FlakyReport>;
	cancelFlakyTestsScan: () => Promise<boolean>;
	onFlakyTestsEvent: (
		callback: (event: FlakyTestsEvent) => void,
	) => () => void;
	onFlakyTestsResult: (
		callback: (report: FlakyReport) => void,
	) => () => void;
	onFlakyTestsError: (callback: (error: string) => void) => () => void;
}

export const createFlakyTestsAPI = (): FlakyTestsAPI => ({
	runFlakyTestsScan: (options: FlakyTestsRunOptions) =>
		invokeIpc<FlakyReport>(IPC_CHANNELS.FLAKY_TESTS_RUN, options),

	cancelFlakyTestsScan: () => invokeIpc<boolean>(IPC_CHANNELS.FLAKY_TESTS_CANCEL),

	onFlakyTestsEvent: (callback) =>
		createIpcListener<[FlakyTestsEvent]>(IPC_CHANNELS.FLAKY_TESTS_EVENT, (payload) =>
			callback(payload),
		),

	onFlakyTestsResult: (callback) =>
		createIpcListener<[FlakyReport]>(IPC_CHANNELS.FLAKY_TESTS_RESULT, (payload) =>
			callback(payload),
		),

	onFlakyTestsError: (callback) =>
		createIpcListener<[string]>(IPC_CHANNELS.FLAKY_TESTS_ERROR, (payload) =>
			callback(payload),
		),
});
