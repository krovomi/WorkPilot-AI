/**
 * Visual Programming API — preload bridge for diagram-to-code and code-to-diagram features.
 */
import { ipcRenderer } from "electron";
import { IPC_CHANNELS } from "../../../shared/constants/ipc";

export interface VisualProgrammingRequest {
	action: "generate-code" | "code-to-visual";
	diagramJson?: string;
	framework?: string;
	filePath?: string;
	projectPath?: string;
}

export interface GeneratedFile {
	filename: string;
	language: string;
	content: string;
}

export interface GenerateCodeResult {
	files: GeneratedFile[];
	summary: string;
	instructions: string;
	/** The run ended early; these are the files that were already complete. */
	truncated?: boolean;
}

export interface DiagramNode {
	id: string;
	label: string;
	type: string;
	framework: string;
}

export interface DiagramEdge {
	source: string;
	target: string;
	label: string;
}

export interface CodeToVisualResult {
	nodes: DiagramNode[];
	edges: DiagramEdge[];
	summary: string;
}

export interface VisualProgrammingAPI {
	runVisualProgramming: (
		request: VisualProgrammingRequest,
	) => Promise<{ success: boolean; error?: string }>;
	cancelVisualProgramming: () => Promise<{
		success: boolean;
		cancelled: boolean;
		error?: string;
	}>;
	onVisualProgrammingStatus: (callback: (msg: string) => void) => () => void;
	/** A generated file, as soon as its JSON object closes mid-stream. */
	onVisualProgrammingFile: (
		callback: (file: GeneratedFile) => void,
	) => () => void;
	/** The file the model is writing right now, before it is complete. */
	onVisualProgrammingWriting: (
		callback: (filename: string) => void,
	) => () => void;
	onVisualProgrammingError: (callback: (err: string) => void) => () => void;
	onVisualProgrammingComplete: (
		callback: (result: {
			action: string;
			data: GenerateCodeResult | CodeToVisualResult;
		}) => void,
	) => () => void;
}

export function createVisualProgrammingAPI(): VisualProgrammingAPI {
	return {
		runVisualProgramming: (request) =>
			ipcRenderer.invoke(IPC_CHANNELS.VISUAL_PROGRAMMING_RUN, request),

		cancelVisualProgramming: () =>
			ipcRenderer.invoke(IPC_CHANNELS.VISUAL_PROGRAMMING_CANCEL),

		onVisualProgrammingStatus: (callback) => {
			const listener = (_: unknown, msg: string) => callback(msg);
			ipcRenderer.on(IPC_CHANNELS.VISUAL_PROGRAMMING_STATUS, listener);
			return () =>
				ipcRenderer.removeListener("visualProgramming:status", listener);
		},

		onVisualProgrammingFile: (callback) => {
			const listener = (_: unknown, file: GeneratedFile) => callback(file);
			ipcRenderer.on(IPC_CHANNELS.VISUAL_PROGRAMMING_FILE, listener);
			return () =>
				ipcRenderer.removeListener("visualProgramming:file", listener);
		},

		onVisualProgrammingWriting: (callback) => {
			const listener = (_: unknown, filename: string) => callback(filename);
			ipcRenderer.on(IPC_CHANNELS.VISUAL_PROGRAMMING_WRITING, listener);
			return () =>
				ipcRenderer.removeListener("visualProgramming:writing", listener);
		},

		onVisualProgrammingError: (callback) => {
			const listener = (_: unknown, err: string) => callback(err);
			ipcRenderer.on(IPC_CHANNELS.VISUAL_PROGRAMMING_ERROR, listener);
			return () =>
				ipcRenderer.removeListener("visualProgramming:error", listener);
		},

		onVisualProgrammingComplete: (callback) => {
			const listener = (
				_: unknown,
				result: {
					action: string;
					data: GenerateCodeResult | CodeToVisualResult;
				},
			) => callback(result);
			ipcRenderer.on(IPC_CHANNELS.VISUAL_PROGRAMMING_COMPLETE, listener);
			return () =>
				ipcRenderer.removeListener("visualProgramming:complete", listener);
		},
	};
}
