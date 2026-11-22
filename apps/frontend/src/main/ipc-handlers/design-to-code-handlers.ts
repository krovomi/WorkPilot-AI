import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import type {
	DesignLoopStats,
	DesignStackDetection,
	DesignToCodeRequest,
	DesignWriteOutcome,
} from "../../shared/types/design-to-code";
import { loopStats } from "../design-loop-history";
import { detectProjectStack } from "../design-to-code-stack";
import { designToCodeService, projectDirFor } from "../design-to-code-service";

export function registerDesignToCodeHandlers(): void {
	ipcMain.handle(
		IPC_CHANNELS.DESIGN_TO_CODE_RUN,
		async (event, request: DesignToCodeRequest) => {
			// The renderer store awaits this result; failures reject so the
			// store surfaces them. Each phase reaches the page as it happens.
			return await designToCodeService.run(request, (progress) => {
				if (!event.sender.isDestroyed()) {
					event.sender.send(IPC_CHANNELS.DESIGN_TO_CODE_PROGRESS, progress);
				}
			});
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.DESIGN_TO_CODE_DETECT_STACK,
		async (_event, projectId: unknown): Promise<DesignStackDetection> => {
			const projectDir = projectDirFor(projectId);
			if (!projectDir) {
				return { stack: null, style: null, evidence: [], designSystemPath: null };
			}
			return detectProjectStack(projectDir);
		},
	);

	// The project is named by its id, never by a path (S6).
	ipcMain.handle(
		IPC_CHANNELS.DESIGN_TO_CODE_LOOP_STATS,
		async (_event, projectId: unknown): Promise<DesignLoopStats> =>
			loopStats(projectDirFor(projectId)),
	);

	ipcMain.handle(
		IPC_CHANNELS.DESIGN_TO_CODE_WRITE_FILES,
		async (_event, projectId: unknown, files: unknown): Promise<DesignWriteOutcome> =>
			designToCodeService.writeFiles(projectId, files),
	);
}
