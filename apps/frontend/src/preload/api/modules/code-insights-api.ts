/**
 * Code insights API: the Code review and Refactoring views' bridge to
 * runners/code_insights_runner.py (see code-insights-handlers.ts).
 */

import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import type {
	CodeInsightsAction,
	CodeInsightsRequest,
	CodeInsightsResultMap,
} from "../../../shared/types/code-insights";
import { invokeIpc } from "./ipc-utils";

export interface CodeInsightsAPI {
	runCodeInsights: <A extends CodeInsightsAction>(
		request: CodeInsightsRequest & { action: A },
	) => Promise<CodeInsightsResultMap[A]>;
}

export const createCodeInsightsAPI = (): CodeInsightsAPI => ({
	runCodeInsights: (request) => invokeIpc(IPC_CHANNELS.CODE_INSIGHTS_RUN, request),
});
