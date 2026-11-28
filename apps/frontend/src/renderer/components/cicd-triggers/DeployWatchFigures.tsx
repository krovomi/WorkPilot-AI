/**
 * The figures of the deployment watch (#366, lot 4): rollbacks started by
 * themselves or by a person, the time from a degraded deployment to its
 * rollback (the issue aims under three minutes), the incidents the rollback
 * avoided, and the false alarms people pointed out. Computed by the main from
 * this project's watches; nothing is sent anywhere.
 */

import type React from "react";
import { useTranslation } from "react-i18next";
import type { DeployWatchFigures as Figures } from "../../../shared/types/deploy-watch";
import { formatAppMonth } from "../../lib/date-format";

/** The goal of the issue: a rollback within three minutes of the degradation. */
export const TARGET_SECONDS = 180;

export function formatDuration(seconds: number | null): string {
	if (seconds === null) return "—";
	const minutes = Math.floor(seconds / 60);
	const rest = Math.round(seconds % 60);
	return minutes > 0 ? `${minutes} min ${String(rest).padStart(2, "0")} s` : `${rest} s`;
}

export function DeployWatchFigures({ figures }: { readonly figures: Figures }): React.ReactElement {
	const { t } = useTranslation(["cicdTriggers"]);
	const rate =
		figures.reviewedVerdicts > 0 ? Math.round((100 * figures.falsePositives) / figures.reviewedVerdicts) : null;
	const rows: [string, string][] = [
		["watches", String(figures.watches)],
		["verdicts", t("cicdTriggers:figures.verdictsValue", {
			critical: figures.criticalVerdicts,
			warning: figures.warningVerdicts,
		})],
		["rollbacks", t("cicdTriggers:figures.rollbacksValue", {
			automatic: figures.automaticRollbacks,
			person: figures.personRollbacks,
		})],
		["incidentsAvoided", String(figures.incidentsAvoided)],
		["timeToRollback", t("cicdTriggers:figures.timeValue", {
			mean: formatDuration(figures.meanSecondsToRollback),
			median: formatDuration(figures.medianSecondsToRollback),
			count: figures.timedRollbacks,
		})],
		["falseAlarms", rate === null
			? t("cicdTriggers:figures.noReview")
			: t("cicdTriggers:figures.falseAlarmsValue", {
					rate,
					count: figures.falsePositives,
					reviewed: figures.reviewedVerdicts,
					rollbacks: figures.falsePositiveRollbacks,
				})],
	];
	const slow =
		figures.medianSecondsToRollback !== null && figures.medianSecondsToRollback > TARGET_SECONDS;
	return (
		<div className="space-y-1.5 text-xs" data-testid="deploy-figures">
			<div className="wp-kicker">{t("cicdTriggers:figures.heading")}</div>
			<dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
				{rows.map(([key, value]) => (
					<div key={key} className="contents">
						<dt className="wp-meta">{t(`cicdTriggers:figures.${key}`)}</dt>
						<dd>{value}</dd>
					</div>
				))}
			</dl>
			{slow && <p className="text-warning">{t("cicdTriggers:figures.slow")}</p>}
			<table className="w-full text-left" data-testid="deploy-figures-months">
				<thead>
					<tr className="wp-meta">
						<th className="font-normal">{t("cicdTriggers:figures.month")}</th>
						<th className="font-normal">{t("cicdTriggers:figures.automatic")}</th>
						<th className="font-normal">{t("cicdTriggers:figures.person")}</th>
						<th className="font-normal">{t("cicdTriggers:figures.critical")}</th>
					</tr>
				</thead>
				<tbody>
					{figures.months.map((m) => (
						<tr key={m.month}>
							<td className="font-mono">{formatAppMonth(m.month, "short")}</td>
							<td>{m.automatic}</td>
							<td>{m.person}</td>
							<td>{m.critical}</td>
						</tr>
					))}
				</tbody>
			</table>
			<p className="wp-meta">{t("cicdTriggers:figures.local")}</p>
		</div>
	);
}
