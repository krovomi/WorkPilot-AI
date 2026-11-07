/**
 * Where the workspace views (dashboard, analytics, costs) read their data: the
 * project folder of this computer, or, for a server project, the server,
 * which computes them from the project's runs (`main/server-workspace.ts`).
 * A server project is asked by its id; its mirror is never read.
 */

import type { CostSummary, DashboardSnapshot } from "@shared/types";

type Answer<T> = { success: boolean; error?: string } & T;

/** The project's dashboard snapshot. */
export async function loadDashboardSnapshot(
	projectPath: string,
	serverProjectId?: string,
): Promise<Answer<{ snapshot?: DashboardSnapshot }>> {
	if (!serverProjectId) {
		return globalThis.electronAPI.getDashboardSnapshot(projectPath);
	}
	const result =
		await globalThis.electronAPI.getServerDashboardSnapshot(serverProjectId);
	return { success: result.success, error: result.error, snapshot: result.data };
}

/** What the project's agents spent over the last thirty days. */
export async function loadCostSummary(
	projectPath: string,
	serverProjectId?: string,
): Promise<Answer<{ summary?: CostSummary }>> {
	if (!serverProjectId) {
		return globalThis.electronAPI.getCostSummary(projectPath);
	}
	const result = await globalThis.electronAPI.getServerCostSummary(serverProjectId);
	return { success: result.success, error: result.error, summary: result.data };
}
