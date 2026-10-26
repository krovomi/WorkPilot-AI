/**
 * Whether each task's commands run in the OS sandbox, as its build said at
 * launch (`SANDBOX_STATUS`, `apps/backend/os_sandbox/report`).
 *
 * One status per task and provider, the latest winning: a build that
 * switches provider between phases says so for each. Read from the build's
 * stdout, so validated here; it is shown, never acted on.
 */
import { z } from "zod";
import type { TaskSandboxStatus } from "../shared/types/task-sandbox";

const StatusSchema = z.object({
	provider: z.string().min(1).max(64),
	state: z.enum(["isolated", "delegated", "unavailable", "off"]),
	backend: z.string().max(64).nullable(),
	reason: z.string().max(500).nullable(),
	network: z.array(z.string().max(260)).max(200),
});

/** The status carried by a `SANDBOX_STATUS` event, or null. */
export function parseSandboxStatus(
	taskId: string,
	event: { sandbox?: unknown },
	projectId?: string,
): TaskSandboxStatus | null {
	const parsed = StatusSchema.safeParse(event.sandbox);
	if (!parsed.success) return null;
	return { ...parsed.data, taskId, projectId };
}

export class TaskSandboxRegistry {
	private readonly byTask = new Map<string, Map<string, TaskSandboxStatus>>();

	set(status: TaskSandboxStatus): void {
		const statuses = this.byTask.get(status.taskId) ?? new Map();
		statuses.set(status.provider, status);
		this.byTask.set(status.taskId, statuses);
	}

	list(): TaskSandboxStatus[] {
		return [...this.byTask.values()].flatMap((statuses) => [...statuses.values()]);
	}
}

export const taskSandboxes = new TaskSandboxRegistry();
