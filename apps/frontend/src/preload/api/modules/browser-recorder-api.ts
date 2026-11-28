/**
 * Browser Agent recorder API (#387): start and stop a recording, hear its
 * steps, answer a dialog its page opened, export the steps kept as a test,
 * run that test on its review card, replay the recording to check its selectors.
 */
import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import type {
	RecorderEvent,
	RecorderExportOutcome,
	RecorderExportRequest,
} from "../../../shared/types/browser-recorder";
import type { RecorderAssistOutcome, RecorderRunOutcome, ReshootOutcome } from "../../../shared/types/browser-recorder-run";
import { createIpcListener, invokeIpc } from "./ipc-utils";

export interface BrowserRecorderAPI {
	startBrowserRecording: (projectPath: string, url: string) => Promise<{ success: boolean; error?: string }>;
	stopBrowserRecording: () => Promise<{ success: boolean }>;
	answerBrowserRecorderDialog: (answer: {
		id: number;
		accept: boolean;
		text: string;
	}) => Promise<{ success: boolean }>;
	exportBrowserRecording: (
		projectPath: string,
		request: RecorderExportRequest,
	) => Promise<RecorderExportOutcome>;
	onBrowserRecorderEvent: (callback: (event: RecorderEvent) => void) => () => void;
	runBrowserRecordedTest: (projectPath: string) => Promise<RecorderRunOutcome>;
	assistBrowserRecording: (projectPath: string) => Promise<RecorderAssistOutcome>;
	reshootBrowserRecording: (projectPath: string) => Promise<ReshootOutcome>;
	applyBrowserReshoot: (projectPath: string, stepIds: readonly string[]) => Promise<{ success: boolean; applied: number }>;
}

export const createBrowserRecorderAPI = (): BrowserRecorderAPI => ({
	startBrowserRecording: (projectPath, url) =>
		invokeIpc(IPC_CHANNELS.BROWSER_AGENT_RECORD_START, projectPath, url),
	stopBrowserRecording: () => invokeIpc(IPC_CHANNELS.BROWSER_AGENT_RECORD_STOP),
	answerBrowserRecorderDialog: (answer) => invokeIpc(IPC_CHANNELS.BROWSER_AGENT_RECORD_DIALOG, answer),
	exportBrowserRecording: (projectPath, request) =>
		invokeIpc(IPC_CHANNELS.BROWSER_AGENT_RECORD_EXPORT, projectPath, request),
	onBrowserRecorderEvent: (callback) =>
		createIpcListener<[RecorderEvent]>(IPC_CHANNELS.BROWSER_AGENT_RECORD_EVENT, (event) => callback(event)),
	runBrowserRecordedTest: (projectPath) => invokeIpc(IPC_CHANNELS.BROWSER_AGENT_RECORD_RUN, projectPath),
	assistBrowserRecording: (projectPath) => invokeIpc(IPC_CHANNELS.BROWSER_AGENT_RECORD_ASSIST, projectPath),
	reshootBrowserRecording: (projectPath) => invokeIpc(IPC_CHANNELS.BROWSER_AGENT_RECORD_RESHOOT, projectPath),
	applyBrowserReshoot: (projectPath, stepIds) =>
		invokeIpc(IPC_CHANNELS.BROWSER_AGENT_RECORD_RESHOOT_APPLY, projectPath, stepIds),
});
