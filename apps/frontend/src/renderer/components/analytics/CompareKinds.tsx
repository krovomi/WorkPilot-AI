/**
 * "How you compare", kind by kind: the project's specs of each kind its
 * cards recorded (bug fix, feature, refactoring…) against the same kind in
 * the other projects, whose median shows from `min_group` projects only.
 */

import { COMPARE_METRICS, type CompareKindLine } from "@shared/types/build-compare";
import { useTranslation } from "react-i18next";
import { Panel } from "../charter";
import { formatMetric, METRIC_KEYS } from "./compare-format";

interface CompareKindsProps {
	readonly kinds: readonly CompareKindLine[];
	readonly minGroup: number;
}

export function CompareKinds({ kinds, minGroup }: CompareKindsProps) {
	const { t } = useTranslation(["analytics", "tasks"]);
	return (
		<Panel className="space-y-3" data-testid="compare-kinds">
			<h3 className="wp-title text-sm">{t("analytics:compare.kinds.title")}</h3>
			{kinds.length === 0 ? (
				<p className="wp-muted text-xs">{t("analytics:compare.kinds.none")}</p>
			) : (
				<div className="overflow-x-auto">
					<table className="w-full text-xs">
						<thead>
							<tr className="wp-muted text-left">
								<th className="py-1 pr-3 font-medium">{t("analytics:compare.kinds.kind")}</th>
								<th className="py-1 pr-3 font-medium">{t("analytics:compare.columns.specs")}</th>
								<th className="py-1 pr-3 font-medium">{t("analytics:compare.kinds.others")}</th>
								{COMPARE_METRICS.map((metric) => (
									<th key={metric} className="py-1 pr-3 font-medium">
										{t(`analytics:compare.metrics.${METRIC_KEYS[metric]}`)}
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{kinds.map((line) => (
								<tr key={line.kind} className="border-t border-border/50">
									<td className="py-1.5 pr-3 font-medium">
										{t(`tasks:kind.values.${line.kind}`, { defaultValue: line.kind })}
									</td>
									<td className="py-1.5 pr-3 font-mono">{line.specs}</td>
									<td className="wp-muted py-1.5 pr-3">
										{t("analytics:compare.projectCount", { count: line.group.projects })}
									</td>
									{COMPARE_METRICS.map((metric) => (
										<td key={metric} className="py-1.5 pr-3 font-mono">
											<span className="font-semibold">{formatMetric(metric, line[metric])}</span>
											<span className="wp-meta block">
												{line.group.medians ? formatMetric(metric, line.group.medians[metric]) : "—"}
											</span>
										</td>
									))}
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
			<p className="wp-meta">{t("analytics:compare.kinds.note", { count: minGroup })}</p>
		</Panel>
	);
}
