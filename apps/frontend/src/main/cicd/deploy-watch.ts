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
	DeployMetricCheck,
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

const LEVELS: readonly DeployWatchLevel[] = ["ok", "warning", "critical", "unknown"];
const PHASES: readonly DeployWatchPhase[] = ["baseline", "waiting", "watching", "done"];
const ROLLBACKS: readonly DeployRollbackState[] = [
	"proposed",
	"started",
	"failed",
	"blocked_migrations",
	"manual",
];

/** The CI/CD settings name something to watch after a deployment. */
export function watchConfigured(config: Record<string, string>): boolean {
	return Boolean(
		(config.CICD_MONITOR_HEALTH_URL ?? "").trim() ||
			(config.CICD_MONITOR_PROMETHEUS_URL ?? "").trim(),
	);
}

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
	};
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
	};
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
	const file = deployWatchPath(projectPath, runId);
	try {
		const stat = fs.lstatSync(file);
		if (!stat.isFile() || stat.size > MAX_STATE_BYTES) return undefined;
		return parseDeployWatch(JSON.parse(fs.readFileSync(file, "utf-8")), live);
	} catch {
		return undefined;
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
