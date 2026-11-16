/**
 * @vitest-environment node
 *
 * The deployment watch state, as the main reads it back for the page (#366).
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	deployWatchPath,
	LiveDeployWatches,
	parseDeployWatch,
	readDeployWatch,
	watchConfigured,
} from "../deploy-watch";

const RUN = "1763200000000";

const STATE = {
	run_id: RUN,
	phase: "done",
	verdict: "critical",
	started_at: "2026-11-15T10:00:00+00:00",
	ends_at: "2026-11-15T10:20:00+00:00",
	auto_rollback: true,
	problems: ["offline: Prometheus skipped"],
	samples: [
		{ level: "ok", health: { ok: true }, metrics: [] },
		{
			level: "critical",
			health: { ok: false, status: 503 },
			metrics: [
				{ name: "errors", kind: "error_rate", baseline: 0.01, current: 0.05, change_pct: 400, level: "critical" },
				{ name: "odd", kind: 3, baseline: "x", current: Number.NaN, level: "nope" },
				"junk",
			],
		},
	],
	plan: {
		provider: "github",
		reason: "rerun",
		automatic: true,
		target_run: "10",
		target_sha: "a".repeat(40),
		target_url: "https://github.com/acme/shop/actions/runs/10",
		current_sha: "b".repeat(40),
	},
	migrations: ["db/migrate/1_add.rb"],
	rollback: "blocked_migrations",
	rollback_by: "person",
};

describe("watchConfigured", () => {
	it("needs a health check or Prometheus", () => {
		expect(watchConfigured({})).toBe(false);
		expect(watchConfigured({ CICD_MONITOR_HEALTH_URL: "  " })).toBe(false);
		expect(watchConfigured({ CICD_MONITOR_HEALTH_URL: "https://a/h" })).toBe(true);
		expect(watchConfigured({ CICD_MONITOR_PROMETHEUS_URL: "http://localhost:9090" })).toBe(true);
	});
});

describe("parseDeployWatch", () => {
	it("types and bounds what the runner wrote", () => {
		const watch = parseDeployWatch(STATE, false);
		expect(watch).toMatchObject({
			runId: RUN,
			phase: "done",
			verdict: "critical",
			endsAt: STATE.ends_at,
			notConfigured: false,
			autoRollback: true,
			healthOk: false,
			samples: 2,
			problems: ["offline: Prometheus skipped"],
			migrations: ["db/migrate/1_add.rb"],
			rollback: "blocked_migrations",
			rollbackByPerson: true,
		});
		expect(watch?.lastMetrics).toEqual([
			{ name: "errors", kind: "error_rate", baseline: 0.01, current: 0.05, changePct: 400, level: "critical" },
			{ name: "odd", kind: "", baseline: null, current: null, changePct: null, level: "unknown" },
			{ name: "", kind: "", baseline: null, current: null, changePct: null, level: "unknown" },
		]);
		expect(watch?.plan).toEqual({
			provider: "github",
			reason: "rerun",
			automatic: true,
			targetRun: "10",
			targetSha: "a".repeat(40),
			targetUrl: "https://github.com/acme/shop/actions/runs/10",
			currentSha: "b".repeat(40),
		});
	});

	it("refuses a link that is not https and a bad run id", () => {
		const watch = parseDeployWatch({ ...STATE, plan: { target_url: "javascript:alert(1)" } }, false);
		expect(watch?.plan?.targetUrl).toBe("");
		expect(watch?.plan?.automatic).toBe(false);
		expect(parseDeployWatch({ ...STATE, run_id: "../x" }, false)).toBeUndefined();
		expect(parseDeployWatch(null, false)).toBeUndefined();
		expect(parseDeployWatch([STATE], false)).toBeUndefined();
	});

	it("says a watch the app no longer runs was interrupted", () => {
		expect(parseDeployWatch({ ...STATE, phase: "watching" }, false)?.phase).toBe("interrupted");
		expect(parseDeployWatch({ ...STATE, phase: "watching" }, true)?.phase).toBe("watching");
		expect(parseDeployWatch({ ...STATE, phase: "bogus" }, false)?.phase).toBe("done");
	});

	it("reads a minimal state", () => {
		const watch = parseDeployWatch({ run_id: RUN, reason: "not_configured", migrations: null }, true);
		expect(watch).toMatchObject({
			notConfigured: true,
			verdict: "unknown",
			healthOk: null,
			samples: 0,
			lastMetrics: [],
			problems: [],
			migrations: null,
			rollbackByPerson: false,
		});
		expect(watch).not.toHaveProperty("plan");
		expect(watch).not.toHaveProperty("rollback");
		expect(watch).not.toHaveProperty("endsAt");
		const noMigrations = parseDeployWatch({ run_id: RUN, rollback: "rm -rf" }, true);
		expect(noMigrations).not.toHaveProperty("migrations");
		expect(noMigrations).not.toHaveProperty("rollback");
	});
});

describe("readDeployWatch", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(path.join(tmpdir(), "deploy-watch-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function write(content: string): string {
		const file = deployWatchPath(dir, RUN);
		mkdirSync(path.dirname(file), { recursive: true });
		writeFileSync(file, content, "utf-8");
		return file;
	}

	it("reads the state of a run", () => {
		write(JSON.stringify(STATE));
		expect(readDeployWatch(dir, RUN, false)?.verdict).toBe("critical");
	});

	it("reads nothing for a bad id, a missing, broken or linked file", () => {
		expect(readDeployWatch(dir, "../../etc", false)).toBeUndefined();
		expect(readDeployWatch(dir, RUN, false)).toBeUndefined();
		const file = write("{oops");
		expect(readDeployWatch(dir, RUN, false)).toBeUndefined();
		rmSync(file);
		const elsewhere = path.join(dir, "elsewhere.json");
		writeFileSync(elsewhere, JSON.stringify(STATE), "utf-8");
		symlinkSync(elsewhere, file);
		expect(readDeployWatch(dir, RUN, false)).toBeUndefined();
	});

	it("refuses a state file too large", () => {
		write(" ".repeat(2 * 1024 * 1024 + 1));
		expect(readDeployWatch(dir, RUN, false)).toBeUndefined();
	});
});

describe("LiveDeployWatches", () => {
	it("runs one watch per run, live until it settles", async () => {
		const watches = new LiveDeployWatches();
		let finish: () => void = () => undefined;
		const done = new Promise<void>((resolve) => {
			finish = resolve;
		});
		expect(watches.start("/p", RUN, () => done)).toBe(true);
		expect(watches.isLive("/p/", RUN)).toBe(true);
		expect(watches.start("/p", RUN, () => done)).toBe(false);
		expect(watches.start("/p", "x", () => done)).toBe(false);
		finish();
		await done;
		await new Promise((r) => setTimeout(r, 0));
		expect(watches.isLive("/p", RUN)).toBe(false);
	});

	it("forgets a watch that failed", async () => {
		const watches = new LiveDeployWatches();
		watches.start("/p", RUN, () => Promise.reject(new Error("boom")));
		await new Promise((r) => setTimeout(r, 0));
		expect(watches.isLive("/p", RUN)).toBe(false);
	});
});
