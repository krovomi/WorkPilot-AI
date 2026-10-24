import { ipcRenderer } from "electron";
import type { PlaygroundResult } from "../../../main/code-playground-service";
import { IPC_CHANNELS } from "../../../shared/constants/ipc";

export interface CodePlaygroundAPI {
	/**
	 * Start code playground generation
	 */
	startCodePlayground: (
		projectId: string,
		idea: string,
		playgroundType: string,
		sandboxType: string,
	) => void;

	/**
	 * Listen for streaming output chunks
	 */
	onCodePlaygroundStreamChunk: (
		callback: (chunk: string) => void,
	) => () => void;

	/**
	 * Listen for status updates
	 */
	onCodePlaygroundStatus: (callback: (status: string) => void) => () => void;

	/**
	 * Listen for errors
	 */
	onCodePlaygroundError: (callback: (error: string) => void) => () => void;

	/**
	 * Listen for completion with result
	 */
	onCodePlaygroundComplete: (
		callback: (result: PlaygroundResult) => void,
	) => () => void;

	/**
	 * Cancel active playground generation
	 */
	cancelCodePlayground: () => void;
}

export function createCodePlaygroundAPI(): CodePlaygroundAPI {
	return {
		startCodePlayground: (
			projectId: string,
			idea: string,
			playgroundType: string,
			sandboxType: string,
		) => {
			ipcRenderer.send(IPC_CHANNELS.CODE_PLAYGROUND_START, {
				projectId,
				idea,
				playgroundType,
				sandboxType,
			});
		},

		onCodePlaygroundStreamChunk: (callback: (chunk: string) => void) => {
			const subscription = ipcRenderer.on(
				IPC_CHANNELS.CODE_PLAYGROUND_STREAM_CHUNK,
				(_, chunk) => callback(chunk),
			);
			return () => subscription.removeAllListeners();
		},

		onCodePlaygroundStatus: (callback: (status: string) => void) => {
			const subscription = ipcRenderer.on(
				IPC_CHANNELS.CODE_PLAYGROUND_STATUS,
				(_, status) => callback(status),
			);
			return () => subscription.removeAllListeners();
		},

		onCodePlaygroundError: (callback: (error: string) => void) => {
			const subscription = ipcRenderer.on(IPC_CHANNELS.CODE_PLAYGROUND_ERROR, (_, error) =>
				callback(error),
			);
			return () => subscription.removeAllListeners();
		},

		onCodePlaygroundComplete: (
			callback: (result: PlaygroundResult) => void,
		) => {
			const subscription = ipcRenderer.on(
				IPC_CHANNELS.CODE_PLAYGROUND_COMPLETE,
				(_, result) => callback(result),
			);
			return () => subscription.removeAllListeners();
		},

		cancelCodePlayground: () => {
			ipcRenderer.send(IPC_CHANNELS.CODE_PLAYGROUND_CANCEL);
		},
	};
}
