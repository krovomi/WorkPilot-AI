import {
	Activity,
	AlertTriangle,
	BarChart3,
	FolderOpen,
	GitMerge,
	RefreshCw,
	Target,
	TrendingDown,
	TrendingUp,
	Zap,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useServerProjectId } from "../hooks/useServerProjectId";
import { loadCostSummary, loadDashboardSnapshot } from "../lib/workspace-data";
import {
	Bar,
	CharterButton,
	Chip,
	EmptyStage,
	ModuleHeader,
	ModuleStage,
	Notice,
	Page,
	Panel,
	ScanLine,
	Stat,
	Stats,
	Tabs,
	type Tone,
	toneClass,
} from "./charter";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CostSummaryData {
	total_cost: number;
	cost_by_provider: Record<string, number>;
	cost_by_model: Record<string, number>;
	total_tokens: number;
	tokens_input: number;
	tokens_output: number;
	period_days: number;
	daily_avg: number;
	trend_pct: number;
}

interface SnapshotData {
	tasks_by_status: Record<string, number>;
	avg_completion_by_complexity: Record<string, number>;
	qa_first_pass_rate: number;
	qa_avg_score: number;
	total_tokens: number;
	tokens_by_provider: Record<string, number>;
	total_cost: number;
	cost_by_model: Record<string, number>;
	merge_auto_count: number;
	merge_manual_count: number;
}

interface AnalyticsDashboardProps {
	readonly projectPath?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTokens(n: number): string {
	if (n < 1000) return n.toString();
	if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
	return `${(n / 1_000_000).toFixed(2)}M`;
}

const formatCost = (v: number) => `$${v.toFixed(4)}`;

function formatDuration(seconds: number): string {
	if (seconds < 60) return `${seconds.toFixed(0)}s`;
	if (seconds < 3600) return `${(seconds / 60).toFixed(1)}m`;
	return `${(seconds / 3600).toFixed(1)}h`;
}

const STATUS_TONES: Record<string, Tone> = {
	completed: "green",
	complete: "green",
	done: "green",
	in_progress: "blue",
	pending: "amber",
	failed: "red",
	cancelled: "muted",
};

const BREAKDOWN_TONES: Tone[] = ["accent", "blue", "green", "amber", "violet", "pink"];

type AnalyticsTab = "overview" | "costs" | "performance";

/** A panel of the dashboard: kicker, title, then its figures. */
function Card({
	icon: Icon,
	title,
	children,
}: {
	readonly icon?: typeof Activity;
	readonly title: string;
	readonly children: React.ReactNode;
}) {
	return (
		<Panel className="space-y-3">
			<h3 className="wp-title flex items-center gap-2 text-sm">
				{Icon && <Icon className="h-4 w-4" aria-hidden="true" />}
				{title}
			</h3>
			{children}
		</Panel>
	);
}

function NoData() {
	const { t } = useTranslation("analytics");
	return <p className="wp-muted text-xs">{t("status.noData")}</p>;
}

/** Share of each provider or model, largest first. */
function BreakdownList({
	data,
	formatValue,
}: {
	readonly data: Record<string, number>;
	readonly formatValue: (v: number) => string;
}) {
	const entries = Object.entries(data)
		.sort(([, a], [, b]) => b - a)
		.filter(([, v]) => v > 0);
	const total = entries.reduce((sum, [, v]) => sum + v, 0);
	if (entries.length === 0) return <NoData />;

	return (
		<div className="space-y-2.5">
			{entries.map(([name, value], idx) => {
				const pct = total > 0 ? (value / total) * 100 : 0;
				return (
					<div key={name} className="space-y-1">
						<div className="flex items-center justify-between gap-2 text-xs">
							<span className="truncate font-medium">{name}</span>
							<span className="wp-muted shrink-0 font-mono">
								{formatValue(value)} ({pct.toFixed(0)}%)
							</span>
						</div>
						<Bar value={pct} tone={BREAKDOWN_TONES[idx % BREAKDOWN_TONES.length]} />
					</div>
				);
			})}
		</div>
	);
}

/** Tasks per status: one stacked bar, then a chip per status. */
function StatusBar({ data }: { readonly data: Record<string, number> }) {
	const { t } = useTranslation("analytics");
	const entries = Object.entries(data).filter(([, count]) => count > 0);
	const total = entries.reduce((a, [, b]) => a + b, 0);
	if (total === 0) return <NoData />;

	const label = (status: string) =>
		t(`statuses.${status}`, { defaultValue: status.replaceAll("_", " ") });

	return (
		<div className="space-y-3">
			<div className="wp-stack">
				{entries.map(([status, count]) => (
					<i
						key={status}
						className={toneClass(STATUS_TONES[status] ?? "muted")}
						style={{ width: `${(count / total) * 100}%` }}
						title={`${label(status)}: ${count}`}
					/>
				))}
			</div>
			<div className="wp-chips">
				{entries.map(([status, count]) => (
					<Chip key={status} tone={STATUS_TONES[status] ?? "muted"}>
						{label(status)} <b>{count}</b>
					</Chip>
				))}
			</div>
		</div>
	);
}

function trendTone(trendPct: number): Tone {
	if (trendPct > 20) return "red";
	if (trendPct > 0) return "amber";
	return "green";
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function AnalyticsDashboard({ projectPath }: AnalyticsDashboardProps) {
	const { t } = useTranslation(["analytics", "navigation"]);
	const [costSummary, setCostSummary] = useState<CostSummaryData | null>(null);
	const [snapshot, setSnapshot] = useState<SnapshotData | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [tab, setTab] = useState<AnalyticsTab>("overview");
	const serverProjectId = useServerProjectId({ path: projectPath });

	const fetchAnalytics = useCallback(async () => {
		if (!projectPath) {
			setLoading(false);
			return;
		}
		setLoading(true);
		setError(null);
		try {
			const [costRes, snapRes] = await Promise.allSettled([
				loadCostSummary(projectPath, serverProjectId),
				loadDashboardSnapshot(projectPath, serverProjectId),
			]);

			if (costRes.status === "fulfilled" && costRes.value.success) {
				setCostSummary(costRes.value.summary ?? null);
			}
			if (snapRes.status === "fulfilled" && snapRes.value.success) {
				setSnapshot(snapRes.value.snapshot ?? null);
			}

			const bothFailed =
				(costRes.status === "rejected" || !costRes.value?.success) &&
				(snapRes.status === "rejected" || !snapRes.value?.success);
			if (bothFailed) setError(t("analytics:status.error"));
		} catch (e) {
			setError(e instanceof Error ? e.message : t("analytics:status.error"));
		} finally {
			setLoading(false);
		}
	}, [projectPath, serverProjectId, t]);

	useEffect(() => {
		fetchAnalytics();
	}, [fetchAnalytics]);

	const header = (
		<ModuleHeader
			kicker={t("navigation:groups.planning")}
			title={t("analytics:title")}
			description={serverProjectId ? t("analytics:serverSubtitle") : t("analytics:subtitle")}
			icon={BarChart3}
			tone="blue"
			actions={
				projectPath && (
					<CharterButton variant="ghost" icon={RefreshCw} busy={loading} onClick={fetchAnalytics}>
						{t("analytics:actions.refresh")}
					</CharterButton>
				)
			}
		/>
	);

	if (!projectPath || loading || (error && !costSummary && !snapshot)) {
		return (
			<ModuleStage data-testid="analytics-view">
				{header}
				<div className="relative z-[1] flex flex-1 items-center justify-center p-8">
					{!projectPath ? (
						<EmptyStage icon={FolderOpen} title={t("analytics:title")} tone="blue">
							{t("analytics:empty.noProject")}
						</EmptyStage>
					) : loading ? (
						<ScanLine label={t("analytics:status.loading")} />
					) : (
						<EmptyStage
							icon={AlertTriangle}
							title={error}
							tone="red"
							action={
								<CharterButton icon={RefreshCw} onClick={fetchAnalytics}>
									{t("analytics:status.retry")}
								</CharterButton>
							}
						/>
					)}
				</div>
			</ModuleStage>
		);
	}

	const cs = costSummary;
	const sn = snapshot;

	const totalTasks = sn ? Object.values(sn.tasks_by_status).reduce((a, b) => a + b, 0) : 0;
	const completedTasks = sn
		? (sn.tasks_by_status.completed ?? sn.tasks_by_status.complete ?? 0)
		: 0;
	const successRate = totalTasks > 0 ? (completedTasks / totalTasks) * 100 : 0;
	const totalCost = cs?.total_cost ?? sn?.total_cost ?? 0;
	const totalTokens = cs?.total_tokens ?? sn?.total_tokens ?? 0;
	const trendPct = cs?.trend_pct ?? 0;
	const TrendIcon = trendPct >= 0 ? TrendingUp : TrendingDown;

	const tabs = [
		{ id: "overview", label: t("analytics:tabs.overview"), icon: Target },
		{ id: "costs", label: t("analytics:tabs.costs"), icon: Activity },
		{ id: "performance", label: t("analytics:tabs.performance"), icon: Zap },
	] as const;

	return (
		<ModuleStage scroll="page" data-testid="analytics-view">
			{header}
			<Page className="max-w-none space-y-4">
				{error && (
					<Notice tone="amber" icon={AlertTriangle}>
						{error}
					</Notice>
				)}
				<Stats>
					<Stat label={t("analytics:kpis.totalBuilds.title")} value={String(totalTasks)} />
					<Stat
						label={t("analytics:kpis.successRate.title")}
						value={`${successRate.toFixed(1)}%`}
						tone="green"
					/>
					<Stat label={t("analytics:kpis.totalTokens.title")} value={formatTokens(totalTokens)} tone="orange" />
					<Stat label={t("analytics:kpis.totalCost.title")} value={formatCost(totalCost)} tone="violet" />
				</Stats>

				<Tabs tabs={tabs} value={tab} onChange={setTab} label={t("analytics:title")} />

				{tab === "overview" && (
					<div className="grid gap-4 lg:grid-cols-2">
						<Card icon={Target} title={t("analytics:sections.tasksByStatus")}>
							{sn ? <StatusBar data={sn.tasks_by_status} /> : <NoData />}
						</Card>
						<Card icon={Activity} title={t("analytics:sections.qaMetrics")}>
							{sn ? (
								<div className="space-y-4">
									<div className="space-y-1">
										<div className="flex justify-between text-xs">
											<span className="wp-muted">{t("analytics:fields.qaPassRate")}</span>
											<span className="font-semibold">{sn.qa_first_pass_rate.toFixed(1)}%</span>
										</div>
										<Bar value={sn.qa_first_pass_rate} tone="green" />
									</div>
									<Stats>
										<Stat label={t("analytics:fields.mergeAuto")} value={sn.merge_auto_count} tone="green" />
										<Stat label={t("analytics:fields.mergeManual")} value={sn.merge_manual_count} tone="amber" />
									</Stats>
								</div>
							) : (
								<NoData />
							)}
						</Card>
					</div>
				)}

				{tab === "costs" && (
					<>
						<div className="grid gap-4 lg:grid-cols-2">
							<Card title={t("analytics:sections.costByProvider")}>
								{cs ? <BreakdownList data={cs.cost_by_provider} formatValue={formatCost} /> : <NoData />}
							</Card>
							<Card title={t("analytics:sections.costByModel")}>
								{cs ? <BreakdownList data={cs.cost_by_model} formatValue={formatCost} /> : <NoData />}
							</Card>
						</div>
						{cs && (
							<Panel rail tone={trendTone(trendPct)} className="flex flex-wrap items-center justify-between gap-3">
								<div>
									<span className="wp-kicker">{t("analytics:fields.dailyAvg")}</span>
									<div className="mt-1 text-xl font-bold">{formatCost(cs.daily_avg)}</div>
									<div className="wp-meta">{t("analytics:fields.overDays", { days: cs.period_days })}</div>
								</div>
								<Chip tone={trendTone(trendPct)} dot={false}>
									<TrendIcon className="h-3.5 w-3.5" aria-hidden="true" />
									{trendPct >= 0 ? "+" : ""}
									{trendPct.toFixed(0)}% {t("analytics:fields.trend")}
								</Chip>
							</Panel>
						)}
					</>
				)}

				{tab === "performance" && (
					<>
						<div className="grid gap-4 lg:grid-cols-2">
							<Card icon={Zap} title={t("analytics:sections.tokensByProvider")}>
								{sn && Object.keys(sn.tokens_by_provider).length > 0 ? (
									<BreakdownList data={sn.tokens_by_provider} formatValue={formatTokens} />
								) : (
									<NoData />
								)}
							</Card>
							<Card icon={GitMerge} title={t("analytics:sections.completionByComplexity")}>
								{sn && Object.keys(sn.avg_completion_by_complexity).length > 0 ? (
									<div className="space-y-2">
										{Object.entries(sn.avg_completion_by_complexity)
											.sort(([, a], [, b]) => a - b)
											.map(([complexity, avgSecs]) => (
												<div key={complexity} className="flex items-center justify-between text-xs">
													<span className="font-medium capitalize">{complexity}</span>
													<span className="wp-muted font-mono">{formatDuration(avgSecs)}</span>
												</div>
											))}
									</div>
								) : (
									<NoData />
								)}
							</Card>
						</div>
						{cs && (
							<Card title={t("analytics:sections.tokenSplit")}>
								<Stats>
									<Stat label={t("analytics:fields.totalTokens")} value={formatTokens(cs.total_tokens)} />
									<Stat label={t("analytics:fields.inputTokens")} value={formatTokens(cs.tokens_input)} tone="blue" />
									<Stat label={t("analytics:fields.outputTokens")} value={formatTokens(cs.tokens_output)} tone="violet" />
								</Stats>
							</Card>
						)}
					</>
				)}
			</Page>
		</ModuleStage>
	);
}
