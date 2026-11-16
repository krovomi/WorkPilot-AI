/**
 * CI/CD Triggers API: the rollback of a watched deployment (#366).
 *
 * The renderer names a project folder and a run id; the main process checks
 * both, and the runner reads the run, the endpoints and the tokens itself.
 * The older calls of the CI/CD page still go through the generic passthrough.
 */

import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import type { IPCResult } from "../../../shared/types";
import type { DeployWatch } from "../../../shared/types/deploy-watch";
import { invokeIpc } from "./ipc-utils";

export interface CicdTriggersAPI {
	rollbackDeployment: (
		projectDir: string,
		runId: string,
	) => Promise<IPCResult<DeployWatch | undefined>>;
}

export const createCicdTriggersAPI = (): CicdTriggersAPI => ({
	rollbackDeployment: (projectDir, runId) =>
		invokeIpc(IPC_CHANNELS.CICD_TRIGGERS_ROLLBACK, projectDir, runId),
});
