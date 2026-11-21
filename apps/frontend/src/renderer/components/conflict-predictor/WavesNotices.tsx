/**
 * Execution waves (#358, lot 2): what the preventive merge check found and
 * how far back fragile zones were read, the
 * run saved before a restart (resume or abandon), and the waves of a resumed
 * run while no plan is shown.
 */

import { AlertTriangle, GitMerge, History, Play, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ExecutionWavePlan, SavedWaveRun } from "../../../shared/types/conflict-waves";
import { formatAppDateTime } from "../../lib/date-format";
import { CharterButton, Notice, Panel } from "../charter";

export function MergeCheckNotices({
	plan,
	title,
}: {
	plan: ExecutionWavePlan;
	title: (id: string) => string;
}) {
	const { t } = useTranslation(["conflictPredictor"]);
	const { checked, unchecked, failed, conflicts } = plan.mergeChecks;
	const split = plan.pairs.filter((pair) => pair.mergeCheck === "conflict");
	return (
		<>
			{split.map((pair) => (
				<Notice key={`${pair.a}-${pair.b}`} tone="amber" icon={GitMerge} role="status">
					{t("conflictPredictor:waves.mergeCheck.split", {
						a: title(pair.a),
						b: title(pair.b),
						files: (pair.conflictFiles ?? []).join(", "),
					})}
				</Notice>
			))}
			{checked > 0 && (
				<p className="wp-meta">{t("conflictPredictor:waves.mergeCheck.summary", { checked, conflicts })}</p>
			)}
			{unchecked > 0 && (
				<p className="wp-meta">{t("conflictPredictor:waves.mergeCheck.unchecked", { count: unchecked })}</p>
			)}
			{failed > 0 && (
				<p className="wp-meta">{t("conflictPredictor:waves.mergeCheck.failed", { count: failed })}</p>
			)}
			{plan.fragileZones.enabled && (
				<p className="wp-meta">
					{plan.fragileZones.commits === null
						? t("conflictPredictor:waves.fragile.unavailable")
						: t("conflictPredictor:waves.fragile.summary", { commits: plan.fragileZones.commits })}
				</p>
			)}
		</>
	);
}

export function SavedRunNotice({
	run,
	ignored,
	onResume,
	onAbandon,
}: {
	run: SavedWaveRun | null;
	ignored: boolean;
	onResume: () => void;
	onAbandon: () => void;
}) {
	const { t } = useTranslation(["conflictPredictor"]);
	if (run) {
		return (
			<Notice tone="blue" icon={History} role="status">
				<div className="flex flex-wrap items-center gap-2" data-testid="saved-wave-run">
					<span className="min-w-0 flex-1">
						{t("conflictPredictor:waves.resume.title", {
							current: Math.min(run.current + 1, run.waves.length),
							total: run.waves.length,
							savedAt: formatAppDateTime(run.savedAt),
						})}
					</span>
					<CharterButton icon={Play} size="sm" onClick={onResume}>
						{t("conflictPredictor:waves.resume.resume")}
					</CharterButton>
					<CharterButton icon={Trash2} size="sm" variant="danger" onClick={onAbandon}>
						{t("conflictPredictor:waves.resume.abandon")}
					</CharterButton>
				</div>
			</Notice>
		);
	}
	if (ignored) {
		return (
			<Notice tone="muted" icon={AlertTriangle}>
				{t("conflictPredictor:waves.resume.ignored")}
			</Notice>
		);
	}
	return null;
}

/** The waves of a run resumed after a restart, before any plan is computed. */
export function RunWavesList({
	waves,
	current,
	title,
}: {
	waves: string[][];
	current: number;
	title: (id: string) => string;
}) {
	const { t } = useTranslation(["conflictPredictor"]);
	return (
		<Panel>
			<p className="wp-kicker mb-2">{t("conflictPredictor:waves.resume.waves")}</p>
			<ol className="space-y-1">
				{waves.map((wave, i) => (
					<li key={wave.join(",")} className="text-sm" data-state={i < current ? "finished" : i === current ? "current" : "pending"}>
						<span className="wp-title">{t("conflictPredictor:waves.waveLabel", { index: i + 1 })}</span>{" "}
						<span className="wp-meta">{wave.map(title).join(", ")}</span>
					</li>
				))}
			</ol>
		</Panel>
	);
}
