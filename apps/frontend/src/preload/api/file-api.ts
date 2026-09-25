import type {
	ReviewFileEntry,
	ReviewFileData,
	ReviewScope,
} from "../../shared/types/code-review";
import { ipcRenderer } from "electron";
import { IPC_CHANNELS } from "../../shared/constants";
import type { IPCResult } from "../../shared/types";

export interface FileAPI {
	listReviewFiles: (projectId: string) => Promise<IPCResult<ReviewFileEntry[]>>;
	readReviewFile: (
		projectId: string,
		file: string,
		scope: ReviewScope,
	) => Promise<IPCResult<ReviewFileData>>;
	// File Explorer Operations
	listDirectory: (
		dirPath: string,
	) => Promise<IPCResult<import("../../shared/types").FileNode[]>>;
	readFile: (filePath: string) => Promise<IPCResult<string>>;
	saveJsonFile: (
		dirPath: string,
		fileName: string,
		data: unknown,
	) => Promise<IPCResult<boolean>>;
	getUserHome: () => Promise<string>;
	searchProjectFiles: (
		rootPath: string,
		query: string,
		mode: "file" | "directory",
	) => Promise<IPCResult<import("../../shared/types").FileSearchResult[]>>;
}

export const createFileAPI = (): FileAPI => ({
	listReviewFiles: (projectId) =>
		ipcRenderer.invoke(IPC_CHANNELS.CODE_REVIEW_FILES, projectId),
	readReviewFile: (projectId, file, scope) =>
		ipcRenderer.invoke(IPC_CHANNELS.CODE_REVIEW_FILE, projectId, file, scope),
	// File Explorer Operations
	listDirectory: (
		dirPath: string,
	): Promise<IPCResult<import("../../shared/types").FileNode[]>> =>
		ipcRenderer.invoke(IPC_CHANNELS.FILE_EXPLORER_LIST, dirPath),
	readFile: (filePath: string): Promise<IPCResult<string>> =>
		ipcRenderer.invoke(IPC_CHANNELS.FILE_EXPLORER_READ, filePath),
	saveJsonFile: (
		dirPath: string,
		fileName: string,
		data: unknown,
	): Promise<IPCResult<boolean>> =>
		ipcRenderer.invoke(
			IPC_CHANNELS.FILE_EXPLORER_SAVE,
			dirPath,
			fileName,
			data,
		),
	getUserHome: (): Promise<string> =>
		ipcRenderer.invoke(IPC_CHANNELS.FILE_EXPLORER_GET_USER_HOME),
	searchProjectFiles: (
		rootPath: string,
		query: string,
		mode: "file" | "directory",
	): Promise<IPCResult<import("../../shared/types").FileSearchResult[]>> =>
		ipcRenderer.invoke(
			IPC_CHANNELS.FILE_EXPLORER_SEARCH,
			rootPath,
			query,
			mode,
		),
});
