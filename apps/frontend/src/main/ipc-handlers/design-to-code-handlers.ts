import { ipcMain } from "electron";
import {
	type DesignToCodeRequest,
	designToCodeService,
} from "../design-to-code-service";
import { IPC_CHANNELS } from "../../shared/constants/ipc";

export function registerDesignToCodeHandlers(): void {
	ipcMain.handle(
		IPC_CHANNELS.DESIGN_TO_CODE_RUN,
		async (_event, request: DesignToCodeRequest) => {
			// The renderer store awaits this result directly and casts it to
			// DesignToCodeResult. Let failures reject so the store's catch surfaces
			// them via setPipelineError.
			return await designToCodeService.run(request);
		},
	);
}
