import { AlertTriangle, BarChart3, Download, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DashboardSnapshot } from "@shared/types";
import { useServerProjectId } from "../hooks/useServerProjectId";
import { formatCurrency, getEurRate } from "../lib/currency";
import { loadDashboardSnapshot } from "../lib/workspace-data";
import {
	Bar,
	CharterButton,
	Chip,
	Gauge,
	ModuleHeader,
	ModuleStage,
	Notice,
	Page,
	Panel,
	ScanLine,
	Section,
	Stat,
	type Tone,
} from "./charter";

interface DashboardMetricsProps {
	readonly projectPath: string;
}

const STATUS_TONE: Record<string, Tone> = {
	completed: "green",
	in_progress: "blue",
	pending: "amber",
	failed: "red",
	cancelled: "muted",
};

const EMPTY_SNAPSHOT: DashboardSnapshot = {
	tasks_by_status: { pending: 0, in_progress: 0, completed: 0, failed: 0 },
	avg_completion_by_complexity: {},
	qa_first_pass_rate: 0,
	qa_avg_score: 0,
	total_tokens: 0,
	tokens_by_provider: {},
	total_cost: 0,
	cost_by_model: {},
	merge_auto_count: 0,
	merge_manual_count: 0,
} as DashboardSnapshot;

function formatSeconds(seconds: number): string {
	return seconds < 3600 ? `${Math.round(seconds / 60)}m` : `${(seconds / 3600).toFixed(1)}h`;
}

/** A key figure with its explanation underneath. */
function Kpi({
	label,
	value,
	hint,
	tone,
}: {
	readonly label: string;
	readonly value: React.ReactNode;
	readonly hint: string;
	readonly tone: Tone;
}) {
	return (
		<Panel rail tone={tone}>
			<span className="wp-kicker block">{label}</span>
			<span className="wp-stat-value wp-ink mt-1 block">{value}</span>
			<p className="wp-meta mt-0.5">{hint}</p>
		</Panel>
	);
}

/** One labelled row with a bar: a status, a model, a provider. */
function BarRow({
	label,
	value,
	pct,
	tone,
}: {
	readonly label: React.ReactNode;
	readonly value: React.ReactNode;
	readonly pct: number;
	readonly tone: Tone;
}) {
	return (
		<div className="space-y-1">
			<div className="flex items-center justify-between gap-2 text-xs">
				<span className="wp-title min-w-0 truncate">{label}</span>
				<span className="wp-meta font-mono">{value}</span>
			</div>
			<Bar value={pct} tone={tone} />
		</div>
	);
}

/** Project KPIs: tasks, QA, tokens, costs and merges, local or from the server. */
export function DashboardMetrics({ projectPath }: DashboardMetricsProps) {
	const { t, i18n } = useTranslation(["dashboard", "common", "navigation"]);
	const lang = i18n.language;
	const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [eurRate, setEurRate] = useState(0.92);
	const serverProjectId = useServerProjectId({ path: projectPath });

	const fmtCost = useCallback(
		(usd: number, decimals = 4) => formatCurrency(usd, lang, eurRate, decimals),
		[lang, eurRate],
	);

	const fetchSnapshot = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const result = await loadDashboardSnapshot(projectPath, serverProjectId);
			if (result.success) setSnapshot(result.snapshot ?? null);
			else setError(result.error || t("dashboard:errors.loadFailed"));
		} catch {
			setError(t("dashboard:errors.loadFailed"));
		} finally {
			setLoading(false);
		}
	}, [projectPath, serverProjectId, t]);

	useEffect(() => {
		void fetchSnapshot();
		void getEurRate().then(setEurRate);
	}, [fetchSnapshot]);

	// Real-time updates when this computer's dashboard_snapshot.json changes;
	// a server project is read again on refresh.
	useEffect(() => {
		if (serverProjectId) return;
		const unsubscribe = window.electronAPI.onDashboardSnapshotUpdated((updatedPath: string) => {
			if (updatedPath === projectPath) void fetchSnapshot();
		});
		return () => unsubscribe();
	}, [projectPath, fetchSnapshot, serverProjectId]);

	const handleExport = async (fmt: "json" | "csv") => {
		try {
			const result = await loadDashboardSnapshot(projectPath, serverProjectId);
			if (!result.success || !result.snapshot) return;
			const snap = result.snapshot;
			let content: string;
			if (fmt === "csv") {
				const rows = [
					["metric", "value"],
					["total_tokens", String(snap.total_tokens)],
					["total_cost", String(snap.total_cost)],
					["qa_first_pass_rate", String(snap.qa_first_pass_rate)],
					["qa_avg_score", String(snap.qa_avg_score)],
					["merge_auto_count", String(snap.merge_auto_count)],
					["merge_manual_count", String(snap.merge_manual_count)],
					...Object.entries(snap.tasks_by_status ?? {}).map(([k, v]) => [`tasks_${k}`, String(v)]),
					...Object.entries(snap.tokens_by_provider ?? {}).map(([k, v]) => [`tokens_${k}`, String(v)]),
					...Object.entries(snap.cost_by_model ?? {}).map(([k, v]) => [`cost_${k}`, String(v)]),
				];
				content = rows.map((r) => r.join(",")).join("\n");
			} else {
				content = JSON.stringify(snap, null, 2);
			}
			const blob = new Blob([content], { type: fmt === "csv" ? "text/csv" : "application/json" });
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			a.download = `dashboard-export.${fmt}`;
			a.click();
			URL.revokeObjectURL(url);
		} catch {
			setError(t("dashboard:errors.exportFailed"));
		}
	};

	// Missing maps (an older snapshot, a partial server answer) read as empty.
	const snap = { ...EMPTY_SNAPSHOT, ...(snapshot ?? {}) };
	const byStatus = snap.tasks_by_status ?? {};
	const byComplexity = snap.avg_completion_by_complexity ?? {};
	const byModel = Object.entries(snap.cost_by_model ?? {}).sort(([, a], [, b]) => b - a);
	const byProvider = Object.entries(snap.tokens_by_provider ?? {}).sort(([, a], [, b]) => b - a);

	const totalTasks = Object.values(byStatus).reduce((a, b) => a + b, 0);
	const completedTasks = byStatus.completed || 0;
	const totalCost = byModel.reduce((sum, [, v]) => sum + v, 0);
	const maxTokens = byProvider[0]?.[1] ?? 0;
	const mergeAuto = snap.merge_auto_count ?? 0;
	const mergeManual = snap.merge_manual_count ?? 0;
	const mergeTotal = mergeAuto + mergeManual;
	const mergeAutoRate = mergeTotal > 0 ? (mergeAuto / mergeTotal) * 100 : 0;
	const qaRate = snap.qa_first_pass_rate ?? 0;
	const statusLabel = (status: string) =>
		t(`dashboard:status.${status}`, { defaultValue: status.replace(/_/g, " ") });

	return (
		<ModuleStage scroll="page" data-testid="dashboard-view">
			<ModuleHeader
				kicker={t("navigation:groups.workspace")}
				title={t("dashboard:title")}
				description={serverProjectId ? t("dashboard:serverSubtitle") : t("dashboard:subtitle")}
				icon={BarChart3}
				tone="blue"
				actions={
					<>
						<CharterButton icon={RefreshCw} busy={loading} onClick={() => void fetchSnapshot()}>
							{t("common:buttons.refresh")}
						</CharterButton>
						<CharterButton icon={Download} onClick={() => void handleExport("json")}>
							{t("dashboard:export.json")}
						</CharterButton>
						<CharterButton icon={Download} onClick={() => void handleExport("csv")}>
							{t("dashboard:export.csv")}
						</CharterButton>
					</>
				}
			/>
			<Page className="space-y-4">
				{error && (
					<Notice tone="red" icon={AlertTriangle} role="alert">
						{error}
					</Notice>
				)}
				{loading && !snapshot ? (
					<ScanLine label={t("dashboard:loading")} />
				) : (
					<>
						<div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
							<Kpi
								label={t("dashboard:kpi.totalTasks.title")}
								value={totalTasks}
								hint={t("dashboard:kpi.totalTasks.completed", { count: completedTasks })}
								tone="violet"
							/>
							<Kpi
								label={t("dashboard:kpi.qaFirstPassRate.title")}
								value={`${qaRate.toFixed(1)}%`}
								hint={t("dashboard:kpi.qaFirstPassRate.avgScore", {
									score: (snap.qa_avg_score ?? 0).toFixed(1),
								})}
								tone="green"
							/>
							<Kpi
								label={t("dashboard:kpi.totalTokens.title")}
								value={(snap.total_tokens ?? 0).toLocaleString()}
								hint={t("dashboard:kpi.totalTokens.totalCost", { cost: fmtCost(snap.total_cost ?? 0) })}
								tone="amber"
							/>
							<Kpi
								label={t("dashboard:kpi.autoMerges.title")}
								value={`${mergeAutoRate.toFixed(0)}%`}
								hint={t("dashboard:kpi.autoMerges.autoManual", { auto: mergeAuto, manual: mergeManual })}
								tone="blue"
							/>
						</div>

						<div className="wp-split grid gap-4 lg:grid-cols-2">
							<Section
								kicker={t("dashboard:kickers.tasks")}
								title={t("dashboard:sections.tasksByStatus")}
								meta={String(totalTasks)}
							>
								<Panel className="space-y-3">
									{totalTasks === 0 ? (
										<p className="wp-meta">{t("dashboard:empty.noTasks")}</p>
									) : (
										Object.entries(byStatus).map(([status, count]) => (
											<BarRow
												key={status}
												label={statusLabel(status)}
												value={count}
												pct={(count / totalTasks) * 100}
												tone={STATUS_TONE[status] ?? "muted"}
											/>
										))
									)}
								</Panel>
							</Section>

							<Section kicker={t("dashboard:kickers.time")} title={t("dashboard:sections.avgCompletionTime")}>
								<Panel className="space-y-2">
									{Object.keys(byComplexity).length === 0 ? (
										<p className="wp-meta">{t("dashboard:empty.noCompletionData")}</p>
									) : (
										Object.entries(byComplexity).map(([complexity, seconds]) => (
											<div key={complexity} className="flex items-center justify-between gap-2">
												<span className="wp-title text-sm">
													{t(`dashboard:complexity.${complexity.toLowerCase()}`, { defaultValue: complexity })}
												</span>
												<Chip tone="blue" dot={false}>
													<span className="font-mono">{formatSeconds(seconds)}</span>
												</Chip>
											</div>
										))
									)}
								</Panel>
							</Section>

							<Section kicker={t("dashboard:kickers.costs")} title={t("dashboard:sections.costByModel")}>
								<Panel className="space-y-3">
									{byModel.length === 0 ? (
										<p className="wp-meta">{t("dashboard:empty.noCostData")}</p>
									) : (
										byModel.map(([model, cost]) => {
											const pct = totalCost > 0 ? (cost / totalCost) * 100 : 0;
											return (
												<BarRow
													key={model}
													label={model}
													value={t("dashboard:costShare", { cost: fmtCost(cost), pct: pct.toFixed(0) })}
													pct={pct}
													tone="amber"
												/>
											);
										})
									)}
								</Panel>
							</Section>

							<Section kicker={t("dashboard:kickers.tokens")} title={t("dashboard:sections.tokensByProvider")}>
								<Panel className="space-y-3">
									{byProvider.length === 0 ? (
										<p className="wp-meta">{t("dashboard:empty.noTokenData")}</p>
									) : (
										byProvider.map(([provider, tokens]) => (
											<BarRow
												key={provider}
												label={<span className="capitalize">{provider}</span>}
												value={tokens.toLocaleString()}
												pct={maxTokens > 0 ? (tokens / maxTokens) * 100 : 0}
												tone="violet"
											/>
										))
									)}
								</Panel>
							</Section>
						</div>

						<Section kicker={t("dashboard:kickers.merges")} title={t("dashboard:sections.mergeResolution")}>
							<div className="grid items-stretch gap-2.5 sm:grid-cols-3">
								<Panel className="flex items-center gap-3">
									<Gauge value={mergeAutoRate} tone="green" size={64} />
									<span className="wp-meta min-w-0">{t("dashboard:merge.autoResolutionRate")}</span>
								</Panel>
								<Stat label={t("dashboard:merge.automatic")} value={mergeAuto} tone="green" />
								<Stat label={t("dashboard:merge.manual")} value={mergeManual} tone="amber" />
							</div>
						</Section>
					</>
				)}
			</Page>
		</ModuleStage>
	);
}
