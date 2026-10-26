/**
 * A question an Agent Client Protocol agent asks before it acts, shown on the
 * task's card (`core/agent_clients/acp_permissions.py` in the backend).
 *
 * The question arrives as a `PERMISSION_REQUESTED` task event; the answer goes
 * back to the build process on its stdin, written by the main process only.
 * Every text field was written by the agent: it is displayed, never run.
 */

/** ACP `PermissionOptionKind`. */
export type TaskPermissionOptionKind =
	| "allow_once"
	| "allow_always"
	| "reject_once"
	| "reject_always";

export interface TaskPermissionOption {
	optionId: string;
	name: string;
	kind: TaskPermissionOptionKind;
}

export interface TaskPermissionRequest {
	requestId: string;
	taskId: string;
	projectId?: string;
	/** The agent's name, e.g. "Gemini CLI". */
	agent: string;
	/** What it wants to do, in its words ("Writing to notes/ok.txt"). */
	title: string;
	/** ACP `ToolKind`: read, edit, delete, move, search, execute, fetch, other… */
	kind: string;
	options: TaskPermissionOption[];
	/** Paths the action touches, relative to the project when inside it. */
	locations: string[];
	/** When the build stops waiting and refuses. */
	expiresAt: string;
}

export type TaskPermissionAnswerResult =
	| { ok: true }
	| { ok: false; reason: "not_pending" | "invalid_option" | "process_gone" };
