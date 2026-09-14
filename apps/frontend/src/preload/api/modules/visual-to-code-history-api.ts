/**
 * Visual-to-Code history — preload bridge for the construction timeline.
 *
 * `list` deliberately answers with metadata only. The panel draws a row per
 * version, and a row needs a date, a name and what changed — not the forty
 * blocks the version captured. Bodies cross this bridge one at a time, when a
 * version is actually restored.
 */
import { ipcRenderer } from "electron";
import type {
	ArchitectureVersion,
	ArchitectureVersionInput,
	ArchitectureVersionMeta,
} from "../../../shared/types/visual-to-code-history";
import type { IPCResult } from "../../../shared/types";

export interface VisualToCodeHistoryAPI {
	listArchitectureVersions: (
		architectureId: string,
	) => Promise<IPCResult<ArchitectureVersionMeta[]>>;
	getArchitectureVersion: (
		architectureId: string,
		versionId: string,
	) => Promise<IPCResult<ArchitectureVersion | null>>;
	appendArchitectureVersion: (
		architectureId: string,
		version: ArchitectureVersionInput,
	) => Promise<IPCResult<ArchitectureVersionMeta[]>>;
	labelArchitectureVersion: (
		architectureId: string,
		versionId: string,
		label: string | null,
	) => Promise<IPCResult<ArchitectureVersionMeta[]>>;
	deleteArchitectureVersion: (
		architectureId: string,
		versionId: string,
	) => Promise<IPCResult<ArchitectureVersionMeta[]>>;
	deleteArchitectureHistory: (
		architectureId: string,
	) => Promise<IPCResult<void>>;
}

export function createVisualToCodeHistoryAPI(): VisualToCodeHistoryAPI {
	return {
		listArchitectureVersions: (architectureId) =>
			ipcRenderer.invoke("visualToCodeHistory:list", architectureId),
		getArchitectureVersion: (architectureId, versionId) =>
			ipcRenderer.invoke("visualToCodeHistory:get", architectureId, versionId),
		appendArchitectureVersion: (architectureId, version) =>
			ipcRenderer.invoke(
				"visualToCodeHistory:append",
				architectureId,
				version,
			),
		labelArchitectureVersion: (architectureId, versionId, label) =>
			ipcRenderer.invoke(
				"visualToCodeHistory:label",
				architectureId,
				versionId,
				label,
			),
		deleteArchitectureVersion: (architectureId, versionId) =>
			ipcRenderer.invoke(
				"visualToCodeHistory:deleteVersion",
				architectureId,
				versionId,
			),
		deleteArchitectureHistory: (architectureId) =>
			ipcRenderer.invoke("visualToCodeHistory:deleteAll", architectureId),
	};
}
