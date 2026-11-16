/**
 * The proactive view's trends (#370): how many files sit in each trajectory,
 * the hot list (fast rising) with each file's curve, the slowly rising files,
 * and the directories that degrade together. Every figure comes from the
 * scans' history; nothing here is estimated by a model.
 */
import type {
	FileRiskTrend,
	RiskTrajectory,
	RiskTrendReport,
} from "@shared/types/self-healing";
import { Flame, FolderTree, TrendingUp } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Chip, Chips, Panel, type Tone } from "../charter";
import { RiskTrajectoryChart } from "./RiskTrajectoryChart";

const CLASS_TONE: Record<RiskTrajectory, Tone> = {
	new: "muted",
	stable: "blue",
	slow_rise: "amber",
	fast_rise: "red",
	improving: "green",
};
const CLASS_ORDER: RiskTrajectory[] = ["fast_rise", "slow_rise", "stable", "improving", "new"];

function TrendRow({ trend, days }: { readonly trend: FileRiskTrend; readonly days: number }) {
	const { t } = useTranslation(["selfHealing"]);
	return (
		<li className="flex items-center gap-3 py-1.5" data-testid="trend-row">
			<RiskTrajectoryChart file={trend.file} points={trend.points} days={days} />
			<div className="min-w-0 flex-1">
				<code className="block truncate text-xs text-foreground" title={trend.file}>
					{trend.file}
				</code>
				<div className="wp-meta flex flex-wrap gap-x-3">
					<span>{t("selfHealing:trends.slope", { slope: trend.slope.toFixed(1) })}</span>
					<span>
						{t("selfHealing:trends.riskFromTo", {
							from: trend.start_risk.toFixed(0),
							to: trend.risk.toFixed(0),
						})}
					</span>
					<span>
						{t("selfHealing:trends.why", {
							pct: `${trend.complexity_change_pct >= 0 ? "+" : ""}${trend.complexity_change_pct.toFixed(0)}`,
							from: trend.churn_start,
							to: trend.churn_now,
						})}
					</span>
					{trend.reset && <span>{t("selfHealing:trends.reset")}</span>}
				</div>
			</div>
			{trend.entered_hot && (
				<Chip tone="red" dot={false}>
					{t("selfHealing:trends.newlyHot")}
				</Chip>
			)}
		</li>
	);
}

export function ProactiveHotlist({ report }: { readonly report: RiskTrendReport | null }) {
	const { t } = useTranslation(["selfHealing"]);
	const followed = report ? report.files - report.counts.new : 0;
	if (!report || followed === 0) {
		return (
			<Panel className="text-center" data-testid="trends-empty">
				<p className="wp-muted text-sm">
					{t("selfHealing:trends.empty", { count: report?.snapshots ?? 0 })}
				</p>
			</Panel>
		);
	}
	return (
		<Panel tone="red" data-testid="proactive-hotlist">
			<div className="mb-2 flex items-center justify-between gap-2">
				<h3 className="wp-kicker">{t("selfHealing:trends.title")}</h3>
				<span className="wp-meta">
					{t("selfHealing:trends.snapshots", { count: report.snapshots, files: report.files })}
				</span>
			</div>
			<Chips>
				{CLASS_ORDER.map((name) => (
					<Chip key={name} tone={CLASS_TONE[name]}>
						{t(`selfHealing:trends.class.${name}`)} · {report.counts[name]}
					</Chip>
				))}
			</Chips>

			<h4 className="wp-kicker mt-4 flex items-center gap-1.5">
				<Flame className="h-3.5 w-3.5" aria-hidden="true" />
				{t("selfHealing:trends.hotList")}
			</h4>
			{report.hot.length === 0 ? (
				<p className="wp-muted mt-1 text-xs">{t("selfHealing:trends.noHot")}</p>
			) : (
				<ul className="divide-y divide-border">
					{report.hot.map((trend) => (
						<TrendRow key={trend.file} trend={trend} days={report.window_days} />
					))}
				</ul>
			)}

			{report.rising.length > 0 && (
				<>
					<h4 className="wp-kicker mt-4 flex items-center gap-1.5">
						<TrendingUp className="h-3.5 w-3.5" aria-hidden="true" />
						{t("selfHealing:trends.rising")}
					</h4>
					<ul className="divide-y divide-border">
						{report.rising.map((trend) => (
							<TrendRow key={trend.file} trend={trend} days={report.window_days} />
						))}
					</ul>
				</>
			)}

			{report.clusters.length > 0 && (
				<>
					<h4 className="wp-kicker mt-4 flex items-center gap-1.5">
						<FolderTree className="h-3.5 w-3.5" aria-hidden="true" />
						{t("selfHealing:trends.clusters")}
					</h4>
					<ul className="mt-1 space-y-1" data-testid="risk-clusters">
						{report.clusters.map((cluster) => (
							<li key={cluster.directory} className="text-xs">
								<code className="text-foreground">{cluster.directory}</code>{" "}
								<span className="wp-meta">
									{t("selfHealing:trends.clusterLine", {
										rising: cluster.rising,
										total: cluster.total,
										fast: cluster.fast,
									})}
								</span>
							</li>
						))}
					</ul>
				</>
			)}
		</Panel>
	);
}
