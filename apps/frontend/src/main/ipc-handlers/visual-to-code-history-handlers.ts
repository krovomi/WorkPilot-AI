import { ipcMain } from "electron";
import type {
	ArchitectureVersionInput,
} from "../../shared/types/visual-to-code-history";
import {
	appendVersion,
	deleteHistory,
	deleteVersion,
	getVersion,
	labelVersion,
	listVersions,
} from "../visual-to-code-history";

/**
 * The construction history of the Visual-to-Code architectures.
 *
 * Every handler answers with `{ success, data }` rather than throwing across
 * the bridge: the canvas is an editor, and a history that cannot be read is a
 * reason to show an empty timeline, never a reason to take the editor down.
 */
export function registerVisualToCodeHistoryHandlers(): void {
	ipcMain.handle(
		"visualToCodeHistory:list",
		async (_event, architectureId: string) => {
			try {
				return { success: true, data: listVersions(architectureId) };
			} catch (error) {
				return {
					success: false,
					error: error instanceof Error ? error.message : "Unknown error",
				};
			}
		},
	);

	ipcMain.handle(
		"visualToCodeHistory:get",
		async (_event, architectureId: string, versionId: string) => {
			try {
				return { success: true, data: getVersion(architectureId, versionId) };
			} catch (error) {
				return {
					success: false,
					error: error instanceof Error ? error.message : "Unknown error",
				};
			}
		},
	);

	ipcMain.handle(
		"visualToCodeHistory:append",
		async (
			_event,
			architectureId: string,
			version: ArchitectureVersionInput,
		) => {
			try {
				return { success: true, data: appendVersion(architectureId, version) };
			} catch (error) {
				return {
					success: false,
					error: error instanceof Error ? error.message : "Unknown error",
				};
			}
		},
	);

	ipcMain.handle(
		"visualToCodeHistory:label",
		async (
			_event,
			architectureId: string,
			versionId: string,
			label: string | null,
		) => {
			try {
				return {
					success: true,
					data: labelVersion(architectureId, versionId, label),
				};
			} catch (error) {
				return {
					success: false,
					error: error instanceof Error ? error.message : "Unknown error",
				};
			}
		},
	);

	ipcMain.handle(
		"visualToCodeHistory:deleteVersion",
		async (_event, architectureId: string, versionId: string) => {
			try {
				return {
					success: true,
					data: deleteVersion(architectureId, versionId),
				};
			} catch (error) {
				return {
					success: false,
					error: error instanceof Error ? error.message : "Unknown error",
				};
			}
		},
	);

	ipcMain.handle(
		"visualToCodeHistory:deleteAll",
		async (_event, architectureId: string) => {
			try {
				deleteHistory(architectureId);
				return { success: true };
			} catch (error) {
				return {
					success: false,
					error: error instanceof Error ? error.message : "Unknown error",
				};
			}
		},
	);
}
