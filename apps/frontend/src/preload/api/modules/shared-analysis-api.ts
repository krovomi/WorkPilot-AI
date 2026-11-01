/**
 * Shared Analysis API
 *
 * The last report a member of a server project saved of one of its analyses
 * (accessibility, i18n, documentation drift, flaky tests, technical debt);
 * null for a local project.
 */

import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import { invokeIpc } from "./ipc-utils";

export type SharedAnalysisKind =
	| "accessibility"
	| "i18n"
	| "doc-drift"
	| "flaky-tests"
	| "tech-debt";

export interface SharedAnalysisReport {
	report: unknown;
	finishedAt: string | null;
	runBy: string | null;
}

export interface SharedAnalysisAPI {
	getSharedAnalysisReport: (
		kind: SharedAnalysisKind,
		projectPath: string,
	) => Promise<SharedAnalysisReport | null>;
}

export const createSharedAnalysisAPI = (): SharedAnalysisAPI => ({
	getSharedAnalysisReport: (kind, projectPath) =>
		invokeIpc<SharedAnalysisReport | null>(
			IPC_CHANNELS.ANALYSIS_SHARED_REPORT,
			kind,
			projectPath,
		),
});
