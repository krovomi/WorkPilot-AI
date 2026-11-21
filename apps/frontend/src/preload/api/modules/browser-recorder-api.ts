/**
 * Browser Agent recorder API (#387): start and stop a recording, hear its
 * steps, answer a dialog its page opened, export the steps kept as a test.
 */
import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import type {
	RecorderEvent,
	RecorderExportOutcome,
	RecorderExportRequest,
} from "../../../shared/types/browser-recorder";
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
});
