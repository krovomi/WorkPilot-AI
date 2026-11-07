/**
 * Design-to-Code API — preload bridge for the "Import Design" pipeline
 * (design image → structured spec → generated code → files in the project).
 */
import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import type {
	DesignFileToWrite,
	DesignStackDetection,
	DesignToCodeProgress,
	DesignToCodeRequest,
	DesignToCodeResult,
	DesignWriteOutcome,
} from "../../../shared/types/design-to-code";
import { createIpcListener, invokeIpc } from "./ipc-utils";

export type {
	DesignToCodeRequest,
	DesignToCodeResult as DesignToCodePipelineResult,
};

export interface DesignToCodeAPI {
	runDesignToCodePipeline: (
		request: DesignToCodeRequest,
	) => Promise<DesignToCodeResult>;
	detectDesignStack: (projectId: string) => Promise<DesignStackDetection>;
	writeDesignFiles: (
		projectId: string,
		files: DesignFileToWrite[],
	) => Promise<DesignWriteOutcome>;
	onDesignToCodeProgress: (
		callback: (progress: DesignToCodeProgress) => void,
	) => () => void;
}

export function createDesignToCodeAPI(): DesignToCodeAPI {
	return {
		runDesignToCodePipeline: (request) =>
			invokeIpc(IPC_CHANNELS.DESIGN_TO_CODE_RUN, request),
		detectDesignStack: (projectId) =>
			invokeIpc(IPC_CHANNELS.DESIGN_TO_CODE_DETECT_STACK, projectId),
		writeDesignFiles: (projectId, files) =>
			invokeIpc(IPC_CHANNELS.DESIGN_TO_CODE_WRITE_FILES, projectId, files),
		onDesignToCodeProgress: (callback) =>
			createIpcListener(IPC_CHANNELS.DESIGN_TO_CODE_PROGRESS, callback),
	};
}
