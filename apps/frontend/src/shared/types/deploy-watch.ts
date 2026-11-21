/**
 * The watch after a deployment WorkPilot triggered (#366), as the app shows
 * it. Written by `apps/backend/deploy_watch/` to
 * `.workpilot/deploy_watches/<run id>.json`, read and bounded by
 * `main/cicd/deploy-watch.ts`.
 */

export type DeployWatchLevel = "ok" | "warning" | "critical" | "unknown";

export type DeployWatchPhase = "baseline" | "waiting" | "watching" | "done" | "interrupted";

/**
 * What happened to the rollback: offered to a person, started, refused by a
 * migration, only by hand (GitLab, Jenkins, offline), or failed to start.
 */
export type DeployRollbackState =
	| "proposed"
	| "started"
	| "failed"
	| "blocked_migrations"
	| "manual";

export interface DeployMetricCheck {
	name: string;
	kind: string;
	baseline: number | null;
	current: number | null;
	changePct: number | null;
	level: DeployWatchLevel;
}

export interface DeployRollbackPlan {
	provider: string;
	/** rerun | redeploy_commit | manual | no_previous_success | not_configured | unreachable | unsupported | offline */
	reason: string;
	automatic: boolean;
	targetRun: string;
	targetSha: string;
	/** https only. */
	targetUrl: string;
	currentSha: string;
}

/** What became of the revert PR of the deployed commit (`revert_pr: true`). */
export type DeployRevertStatus =
	| "opened"
	| "exists"
	| "failed"
	| "conflict"
	| "no_commit"
	| "unknown_commit"
	| "not_on_branch"
	| "offline"
	| "unavailable";

export interface DeployRevertPr {
	status: DeployRevertStatus;
	/** https only; "" when the forge gave none. */
	url: string;
	sha: string;
}

/** One metric over the window: before, at its worst, and its level then. */
export interface DeployIncidentMetric {
	name: string;
	baseline: number | null;
	worst: number | null;
	worstChangePct: number | null;
	level: DeployWatchLevel;
}

/** The incident report of a warning or critical verdict. */
export interface DeployIncident {
	criticalSamples: number;
	warningSamples: number;
	healthChecks: number;
	healthFailed: number;
	metrics: DeployIncidentMetric[];
	/** The project's model, plain text; "" when there is none. */
	explanation: string;
}

export interface DeployWatch {
	runId: string;
	phase: DeployWatchPhase;
	verdict: DeployWatchLevel;
	startedAt: string;
	endsAt?: string;
	/** Nothing to watch: no health check, no Prometheus metric. */
	notConfigured: boolean;
	autoRollback: boolean;
	/** The last sample's metrics and health check. */
	lastMetrics: DeployMetricCheck[];
	healthOk: boolean | null;
	samples: number;
	problems: string[];
	plan?: DeployRollbackPlan;
	/** Migration files between the good commit and this one; null: unknown. */
	migrations?: string[] | null;
	rollback?: DeployRollbackState;
	rollbackByPerson: boolean;
	revertPr?: DeployRevertPr;
	incident?: DeployIncident;
}
