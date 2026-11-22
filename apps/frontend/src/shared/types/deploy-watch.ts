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
	/** Canary analysis: `baseline` is the stable fleet now, `current` the canary. */
	canary: boolean;
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
	/** When the target run was created (ISO 8601); "" when unknown. */
	targetAt: string;
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

/** Where the alert of a bad verdict went (`CICD_ALERT_*` settings). */
export type DeployAlertChannel = "slack" | "pagerduty" | "email";

/** sent; failed to send; settings refused; not sent under strict offline mode. */
export type DeployAlertStatus = "sent" | "failed" | "invalid" | "offline";

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
	/** Rolled back with another project the person linked to this one: its name. */
	linkedCause: string;
	/** This run was not watched; it went back with a linked project. */
	linkedOnly: boolean;
	/** Where the critical samples that ended the window began (ISO 8601). */
	degradedAt?: string;
	/** When the rollback started (ISO 8601). */
	rollbackAt?: string;
	/** The linked projects this run's rollback took back with it. */
	linked?: DeployLinkedRollback[];
	/** What the person said of a bad verdict, afterwards. */
	review?: DeployVerdictReview;
	revertPr?: DeployRevertPr;
	incident?: DeployIncident;
	/** The configured alert channels and what became of each. */
	alerts?: Partial<Record<DeployAlertChannel, DeployAlertStatus>>;
}

/**
 * What became of a linked project when the run it is linked to rolled back
 * (#366, lot 4): `not_deployed_since` when it has not changed since the good
 * run, `missing` when the project is no longer in the app, `error` when its
 * runner did not answer.
 */
export type DeployLinkedStatus =
	| "started"
	| "failed"
	| "blocked_migrations"
	| "manual"
	| "not_deployed_since"
	| "missing"
	| "error";

export interface DeployLinkedRollback {
	projectId: string;
	name: string;
	status: DeployLinkedStatus;
	runId: string;
	/** The last good run of that project, https only; "" when none. */
	targetUrl: string;
	migrations: string[];
}

export interface DeployProjectRef {
	id: string;
	name: string;
}

/** The projects rolled back with this one, and those that could be. */
export interface DeployLinksView {
	linked: DeployProjectRef[];
	candidates: DeployProjectRef[];
}

/** A person's word on a bad verdict: it was a false alarm, or a real problem. */
export type DeployVerdictReview = "false_positive" | "confirmed";

/**
 * The figures of a project's watches, computed on this machine from the
 * watch states it keeps; nothing is sent anywhere.
 */
export interface DeployWatchFigures {
	watches: number;
	criticalVerdicts: number;
	warningVerdicts: number;
	/** Rollbacks started without a person: by the watch, or with a linked project. */
	automaticRollbacks: number;
	personRollbacks: number;
	/** Critical verdicts whose rollback started and no one called a false alarm. */
	incidentsAvoided: number;
	/** Seconds from the degradation to the rollback, over the rollbacks that have both. */
	meanSecondsToRollback: number | null;
	medianSecondsToRollback: number | null;
	timedRollbacks: number;
	/** Of the rollbacks that started, those a person called a false alarm. */
	falsePositiveRollbacks: number;
	reviewedVerdicts: number;
	falsePositives: number;
	/** The last six months, oldest first: "YYYY-MM" and its rollbacks. */
	months: { month: string; automatic: number; person: number; critical: number }[];
}
