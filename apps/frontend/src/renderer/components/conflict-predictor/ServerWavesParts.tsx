/**
 * The parts of a server project's waves view (#358): the run going on, the
 * plan and the figures of the last days, as the server answered them. What
 * they show is counted or measured by the server; nothing is estimated.
 */

import { AlertTriangle, BarChart3, GitMerge } from "lucide-react";
import { useTranslation } from "react-i18next";
import type {
	ServerWaveHistory,
	ServerWavePlan,
	ServerWaveRunAnswer,
	ServerWaveRun,
} from "../../../shared/types/server-conflict-waves";
import { formatAppDateTime } from "../../lib/date-format";
import { Notice, Panel, Stat, Stats } from "../charter";
import { formatPhaseDuration } from "../task-detail/TaskPhaseProgressBar";

/** The run going on: each wave, each card's column on the server's board, or why it waits. */
export function ServerRunPanel({ answer }: { answer: ServerWaveRunAnswer & { run: ServerWaveRun } }) {
	const { t } = useTranslation(["conflictPredictor", "tasks"]);
	const { run } = answer;
	const cards = new Map(answer.cards.map((card) => [card.id, card]));
	const blocked = new Set(answer.blocked);
	const note = (id: string): string => {
		const failure = run.failures[id];
		if (failure) return t(`conflictPredictor:waves.server.failure.${failure}`);
		if (blocked.has(id)) return t("conflictPredictor:waves.server.blocked");
		const column = cards.get(id)?.column;
		return column ? t(`tasks:columns.${column}`) : t("conflictPredictor:waves.server.gone");
	};
	return (
		<Panel data-testid="server-wave-run">
			<div className="mb-2 flex flex-wrap items-baseline gap-2">
				<span className="wp-title text-sm">
					{t("conflictPredictor:waves.server.running", {
						wave: Math.min(run.current + 1, run.waves.length),
						total: run.waves.length,
					})}
				</span>
				<span className="wp-meta">{t(`conflictPredictor:waves.server.advance.${run.advanceWhen}`)}</span>
			</div>
			<ol className="space-y-2">
				{run.waves.map((wave, index) => (
					<li
						key={wave.join(",")}
						data-state={index < run.current ? "finished" : index === run.current ? "current" : "pending"}
					>
						<p className="wp-title text-sm">{t("conflictPredictor:waves.waveLabel", { index: index + 1 })}</p>
						<ul className="space-y-0.5">
							{wave.map((id) => {
								const card = cards.get(id);
								return (
									<li
										key={id}
										className={run.failures[id] ? "text-sm text-destructive" : "text-sm"}
									>
										<span>{card?.title ?? id}</span>
										<span className="wp-meta">
											{" · "}
											{note(id)}
											{card?.running && ` · ${t("conflictPredictor:waves.server.agentRunning")}`}
										</span>
									</li>
								);
							})}
						</ul>
					</li>
				))}
			</ol>
		</Panel>
	);
}

/** The waves of the backlog, as the server plans them now. */
export function ServerPlanPanel({ plan }: { plan: ServerWavePlan }) {
	const { t } = useTranslation(["conflictPredictor"]);
	const titles = new Map(plan.tasks.map((task) => [task.taskId, task.title]));
	const title = (id: string) => titles.get(id) ?? id;
	const avoided = Math.max(0, Math.round((plan.totalRisk - plan.residualRisk) * 100) / 100);
	return (
		<div className="space-y-3" data-testid="server-wave-plan">
			<p className="wp-kicker">
				{t("conflictPredictor:waves.server.plan", { count: plan.waves.length, parallel: plan.maxParallel })}
			</p>
			{plan.waves.length > 0 && (
				<Stats>
					<Stat label={t("conflictPredictor:waves.stats.waves")} value={String(plan.waves.length)} tone="violet" />
					<Stat label={t("conflictPredictor:waves.stats.parallel")} value={String(plan.maxParallel)} tone="orange" />
					<Stat
						label={t("conflictPredictor:waves.stats.avoided")}
						value={t("conflictPredictor:waves.stats.avoidedValue", { avoided, total: plan.totalRisk })}
						tone="green"
					/>
				</Stats>
			)}
			{plan.mergeChecks.checked > 0 && (
				<p className="wp-meta">
					{t("conflictPredictor:waves.server.mergeChecks", {
						checked: plan.mergeChecks.checked,
						conflicts: plan.mergeChecks.conflicts,
					})}
				</p>
			)}
			{plan.cycles > 0 && (
				<Notice tone="red" icon={AlertTriangle} role="alert">
					<p>{t("conflictPredictor:waves.server.cycles")}</p>
					<ul>
						{plan.excluded.map((excluded) => (
							<li key={excluded.taskId}>
								{title(excluded.taskId)}
								{" · "}
								{t(`conflictPredictor:waves.server.excluded.${excluded.reason}`)}
							</li>
						))}
					</ul>
				</Notice>
			)}
			{plan.waves.length > 0 && (
				<div className="grid gap-2.5 md:grid-cols-2 xl:grid-cols-3">
					{plan.waves.map((wave) => (
						<Panel key={wave.index} rail tone="violet" data-testid={`server-wave-${wave.index}`}>
							<p className="wp-title mb-2 text-sm">{t("conflictPredictor:waves.waveLabel", { index: wave.index })}</p>
							<ol className="space-y-1">
								{wave.taskIds.map((id) => (
									<li key={id} className="flex items-center gap-2 text-sm">
										<GitMerge className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
										<span className="min-w-0 truncate">{title(id)}</span>
									</li>
								))}
							</ol>
						</Panel>
					))}
				</div>
			)}
		</div>
	);
}

/** The run history and the merge conflict times of the server's window, as it counted them. */
export function ServerHistoryPanel({ history }: { history: ServerWaveHistory }) {
	const { t, i18n } = useTranslation(["conflictPredictor"]);
	const { summary, conflicts } = history;
	return (
		<Notice tone="muted" icon={BarChart3} role="status">
			<div className="space-y-1" data-testid="server-wave-history">
				<p className="wp-title text-sm">{t("conflictPredictor:waves.server.history", { days: summary.days })}</p>
				{history.ignored && <p>{t("conflictPredictor:waves.server.historyIgnored")}</p>}
				<p>
					{t("conflictPredictor:waves.server.historyLine", {
						runs: summary.runs,
						stopped: summary.stopped,
						conflicts: summary.conflictsAvoided,
						risk: summary.riskAvoided,
						started: summary.started,
					})}
				</p>
				{conflicts.ignored ? (
					<p>{t("conflictPredictor:waves.server.conflictsIgnored")}</p>
				) : (
					(conflicts.resolved > 0 || conflicts.open > 0) && (
						<p data-testid="server-wave-conflicts">
							{conflicts.medianSeconds === null
								? t("conflictPredictor:waves.server.conflictsNone", { open: conflicts.open })
								: t("conflictPredictor:waves.server.conflictsLine", {
										resolved: conflicts.resolved,
										median: formatPhaseDuration(conflicts.medianSeconds * 1000, i18n.language),
										open: conflicts.open,
									})}
						</p>
					)
				)}
				{summary.lastFinishedAt && (
					<p>{t("conflictPredictor:waves.server.lastRun", { at: formatAppDateTime(summary.lastFinishedAt) })}</p>
				)}
			</div>
		</Notice>
	);
}
