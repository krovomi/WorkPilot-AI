/**
 * Whether a task's commands run in the OS sandbox, as the build said at
 * launch (`SANDBOX_STATUS` task event, `apps/backend/os_sandbox/`).
 *
 * - `isolated`: WorkPilot's sandbox (bubblewrap, Seatbelt) is on;
 * - `delegated`: the provider's own tool sandboxes them (Claude Code, Codex);
 * - `unavailable`: they are not isolated, and `reason` says why;
 * - `off`: the person turned the sandbox off (`WORKPILOT_SANDBOX=off`).
 */
export type TaskSandboxState = "isolated" | "delegated" | "unavailable" | "off";

export interface TaskSandboxStatus {
	taskId: string;
	projectId?: string;
	provider: string;
	state: TaskSandboxState;
	backend: string | null;
	reason: string | null;
	network: string[];
}
