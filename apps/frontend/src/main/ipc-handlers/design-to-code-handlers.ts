import { ipcMain } from "electron";
import {
	type DesignToCodeRequest,
	designToCodeService,
} from "../design-to-code-service";

export function registerDesignToCodeHandlers(): void {
	ipcMain.handle(
		"designToCode:run",
		async (_event, request: DesignToCodeRequest) => {
			// The renderer store awaits this result directly and casts it to
			// DesignToCodeResult. Let failures reject so the store's catch surfaces
			// them via setPipelineError.
			return await designToCodeService.run(request);
		},
	);
}
