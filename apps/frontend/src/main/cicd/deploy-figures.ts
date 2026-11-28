/**
 * The figures of the deployment watch, computed on this machine (#366, lot 4).
 *
 * The issue asks how many rollbacks start by themselves each month, how long
 * a degraded deployment stays before its rollback starts, how many incidents
 * the rollback avoided and how often the verdict was wrong. WorkPilot sends no
 * telemetry: every figure comes from the watch states the project keeps in
 * `.workpilot/deploy_watches/`, and from what the person said of a bad verdict
 * on the page (a false alarm, or a real problem), kept beside them in
 * `reviews.json`. Nothing leaves the machine.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type {
	DeployVerdictReview,
	DeployWatch,
	DeployWatchFigures,
} from "../../shared/types/deploy-watch";
import { RUN_ID, readDeployWatch, readJsonFile } from "./deploy-watch";

const REVIEWS: readonly DeployVerdictReview[] = ["false_positive", "confirmed"];
const REVIEWS_FILE = "reviews.json";
const MAX_REVIEWS = 2000;
const MAX_REVIEWS_BYTES = 256 * 1024;
/** The newest watches read for the figures. */
export const MAX_WATCHES = 500;
const MONTHS = 6;
const WATCH_FILE = /^([0-9]{1,20})\.json$/;

export type DeployReviews = Record<string, DeployVerdictReview>;

function watchDir(projectPath: string): string {
	return path.join(projectPath, ".workpilot", "deploy_watches");
}

export function isVerdictReview(value: unknown): value is DeployVerdictReview {
	return REVIEWS.includes(value as DeployVerdictReview);
}

export function readReviews(projectPath: string): DeployReviews {
	const raw = readJsonFile(path.join(watchDir(projectPath), REVIEWS_FILE), MAX_REVIEWS_BYTES);
	const reviews: DeployReviews = {};
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return reviews;
	for (const [runId, review] of Object.entries(raw).slice(0, MAX_REVIEWS)) {
		if (RUN_ID.test(runId) && isVerdictReview(review)) reviews[runId] = review;
	}
	return reviews;
}

/** Records (or, with null, forgets) what the person said of a run's verdict. */
export function writeReview(projectPath: string, runId: string, review: DeployVerdictReview | null): void {
	const reviews = readReviews(projectPath);
	if (review) reviews[runId] = review;
	else delete reviews[runId];
	const kept = Object.fromEntries(
		Object.entries(reviews)
			.sort(([a], [b]) => Number(b) - Number(a))
			.slice(0, MAX_REVIEWS),
	);
	const dir = watchDir(projectPath);
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, REVIEWS_FILE);
	const temp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(temp, JSON.stringify(kept, null, 2), "utf-8");
	fs.renameSync(temp, file);
}

/** The project's watches, newest first, at most MAX_WATCHES. */
export function listDeployWatches(projectPath: string): DeployWatch[] {
	let names: string[];
	try {
		names = fs.readdirSync(watchDir(projectPath));
	} catch {
		return [];
	}
	return names
		.map((name) => WATCH_FILE.exec(name)?.[1])
		.filter((id): id is string => id !== undefined)
		.sort((a, b) => Number(b) - Number(a))
		.slice(0, MAX_WATCHES)
		.map((id) => readDeployWatch(projectPath, id, true))
		.filter((watch): watch is DeployWatch => watch !== undefined);
}

function median(values: number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function monthOf(value: string): string {
	const time = Date.parse(value);
	return Number.isNaN(time) ? "" : new Date(time).toISOString().slice(0, 7);
}

/** The last MONTHS months up to `now`, oldest first, as "YYYY-MM". */
function lastMonths(now: Date): string[] {
	return Array.from({ length: MONTHS }, (_, index) => {
		const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (MONTHS - 1 - index), 1));
		return date.toISOString().slice(0, 7);
	});
}

export function computeFigures(
	watches: readonly DeployWatch[],
	reviews: DeployReviews,
	now: Date = new Date(),
): DeployWatchFigures {
	const months = lastMonths(now).map((month) => ({ month, automatic: 0, person: 0, critical: 0 }));
	const byMonth = new Map(months.map((m) => [m.month, m]));
	const delays: number[] = [];
	const figures = {
		watches: 0,
		criticalVerdicts: 0,
		warningVerdicts: 0,
		automaticRollbacks: 0,
		personRollbacks: 0,
		incidentsAvoided: 0,
		falsePositiveRollbacks: 0,
		reviewedVerdicts: 0,
		falsePositives: 0,
	};
	for (const watch of watches) {
		const month = byMonth.get(monthOf(watch.startedAt));
		const review = reviews[watch.runId];
		const started = watch.rollback === "started";
		if (!watch.notConfigured && !watch.linkedOnly) figures.watches += 1;
		if (watch.verdict === "critical") {
			figures.criticalVerdicts += 1;
			if (month) month.critical += 1;
			if (started && review !== "false_positive") figures.incidentsAvoided += 1;
		}
		if (watch.verdict === "warning") figures.warningVerdicts += 1;
		if ((watch.verdict === "critical" || watch.verdict === "warning") && review) {
			figures.reviewedVerdicts += 1;
			if (review === "false_positive") figures.falsePositives += 1;
		}
		if (!started) continue;
		if (watch.rollbackByPerson) {
			figures.personRollbacks += 1;
			if (month) month.person += 1;
		} else {
			figures.automaticRollbacks += 1;
			if (month) month.automatic += 1;
		}
		if (review === "false_positive") figures.falsePositiveRollbacks += 1;
		if (watch.degradedAt && watch.rollbackAt) {
			const seconds = (Date.parse(watch.rollbackAt) - Date.parse(watch.degradedAt)) / 1000;
			if (seconds >= 0) delays.push(seconds);
		}
	}
	return {
		...figures,
		meanSecondsToRollback:
			delays.length > 0 ? Math.round(delays.reduce((a, b) => a + b, 0) / delays.length) : null,
		medianSecondsToRollback: median(delays),
		timedRollbacks: delays.length,
		months,
	};
}
