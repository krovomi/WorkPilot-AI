/**
 * "How you compare" in Build Analytics: the project's specs over the last
 * thirty days against the thirty before, and against other projects of its
 * stack and size. On this computer the other projects are the person's own,
 * listed by name; on a server they are the organization's projects the
 * person may read, as medians only, from groups of `min_group` projects.
 *
 * Every figure is per spec: minutes, USD, QA iterations, agents (lower is
 * better), mutation score and first-run CI pass rate (higher is better).
 * Nothing is sent anywhere (`main/build-compare.ts`). Groups are the same
 * stack and size, the same stack, the same team size, and all; each gives
 * its top tenth once it is large enough (`min_top`) and its trend, which
 * the project's own trend is read against (`compare-pace`). A project that
 * changed segment is compared with both while it moves. The project's own
 * last weeks draw a sparkline, its kinds of work have a table of their own
 * (`CompareKinds`), and "Generate team report" prints all of it to a PDF.
 */

import { AlertTriangle, ArrowRightLeft, FileDown, Gauge, RefreshCw, Scale, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	type BuildComparison,
	COMPARE_GROUPS,
	COMPARE_METRICS,
	type CompareGroup,
	type CompareMetric,
} from "@shared/types/build-compare";
import { formatAppDate } from "../../lib/date-format";
import { loadBuildComparison } from "../../lib/workspace-data";
import { CharterButton, Chip, Chips, EmptyStage, Notice, Panel, ScanLine } from "../charter";
import { CompareKinds } from "./CompareKinds";
import { CompareSparkline } from "./CompareSparkline";
import { formatMetric, formatTrend, METRIC_KEYS, trendTone } from "./compare-format";
import { moveSentences, paceLines, paceSentence } from "./compare-pace";
import { compareReport } from "./compare-report";

interface HowYouCompareProps {
	readonly projectPath: string;
	readonly serverProjectId?: string;
}

/** What the last "Generate team report" did: saved where, or why it failed. */
type ReportState = { saved: string } | { failed: string } | null;

export function HowYouCompare({ projectPath, serverProjectId }: HowYouCompareProps) {
	const { t } = useTranslation("analytics");
	const [comparison, setComparison] = useState<BuildComparison | null>(null);
	const [loading, setLoading] = useState(true);
	// Set whenever loading ends without a comparison.
	const [error, setError] = useState("");
	const [exporting, setExporting] = useState(false);
	const [report, setReport] = useState<ReportState>(null);

	const load = useCallback(async () => {
		setLoading(true);
		setError("");
		try {
			const result = await loadBuildComparison(projectPath, serverProjectId);
			if (result.success && result.data) setComparison(result.data);
			else setError(result.error ?? t("compare.error"));
		} catch (e) {
			setError(e instanceof Error ? e.message : t("compare.error"));
		} finally {
			setLoading(false);
		}
	}, [projectPath, serverProjectId, t]);

	useEffect(() => {
		load();
	}, [load]);

	const exportReport = async (data: BuildComparison) => {
		setExporting(true);
		setReport(null);
		try {
			const document = compareReport(data, t, !!serverProjectId, formatAppDate(new Date()));
			const result = await globalThis.electronAPI.exportBuildComparison(document);
			if (!result.success) setReport({ failed: result.error ?? t("compare.report.error") });
			else if (result.data) setReport({ saved: result.data });
		} catch (e) {
			setReport({ failed: e instanceof Error ? e.message : t("compare.report.error") });
		} finally {
			setExporting(false);
		}
	};

	if (loading) return <ScanLine label={t("compare.loading")} />;
	if (!comparison) {
		return (
			<EmptyStage
				icon={AlertTriangle}
				title={error}
				tone="red"
				action={
					<CharterButton icon={RefreshCw} onClick={load}>
						{t("status.retry")}
					</CharterButton>
				}
			/>
		);
	}

	const sizeLabel = (size: string) => t(`compare.sizes.${size}`, { defaultValue: size });
	const teamLabel = (team: string) => t(`compare.teams.${team}`, { defaultValue: team });
	const stackLabel = (stack: string) => (stack === "other" ? t("compare.otherStack") : stack);
	const groupCell = (group: CompareGroup, metric: CompareMetric) => (
		<>
			{group.medians ? formatMetric(metric, group.medians[metric]) : "—"}
			{group.top && group.top[metric] !== null && (
				<span className="wp-meta block">
					{t("compare.top", { value: formatMetric(metric, group.top[metric]) })}
				</span>
			)}
			{group.trend && group.trend[metric] !== null && (
				<span className="wp-meta block">{t("compare.groupTrend", { value: formatTrend(group.trend[metric]) })}</span>
			)}
		</>
	);
	const others = comparison.projects.filter((line) => !line.current);
	const moves = moveSentences(comparison, t);
	const pace = paceLines(comparison);

	return (
		<div className="space-y-4" data-testid="how-you-compare">
			<Notice tone="accent" icon={ShieldCheck}>
				{serverProjectId
					? t("compare.privacyServer", { count: comparison.min_group })
					: t("compare.privacyLocal")}
			</Notice>

			<Panel className="space-y-3">
				<div className="flex flex-wrap items-center justify-between gap-2">
					<h3 className="wp-title flex items-center gap-2 text-sm">
						<Scale className="h-4 w-4" aria-hidden="true" />
						{t("compare.title")}
					</h3>
					<div className="flex flex-wrap items-center gap-2">
						<Chips>
							<Chip tone="blue">{stackLabel(comparison.segment.stack)}</Chip>
							<Chip tone="violet">
								{comparison.segment.size_from
									? t("compare.movedChip", {
											from: sizeLabel(comparison.segment.size_from),
											to: sizeLabel(comparison.segment.size),
										})
									: sizeLabel(comparison.segment.size)}
							</Chip>
							<Chip tone="green">
								{comparison.segment.team_from
									? t("compare.movedChip", {
											from: teamLabel(comparison.segment.team_from),
											to: teamLabel(comparison.segment.team),
										})
									: teamLabel(comparison.segment.team)}
							</Chip>
						</Chips>
						<CharterButton
							size="sm"
							icon={FileDown}
							busy={exporting}
							disabled={exporting}
							onClick={() => exportReport(comparison)}
						>
							{t("compare.report.button")}
						</CharterButton>
					</div>
				</div>
				{report && "saved" in report && (
					<p className="wp-meta" data-testid="compare-report-saved">
						{t("compare.report.saved", { path: report.saved })}
					</p>
				)}
				{report && "failed" in report && (
					<Notice tone="red" icon={AlertTriangle}>
						{report.failed}
					</Notice>
				)}
				{moves.length > 0 && (
					<Notice tone="amber" icon={ArrowRightLeft}>
						{moves.join(" ")}
					</Notice>
				)}
				<p className="wp-meta">
					{t("compare.window", {
						days: comparison.window_days,
						count: comparison.recent.specs,
						previous: comparison.previous.specs,
					})}
				</p>
				<div className="overflow-x-auto">
					<table className="w-full text-xs">
						<thead>
							<tr className="wp-muted text-left">
								<th className="py-1 pr-3 font-medium">{t("compare.columns.metric")}</th>
								<th className="py-1 pr-3 font-medium">{t("compare.columns.recent")}</th>
								<th className="py-1 pr-3 font-medium">
									{t("compare.columns.weeks", { count: comparison.weeks.length })}
								</th>
								<th className="py-1 pr-3 font-medium">{t("compare.columns.previous")}</th>
								<th className="py-1 pr-3 font-medium">{t("compare.columns.trend")}</th>
								{COMPARE_GROUPS.map((group) => (
									<th key={group} className="py-1 pr-3 font-medium">
										{t(`compare.groups.${group}`)}
										<span className="wp-meta block font-normal">
											{t("compare.projectCount", { count: comparison.groups[group].projects })}
										</span>
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{COMPARE_METRICS.map((metric) => (
								<tr key={metric} className="border-t border-border/50">
									<td className="py-1.5 pr-3 font-medium">{t(`compare.metrics.${METRIC_KEYS[metric]}`)}</td>
									<td className="py-1.5 pr-3 font-mono font-semibold">
										{formatMetric(metric, comparison.recent[metric])}
									</td>
									<td className="py-1.5 pr-3">
										<CompareSparkline
											values={comparison.weeks.map((week) => week[metric])}
											label={t("compare.sparkline", {
												metric: t(`compare.metrics.${METRIC_KEYS[metric]}`),
											})}
										/>
									</td>
									<td className="wp-muted py-1.5 pr-3 font-mono">
										{formatMetric(metric, comparison.previous[metric])}
									</td>
									<td className="py-1.5 pr-3">
										<Chip tone={trendTone(metric, comparison.trend[metric])} dot={false}>
											{formatTrend(comparison.trend[metric])}
										</Chip>
									</td>
									{COMPARE_GROUPS.map((group) => (
										<td key={group} className="wp-muted py-1.5 pr-3 font-mono">
											{groupCell(comparison.groups[group], metric)}
										</td>
									))}
								</tr>
							))}
						</tbody>
					</table>
				</div>
				{COMPARE_GROUPS.some((group) => !comparison.groups[group].medians) && (
					<p className="wp-meta">{t("compare.smallGroup", { count: comparison.min_group })}</p>
				)}
				{comparison.min_top !== null && (
					<p className="wp-meta">{t("compare.topNote", { count: comparison.min_top })}</p>
				)}
				<p className="wp-meta">{t("compare.lowerIsBetter")}</p>
				<p className="wp-meta">{t("compare.qualitySources")}</p>
			</Panel>

			{pace.length > 0 && (
				<Panel className="space-y-2" data-testid="compare-pace">
					<h3 className="wp-title flex items-center gap-2 text-sm">
						<Gauge className="h-4 w-4" aria-hidden="true" />
						{t("compare.pace.title")}
					</h3>
					<ul className="space-y-1 text-xs">
						{pace.map((line) => (
							<li key={line.metric}>{paceSentence(line, t)}</li>
						))}
					</ul>
				</Panel>
			)}

			<CompareKinds kinds={comparison.kinds} minGroup={comparison.min_group} />

			{!serverProjectId && (
				<Panel className="space-y-3">
					<h3 className="wp-title text-sm">{t("compare.yourProjects")}</h3>
					{others.length === 0 ? (
						<p className="wp-muted text-xs">{t("compare.noOtherProjects")}</p>
					) : (
						<div className="overflow-x-auto">
							<table className="w-full text-xs">
								<thead>
									<tr className="wp-muted text-left">
										<th className="py-1 pr-3 font-medium">{t("compare.columns.project")}</th>
										<th className="py-1 pr-3 font-medium">{t("compare.columns.segment")}</th>
										<th className="py-1 pr-3 font-medium">{t("compare.columns.specs")}</th>
										{COMPARE_METRICS.map((metric) => (
											<th key={metric} className="py-1 pr-3 font-medium">
												{t(`compare.metrics.${METRIC_KEYS[metric]}`)}
											</th>
										))}
									</tr>
								</thead>
								<tbody>
									{others.map((line) => (
										<tr key={`${line.name}|${line.stack}|${line.size}|${line.specs}|${line.cost}`} className="border-t border-border/50">
											<td className="max-w-[16rem] truncate py-1.5 pr-3 font-medium">{line.name}</td>
											<td className="wp-muted py-1.5 pr-3">
												{stackLabel(line.stack)} · {sizeLabel(line.size)} · {teamLabel(line.team)}
											</td>
											<td className="py-1.5 pr-3 font-mono">{line.specs}</td>
											{COMPARE_METRICS.map((metric) => (
												<td key={metric} className="wp-muted py-1.5 pr-3 font-mono">
													{formatMetric(metric, line[metric])}
												</td>
											))}
										</tr>
									))}
								</tbody>
							</table>
						</div>
					)}
				</Panel>
			)}
		</div>
	);
}
