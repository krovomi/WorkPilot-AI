/**
 * The watch after a deployment (#366), on the main side.
 *
 * A pipeline triggered from CI/CD Triggers, by hand or after an agent's PR,
 * starts `runners/deploy_watch_runner.py --action watch` when the project's
 * CI/CD settings name something to watch (a health check URL, Prometheus).
 * The runner writes its state to `.workpilot/deploy_watches/<run id>.json`;
 * this module reads that file back, bounded and typed, for the page. A watch
 * the app no longer runs (the app was closed) shows as interrupted.
 *
 * The renderer only names a run id: the runner reads the run, the endpoints
 * and the tokens itself.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type {
	DeployAlertChannel,
	DeployAlertStatus,
	DeployIncident,
	DeployMetricCheck,
	DeployRevertPr,
	DeployRevertStatus,
	DeployRollbackFlag,
	DeployRollbackPlan,
	DeployRollbackState,
	DeployWatch,
	DeployWatchLevel,
	DeployWatchPhase,
} from "../../shared/types/deploy-watch";

export const DEPLOY_WATCH_RUNNER = "deploy_watch_runner.py";
export const RUN_ID = /^[0-9]{1,20}$/;
const MAX_STATE_BYTES = 2 * 1024 * 1024;
const MAX_TEXT = 300;
const MAX_LIST = 50;
const MAX_EXPLANATION = 1200;

const LEVELS: readonly DeployWatchLevel[] = ["ok", "warning", "critical", "unknown"];
const PHASES: readonly DeployWatchPhase[] = ["baseline", "waiting", "watching", "done"];
const ROLLBACKS: readonly DeployRollbackState[] = [
	"proposed",
	"started",
	"failed",
	"blocked_migrations",
	"manual",
];

const REVERTS: readonly DeployRevertStatus[] = [
	"opened",
	"exists",
	"failed",
	"conflict",
	"no_commit",
	"unknown_commit",
	"not_on_branch",
	"offline",
	"unavailable",
];

export { watchConfigured } from "./watch-settings";

function text(value: unknown, limit = MAX_TEXT): string {
	return typeof value === "string" ? value.slice(0, limit) : "";
}

function num(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
	return allowed.includes(value as T) ? (value as T) : fallback;
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function metric(raw: unknown): DeployMetricCheck {
	const m = record(raw);
	return {
		name: text(m.name, 60),
		kind: text(m.kind, 30),
		baseline: num(m.baseline),
		current: num(m.current),
		changePct: num(m.change_pct),
		level: oneOf(m.level, LEVELS, "unknown"),
		canary: m.against === "stable",
	};
}

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

/** An ISO 8601 moment with its offset, as the runner writes them; "" otherwise. */
export function isoTime(value: unknown): string {
	return typeof value === "string" && ISO_TIME.test(value) && !Number.isNaN(Date.parse(value))
		? value
		: "";
}

function plan(raw: unknown): DeployRollbackPlan | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const p = record(raw);
	const url = text(p.target_url, 500);
	return {
		provider: text(p.provider, 30),
		reason: text(p.reason, 40),
		automatic: p.automatic === true,
		targetRun: text(p.target_run, 40),
		targetSha: text(p.target_sha, 40),
		targetUrl: url.startsWith("https://") ? url : "",
		currentSha: text(p.current_sha, 40),
		targetAt: isoTime(p.target_at),
	};
}

function https(value: unknown): string {
	const url = text(value, 500);
	return url.startsWith("https://") && !/\s/.test(url) ? url : "";
}

function count(value: unknown): number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function revertPr(raw: unknown): DeployRevertPr | undefined {
	const r = record(raw);
	if (!REVERTS.includes(r.status as DeployRevertStatus)) return undefined;
	return { status: r.status as DeployRevertStatus, url: https(r.url), sha: text(r.sha, 40) };
}

function incident(raw: unknown): DeployIncident | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const i = record(raw);
	const summary = record(i.summary);
	const health = record(summary.health);
	return {
		criticalSamples: count(summary.critical_samples),
		warningSamples: count(summary.warning_samples),
		healthChecks: count(health.checks),
		healthFailed: count(health.failed),
		metrics: (Array.isArray(summary.metrics) ? summary.metrics : []).slice(0, MAX_LIST).map((entry) => {
			const m = record(entry);
			return {
				name: text(m.name, 60),
				baseline: num(m.baseline),
				worst: num(m.worst),
				worstChangePct: num(m.worst_change_pct),
				level: oneOf(m.level, LEVELS, "unknown"),
			};
		}),
		explanation: text(i.explanation, MAX_EXPLANATION),
	};
}

const ALERT_CHANNELS: readonly DeployAlertChannel[] = ["slack", "pagerduty", "email"];
const ALERT_STATUSES: readonly DeployAlertStatus[] = ["sent", "failed", "invalid", "offline"];

const FLAG_STATUSES: readonly DeployRollbackFlag["status"][] = ["done", "failed", "offline"];

function rollbackFlag(raw: unknown): DeployRollbackFlag | undefined {
	const f = record(raw);
	if (!FLAG_STATUSES.includes(f.status as DeployRollbackFlag["status"])) return undefined;
	return {
		provider: text(f.provider, 30),
		key: text(f.key, 200),
		status: f.status as DeployRollbackFlag["status"],
	};
}

function alerts(raw: unknown): DeployWatch["alerts"] {
	const r = record(raw);
	const known = ALERT_CHANNELS.filter((c) => ALERT_STATUSES.includes(r[c] as DeployAlertStatus));
	if (known.length === 0) return undefined;
	return Object.fromEntries(known.map((c) => [c, r[c] as DeployAlertStatus]));
}

/** The state the runner wrote, typed and bounded. */
export function parseDeployWatch(raw: unknown, live: boolean): DeployWatch | undefined {
	const s = record(raw);
	const runId = text(s.run_id, 20);
	if (!RUN_ID.test(runId)) return undefined;
	const samples = Array.isArray(s.samples) ? s.samples : [];
	const last = record(samples.at(-1));
	const health = record(last.health);
	const phase = oneOf(s.phase, PHASES, "done");
	const migrations = Array.isArray(s.migrations)
		? s.migrations.slice(0, MAX_LIST).map((m) => text(m))
		: s.migrations === null
			? null
			: undefined;
	return {
		runId,
		phase: phase !== "done" && !live ? "interrupted" : phase,
		verdict: oneOf(s.verdict, LEVELS, "unknown"),
		startedAt: text(s.started_at, 40),
		...(typeof s.ends_at === "string" ? { endsAt: text(s.ends_at, 40) } : {}),
		notConfigured: s.reason === "not_configured",
		autoRollback: s.auto_rollback === true,
		lastMetrics: (Array.isArray(last.metrics) ? last.metrics : []).slice(0, MAX_LIST).map(metric),
		healthOk: typeof health.ok === "boolean" ? health.ok : null,
		samples: samples.length,
		problems: (Array.isArray(s.problems) ? s.problems : []).slice(0, MAX_LIST).map((p) => text(p)),
		...(plan(s.plan) ? { plan: plan(s.plan) } : {}),
		...(migrations !== undefined ? { migrations } : {}),
		...(ROLLBACKS.includes(s.rollback as DeployRollbackState)
			? { rollback: s.rollback as DeployRollbackState }
			: {}),
		rollbackByPerson: s.rollback_by === "person",
		linkedCause: s.rollback_by === "linked" ? text(s.linked_cause, 100) : "",
		linkedOnly: s.reason === "linked_rollback",
		flagConfigured: s.flag_configured === true,
		...(s.strategy === "flag" || s.strategy === "deployment" ? { strategy: s.strategy } : {}),
		...(rollbackFlag(s.flag) ? { flag: rollbackFlag(s.flag) } : {}),
		...(isoTime(s.degraded_at) ? { degradedAt: isoTime(s.degraded_at) } : {}),
		...(isoTime(s.rollback_at) ? { rollbackAt: isoTime(s.rollback_at) } : {}),
		...(revertPr(s.revert_pr) ? { revertPr: revertPr(s.revert_pr) } : {}),
		...(incident(s.incident) ? { incident: incident(s.incident) } : {}),
		...(alerts(s.alerts) ? { alerts: alerts(s.alerts) } : {}),
	};
}

const ALERT_WORDS = {
	en: {
		critical: (project: string) => `Deployment critical: ${project}`,
		warning: (project: string) => `Deployment degraded: ${project}`,
		criticalBody: (run: string) => `Run ${run}: two critical samples in a row after the deployment.`,
		warningBody: (run: string) => `Run ${run}: the metrics got worse during the watch window.`,
		rollback: {
			proposed: "A rollback is proposed on the CI/CD page.",
			started: "The rollback started.",
			failed: "The rollback could not start.",
			blocked_migrations: "Automatic rollback blocked by a database migration.",
			manual: "Roll back by hand.",
		} satisfies Record<DeployRollbackState, string>,
		revertOpened: (url: string) => `Revert PR: ${url}`,
		revertMissed: "The revert PR could not be opened.",
	},
	fr: {
		critical: (project: string) => `Déploiement critique : ${project}`,
		warning: (project: string) => `Déploiement dégradé : ${project}`,
		criticalBody: (run: string) => `Exécution ${run} : deux mesures critiques d'affilée après le déploiement.`,
		warningBody: (run: string) => `Exécution ${run} : les métriques se sont dégradées pendant la fenêtre de surveillance.`,
		rollback: {
			proposed: "Un rollback est proposé sur la page CI/CD.",
			started: "Le rollback a démarré.",
			failed: "Le rollback n'a pas pu démarrer.",
			blocked_migrations: "Rollback automatique bloqué par une migration de base de données.",
			manual: "Rollback à faire à la main.",
		} satisfies Record<DeployRollbackState, string>,
		revertOpened: (url: string) => `PR de revert : ${url}`,
		revertMissed: "La PR de revert n'a pas pu être ouverte.",
	},
};

/**
 * The notification of a watch that ended on a warning or critical verdict,
 * in the app's language; null for any other watch. Facts of the state only:
 * no model text goes to a notification channel.
 */
export function deployAlertText(
	language: string,
	project: string,
	watch: DeployWatch | undefined,
): { title: string; body: string } | null {
	if (watch?.phase !== "done") return null;
	if (watch.verdict !== "warning" && watch.verdict !== "critical") return null;
	const words = language === "fr" ? ALERT_WORDS.fr : ALERT_WORDS.en;
	const critical = watch.verdict === "critical";
	const lines = [critical ? words.criticalBody(watch.runId) : words.warningBody(watch.runId)];
	if (watch.rollback) lines.push(words.rollback[watch.rollback]);
	if (watch.revertPr) {
		const opened = watch.revertPr.status === "opened" || watch.revertPr.status === "exists";
		if (opened && watch.revertPr.url) lines.push(words.revertOpened(watch.revertPr.url));
		else if (!opened) lines.push(words.revertMissed);
	}
	return {
		title: critical ? words.critical(project) : words.warning(project),
		body: lines.join(" "),
	};
}

export function deployWatchPath(projectPath: string, runId: string): string {
	return path.join(projectPath, ".workpilot", "deploy_watches", `${runId}.json`);
}

/** The watch of a run, if one was started; never throws. */
export function readDeployWatch(
	projectPath: string,
	runId: string,
	live: boolean,
): DeployWatch | undefined {
	if (!RUN_ID.test(runId)) return undefined;
	const raw = readJsonFile(deployWatchPath(projectPath, runId), MAX_STATE_BYTES);
	return raw === undefined ? undefined : parseDeployWatch(raw, live);
}

/**
 * The JSON of a regular file of at most `maxBytes`, or undefined: a link, a
 * larger file or bad JSON is not read. Never throws.
 */
export function readJsonFile(file: string, maxBytes: number): unknown {
	let fd: number | undefined;
	try {
		// One descriptor, opened without following a link: the file checked
		// is the file read, and only up to the size measured.
		fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
		const stat = fs.fstatSync(fd);
		const named = fs.lstatSync(file);
		if (
			!stat.isFile() ||
			!named.isFile() ||
			named.ino !== stat.ino ||
			named.dev !== stat.dev ||
			stat.size > maxBytes
		) {
			return undefined;
		}
		const buffer = Buffer.alloc(stat.size);
		const read = fs.readSync(fd, buffer, 0, stat.size, 0);
		return JSON.parse(buffer.toString("utf-8", 0, read)) as unknown;
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}

/** The watches this app is running, by project and run. */
export class LiveDeployWatches {
	private readonly live = new Set<string>();

	private key(projectPath: string, runId: string): string {
		return `${path.resolve(projectPath)}\n${runId}`;
	}

	isLive(projectPath: string, runId: string): boolean {
		return this.live.has(this.key(projectPath, runId));
	}

	/** Runs `watch` once per run; the run is live until it settles. */
	start(projectPath: string, runId: string, watch: () => Promise<unknown>): boolean {
		if (!RUN_ID.test(runId)) return false;
		const key = this.key(projectPath, runId);
		if (this.live.has(key)) return false;
		this.live.add(key);
		void watch()
			.catch(() => undefined)
			.finally(() => this.live.delete(key));
		return true;
	}
}
