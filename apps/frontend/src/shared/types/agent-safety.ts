/**
 * The reinforced sandbox and the anomaly watch: what the Settings pages save,
 * what the backend wrote when it stopped a session, and a task's snapshots.
 *
 * The settings travel to every agent process as `WORKPILOT_AGENT_SAFETY`
 * (`main/agent/agent-safety-env.ts`) and are read again, bounded, by
 * `apps/backend/security/agent_safety_settings.py`.
 */

export type SandboxMode = "normal" | "restricted";

export interface AgentSafetySettings {
	snapshots: {
		/** A git snapshot of the task's worktree before each agent session. */
		enabled: boolean;
		/** Snapshots kept per task. */
		keep: number;
		/** Restore the session's snapshot when the session is stopped. */
		autoRollback: boolean;
	};
	sandbox: {
		mode: SandboxMode;
		/** Project-relative paths a restricted session may write. */
		allowedPaths: string[];
		/** Distinct files a session may write; 0 is no limit. */
		maxFilesWritten: number;
		/** Largest file a write may leave, in MB; 0 is no limit. */
		maxFileSizeMb: number;
		/** Longest session, in minutes; 0 is no limit. */
		maxSessionMinutes: number;
		/** Docker Sandboxes: a microVM per task (`apps/backend/os_sandbox/microvm.py`). Off by default. */
		microvm: {
			enabled: boolean;
			/** Memory of each task's VM, in GiB; 0 sizes it from the machine. */
			memoryGb: number;
			/** CPUs of each task's VM; 0 sizes it from the machine. */
			cpus: number;
		};
	};
	anomaly: {
		enabled: boolean;
		/** Trust score at or below which the task is paused. */
		pauseBelow: number;
		/** Trust score at or below which the session is stopped (and rolled back). */
		stopBelow: number;
		massDeletionCount: number;
		maxErrorCount: number;
		rapidChangeWindowS: number;
	};
}

/** One anomaly as the pause records it (`agents/safety_watch.py`). */
export interface AnomalyRecord {
	type: string;
	severity: string;
	description: string;
}

/** Shared by both pause kinds: the snapshot of the session and what became of it. */
interface SafetyPauseCommon {
	phase?: string;
	snapshotId?: string | null;
	/** A rollback was due (the session was stopped and auto-rollback is on). */
	rollback?: boolean;
	rolledBack?: boolean;
	safetySnapshotId?: string;
	rollbackError?: string;
}

/** `reason: "anomaly"`: the trust score fell to a threshold. */
export interface AnomalyPauseDetail extends SafetyPauseCommon {
	trustScore: number;
	pauseBelow: number;
	stopBelow: number;
	stopped: boolean;
	anomalies: AnomalyRecord[];
}

export type SandboxViolationKind =
	| "restricted_path"
	| "file_size"
	| "files_written"
	| "session_time";

/** `reason: "sandbox"`: a sandbox limit was crossed. */
export interface SandboxPauseDetail extends SafetyPauseCommon {
	kind: SandboxViolationKind;
	path?: string;
	value?: number;
	limit?: number;
}

/** One snapshot of a task's worktree (`apps/backend/agent_snapshots/store.py`). */
export interface TaskSnapshot {
	snapshot_id: string;
	commit: string;
	head: string;
	created_at: string;
	/** The phase it was taken before, or `before_rollback`. */
	label: string;
}

export interface TaskSnapshotRestore {
	restored: string;
	/** The snapshot of the state the restore replaced: restoring it undoes this one. */
	safety: string;
}
