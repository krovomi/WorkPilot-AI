/**
 * "How you compare" in Build Analytics: the project's specs over the last
 * thirty days against the thirty before, and against other projects of its
 * stack and size. On this computer the other projects are the person's own,
 * listed by name; on a server they are the organization's projects the
 * person may read, as medians only, from groups of `min_group` projects.
 *
 * Every figure is per spec and lower is better: minutes, USD, QA iterations,
 * agents. Nothing is sent anywhere (`main/build-compare.ts`).
 */

import { AlertTriangle, RefreshCw, Scale, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	type BuildComparison,
	COMPARE_METRICS,
	type CompareGroup,
	type CompareMetric,
} from "@shared/types/build-compare";
import { loadBuildComparison } from "../../lib/workspace-data";
import { CharterButton, Chip, Chips, EmptyStage, Notice, Panel, ScanLine, type Tone } from "../charter";

interface HowYouCompareProps {
	readonly projectPath: string;
	readonly serverProjectId?: string;
}

const GROUPS = ["segment", "stack", "all"] as const;

const METRIC_KEYS: Record<CompareMetric, string> = {
	minutes: "minutes",
	cost: "cost",
	qa_iterations: "qaIterations",
	agents: "agents",
};

/** A metric's value as the person reads it; a dash when nothing recorded it. */
export function formatMetric(metric: CompareMetric, value: number | null): string {
	if (value === null) return "—";
	if (metric === "cost") return `$${value.toFixed(2)}`;
	if (metric === "minutes") {
		return value < 60 ? `${value.toFixed(0)} min` : `${(value / 60).toFixed(1)} h`;
	}
	return value.toFixed(1).replace(/\.0$/, "");
}

/** Lower is better for every metric: a fall is good news. */
export function trendTone(value: number | null): Tone {
	if (value === null || Math.abs(value) < 5) return "muted";
	return value < 0 ? "green" : "amber";
}

function formatTrend(value: number | null): string {
	if (value === null) return "—";
	return `${value > 0 ? "+" : ""}${value.toFixed(0)}%`;
}

export function HowYouCompare({ projectPath, serverProjectId }: HowYouCompareProps) {
	const { t } = useTranslation("analytics");
	const [comparison, setComparison] = useState<BuildComparison | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
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

	if (loading) return <ScanLine label={t("compare.loading")} />;
	if (!comparison) {
		return (
			<EmptyStage
				icon={AlertTriangle}
				title={error ?? t("compare.error")}
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
	const stackLabel = (stack: string) => (stack === "other" ? t("compare.otherStack") : stack);
	const groupCell = (group: CompareGroup, metric: CompareMetric) =>
		group.medians ? formatMetric(metric, group.medians[metric]) : "—";
	const others = comparison.projects.filter((line) => !line.current);

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
					<Chips>
						<Chip tone="blue">{stackLabel(comparison.segment.stack)}</Chip>
						<Chip tone="violet">{sizeLabel(comparison.segment.size)}</Chip>
					</Chips>
				</div>
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
								<th className="py-1 pr-3 font-medium">{t("compare.columns.previous")}</th>
								<th className="py-1 pr-3 font-medium">{t("compare.columns.trend")}</th>
								{GROUPS.map((group) => (
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
									<td className="wp-muted py-1.5 pr-3 font-mono">
										{formatMetric(metric, comparison.previous[metric])}
									</td>
									<td className="py-1.5 pr-3">
										<Chip tone={trendTone(comparison.trend[metric])} dot={false}>
											{formatTrend(comparison.trend[metric])}
										</Chip>
									</td>
									{GROUPS.map((group) => (
										<td key={group} className="wp-muted py-1.5 pr-3 font-mono">
											{groupCell(comparison.groups[group], metric)}
										</td>
									))}
								</tr>
							))}
						</tbody>
					</table>
				</div>
				{GROUPS.some((group) => !comparison.groups[group].medians) && (
					<p className="wp-meta">{t("compare.smallGroup", { count: comparison.min_group })}</p>
				)}
				<p className="wp-meta">{t("compare.lowerIsBetter")}</p>
			</Panel>

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
												{stackLabel(line.stack)} · {sizeLabel(line.size)}
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

			<p className="wp-meta">{t("compare.ciPending")}</p>
		</div>
	);
}
