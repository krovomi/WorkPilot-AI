import type React from "react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { NotebookMonth } from "../../../shared/types/notebook-agent";
import { Section } from "../charter";

interface NotebookMetricsProps {
	readonly projectPath: string | undefined;
}

/**
 * Month by month: notebooks read, dependency findings, runs and their mean
 * score, functions extracted. Mounted again after each scan (its `key`), so the figures are read again.
 */
export function NotebookMetrics({ projectPath }: NotebookMetricsProps): React.ReactElement | null {
	const { t } = useTranslation("notebookAgent");
	const [months, setMonths] = useState<NotebookMonth[]>([]);

	useEffect(() => {
		if (!projectPath) {
			setMonths([]);
			return;
		}
		let alive = true;
		globalThis.electronAPI
			.getNotebookMetrics({ projectPath })
			.then((rows) => {
				if (alive) setMonths(Array.isArray(rows) ? rows : []);
			})
			.catch(() => {
				if (alive) setMonths([]);
			});
		return () => {
			alive = false;
		};
	}, [projectPath]);

	if (months.length === 0) return null;
	return (
		<Section kicker={t("metrics.kicker")} title={t("metrics.title")}>
			<table className="w-full text-xs">
				<thead>
					<tr className="wp-kicker text-left">
						<th className="py-1 pr-3 font-normal">{t("metrics.month")}</th>
						<th className="py-1 pr-3 font-normal">{t("metrics.notebooks")}</th>
						<th className="py-1 pr-3 font-normal">{t("metrics.findings")}</th>
						<th className="py-1 pr-3 font-normal">{t("metrics.runs")}</th>
						<th className="py-1 pr-3 font-normal">{t("metrics.score")}</th>
						<th className="py-1 font-normal">{t("metrics.extracted")}</th>
					</tr>
				</thead>
				<tbody>
					{months.map((month) => (
						<tr key={month.month} className="border-t border-border/40">
							<td className="py-1 pr-3 font-mono">{month.month}</td>
							<td className="py-1 pr-3">{month.notebooks}</td>
							<td className="py-1 pr-3">{month.findings}</td>
							<td className="py-1 pr-3">{month.runs}</td>
							<td className="py-1 pr-3">
								{month.meanScore === null ? "—" : t("metrics.percent", { value: month.meanScore })}
							</td>
							<td className="py-1">{month.extracted}</td>
						</tr>
					))}
				</tbody>
			</table>
		</Section>
	);
}
