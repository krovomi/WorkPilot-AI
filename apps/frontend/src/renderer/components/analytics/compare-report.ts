/**
 * The team report of "How you compare": the comparison worded in the app's
 * language, as titled tables, for the main process to print to a PDF
 * (`main/build-compare-report.ts`, which reads it again as plain strings).
 *
 * It holds what the view shows and nothing more: on a server, medians and
 * project counts only; on this computer, the person's own projects by name.
 */

import {
	type BuildComparison,
	COMPARE_GROUPS,
	COMPARE_METRICS,
	type CompareReportDocument,
} from "@shared/types/build-compare";
import type { TFunction } from "i18next";
import { formatMetric, formatTrend, METRIC_KEYS } from "./compare-format";
import { moveSentences, paceLines, paceSentence } from "./compare-pace";

export function compareReport(
	comparison: BuildComparison,
	t: TFunction,
	server: boolean,
	generated: string,
): CompareReportDocument {
	const metric = (key: string) => t(`analytics:compare.metrics.${key}`);
	const label = (kind: string) => t(`tasks:kind.values.${kind}`, { defaultValue: kind });
	const { segment } = comparison;
	const summary = [
		t("analytics:compare.report.generated", { date: generated }),
		t("analytics:compare.report.segment", {
			stack: segment.stack === "other" ? t("analytics:compare.otherStack") : segment.stack,
			size: t(`analytics:compare.sizes.${segment.size}`, { defaultValue: segment.size }),
			team: t(`analytics:compare.teams.${segment.team}`, { defaultValue: segment.team }),
		}),
		t("analytics:compare.window", {
			days: comparison.window_days,
			count: comparison.recent.specs,
			previous: comparison.previous.specs,
		}),
		server
			? t("analytics:compare.privacyServer", { count: comparison.min_group })
			: t("analytics:compare.privacyLocal"),
		...moveSentences(comparison, t),
		t("analytics:compare.lowerIsBetter"),
		t("analytics:compare.qualitySources"),
		...paceLines(comparison).map((line) => paceSentence(line, t)),
	];
	const groupColumns = COMPARE_GROUPS.map(
		(group) =>
			`${t(`analytics:compare.groups.${group}`)} (${t("analytics:compare.projectCount", {
				count: comparison.groups[group].projects,
			})})`,
	);
	const tables: CompareReportDocument["tables"] = [
		{
			title: t("analytics:compare.title"),
			columns: [
				t("analytics:compare.columns.metric"),
				t("analytics:compare.columns.recent"),
				t("analytics:compare.columns.previous"),
				t("analytics:compare.columns.trend"),
				...groupColumns,
			],
			rows: COMPARE_METRICS.map((m) => [
				metric(METRIC_KEYS[m]),
				formatMetric(m, comparison.recent[m]),
				formatMetric(m, comparison.previous[m]),
				formatTrend(comparison.trend[m]),
				...COMPARE_GROUPS.map((group) => {
					const { medians, top, trend } = comparison.groups[group];
					const parts = [medians ? formatMetric(m, medians[m]) : "—"];
					if (top && top[m] !== null) parts.push(t("analytics:compare.top", { value: formatMetric(m, top[m]) }));
					if (trend && trend[m] !== null) {
						parts.push(t("analytics:compare.groupTrend", { value: formatTrend(trend[m]) }));
					}
					return parts.join(" · ");
				}),
			]),
		},
	];
	if (comparison.kinds.length > 0) {
		tables.push({
			title: t("analytics:compare.kinds.title"),
			columns: [
				t("analytics:compare.kinds.kind"),
				t("analytics:compare.columns.specs"),
				...COMPARE_METRICS.map((m) => metric(METRIC_KEYS[m])),
			],
			rows: comparison.kinds.map((line) => [
				label(line.kind),
				String(line.specs),
				...COMPARE_METRICS.map((m) => {
					const own = formatMetric(m, line[m]);
					const median = line.group.medians ? formatMetric(m, line.group.medians[m]) : "—";
					return `${own} / ${median}`;
				}),
			]),
		});
	}
	const others = comparison.projects.filter((line) => !line.current);
	if (!server && others.length > 0) {
		tables.push({
			title: t("analytics:compare.yourProjects"),
			columns: [
				t("analytics:compare.columns.project"),
				t("analytics:compare.columns.specs"),
				...COMPARE_METRICS.map((m) => metric(METRIC_KEYS[m])),
			],
			rows: others.map((line) => [
				line.name,
				String(line.specs),
				...COMPARE_METRICS.map((m) => formatMetric(m, line[m])),
			]),
		});
	}
	return { title: t("analytics:compare.report.title"), summary, tables };
}
