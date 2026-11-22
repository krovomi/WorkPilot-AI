/**
 * CI/CD Triggers API: the rollback of a watched deployment (#366), the
 * services rolled back with it, the watch figures and a person's word on a
 * bad verdict (lot 4).
 *
 * The renderer names a project folder, a run id and project ids; the main
 * process checks each, and the runner reads the run, the endpoints and the
 * tokens itself. The older calls of the CI/CD page still go through the
 * generic passthrough.
 */

import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import type { IPCResult } from "../../../shared/types";
import type {
	DeployLinksView,
	DeployVerdictReview,
	DeployWatch,
	DeployWatchFigures,
} from "../../../shared/types/deploy-watch";
import { invokeIpc } from "./ipc-utils";

export interface CicdTriggersAPI {
	rollbackDeployment: (
		projectDir: string,
		runId: string,
	) => Promise<IPCResult<DeployWatch | undefined>>;
	getDeployLinks: (projectDir: string) => Promise<IPCResult<DeployLinksView>>;
	setDeployLinks: (projectDir: string, projectIds: string[]) => Promise<IPCResult<DeployLinksView>>;
	getDeployFigures: (projectDir: string) => Promise<IPCResult<DeployWatchFigures>>;
	reviewDeployVerdict: (
		projectDir: string,
		runId: string,
		review: DeployVerdictReview | null,
	) => Promise<IPCResult<void>>;
}

export const createCicdTriggersAPI = (): CicdTriggersAPI => ({
	rollbackDeployment: (projectDir, runId) =>
		invokeIpc(IPC_CHANNELS.CICD_TRIGGERS_ROLLBACK, projectDir, runId),
	getDeployLinks: (projectDir) => invokeIpc(IPC_CHANNELS.CICD_TRIGGERS_GET_LINKS, projectDir),
	setDeployLinks: (projectDir, projectIds) =>
		invokeIpc(IPC_CHANNELS.CICD_TRIGGERS_SET_LINKS, projectDir, projectIds),
	getDeployFigures: (projectDir) => invokeIpc(IPC_CHANNELS.CICD_TRIGGERS_GET_FIGURES, projectDir),
	reviewDeployVerdict: (projectDir, runId, review) =>
		invokeIpc(IPC_CHANNELS.CICD_TRIGGERS_REVIEW_VERDICT, projectDir, runId, review),
});
