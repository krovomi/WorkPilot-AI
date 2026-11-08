import {
	AlertTriangle,
	Bell,
	Coins,
	RefreshCw,
	TrendingDown,
	TrendingUp,
	Wallet,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useServerProjectId } from "../hooks/useServerProjectId";
import { formatCurrency, getEurRate } from "../lib/currency";
import { loadCostSummary } from "../lib/workspace-data";
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
	Section,
	Stat,
	Stats,
	type Tone,
} from "./charter";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CostSummary {
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

interface BudgetInfo {
	monthly_budget: number;
	spent_this_month: number;
	remaining: number;
	utilization_pct: number;
	alerts: string[];
	forecast_end_of_month: number;
}

interface CostEstimatorProps {
	readonly projectPath: string;
}

type FormatAmount = (usd: number, decimals?: number) => string;

const BREAKDOWN_TONES: Tone[] = ["accent", "blue", "green", "amber", "violet", "pink"];

function usageTone(pct: number): Tone {
	if (pct >= 90) return "red";
	if (pct >= 70) return "amber";
	return "green";
}

function trendTone(trendPct: number): Tone {
	if (trendPct > 20) return "red";
	if (trendPct > 0) return "amber";
	return "green";
}

/** The month's budget: how much is spent, what is left, where it ends. */
function BudgetPanel({
	budget,
	formatAmount,
}: {
	readonly budget: BudgetInfo;
	readonly formatAmount: FormatAmount;
}) {
	const { t } = useTranslation("costEstimator");
	const pct = Math.min(budget.utilization_pct, 100);
	const tone = usageTone(pct);
	const overBudget = budget.forecast_end_of_month > budget.monthly_budget;

	return (
		<Section
			kicker={t("kickers.budget")}
			title={t("budget.title")}
			actions={<Chip tone={tone}>{t("budget.pctUsed", { pct: pct.toFixed(0) })}</Chip>}
		>
			<Panel rail tone={tone} className="space-y-3">
				<Bar value={pct} tone={tone} />
				<div className="wp-meta flex flex-wrap justify-between gap-2">
					<span>{t("budget.spent", { amount: formatAmount(budget.spent_this_month, 2) })}</span>
					<span>{t("budget.remaining", { amount: formatAmount(budget.remaining, 2) })}</span>
					<span>{t("budget.total", { amount: formatAmount(budget.monthly_budget, 2) })}</span>
				</div>
				{budget.forecast_end_of_month > 0 && (
					<div className="flex flex-wrap items-center gap-2 text-xs">
						<TrendingUp className="h-3 w-3" aria-hidden="true" />
						<span className="wp-muted">{t("budget.forecast")}</span>
						<span className="font-medium">{formatAmount(budget.forecast_end_of_month, 2)}</span>
						{overBudget && <Chip tone="red">{t("budget.overBudget")}</Chip>}
					</div>
				)}
				{budget.alerts.map((alert) => (
					<Notice key={alert} tone="amber" icon={Bell}>
						{alert}
					</Notice>
				))}
			</Panel>
		</Section>
	);
}

/** Cost per provider or model, largest first; unused ones as faint chips. */
function Breakdown({
	title,
	data,
	formatAmount,
}: {
	readonly title: string;
	readonly data: Record<string, number>;
	readonly formatAmount: FormatAmount;
}) {
	const { t } = useTranslation("costEstimator");
	const entries = Object.entries(data).sort(([, a], [, b]) => b - a);
	const used = entries.filter(([, v]) => v > 0);
	const unused = entries.filter(([, v]) => v === 0);
	const total = used.reduce((sum, [, v]) => sum + v, 0);

	return (
		<Panel className="space-y-3">
			<h3 className="wp-title text-sm">{title}</h3>
			{entries.length === 0 && <p className="wp-muted text-xs">{t("breakdown.noData")}</p>}
			{used.map(([name, cost], idx) => {
				const pct = total > 0 ? (cost / total) * 100 : 0;
				return (
					<div key={name} className="space-y-1">
						<div className="flex items-center justify-between gap-2 text-xs">
							<span className="truncate font-medium">{name}</span>
							<span className="wp-muted shrink-0 font-mono">
								{formatAmount(cost)} ({pct.toFixed(0)}%)
							</span>
						</div>
						<Bar value={pct} tone={BREAKDOWN_TONES[idx % BREAKDOWN_TONES.length]} />
					</div>
				);
			})}
			{unused.length > 0 && (
				<div className="wp-chips">
					{unused.map(([name]) => (
						<Chip key={name} tone="muted" dot={false}>
							{name} · {formatAmount(0, 2)}
						</Chip>
					))}
				</div>
			)}
		</Panel>
	);
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function CostEstimator({ projectPath }: CostEstimatorProps) {
	const { t, i18n } = useTranslation(["costEstimator", "common", "navigation"]);
	const [eurRate, setEurRate] = useState(0.92);
	const [summary, setSummary] = useState<CostSummary | null>(null);
	const [budget, setBudget] = useState<BudgetInfo | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const serverProjectId = useServerProjectId({ path: projectPath });

	const fmtCurrency = (usd: number, decimals = 4) =>
		formatCurrency(usd, i18n.language, eurRate, decimals);

	// Fetch live EUR rate when in FR mode
	useEffect(() => {
		if (i18n.language.startsWith("fr")) {
			getEurRate().then(setEurRate);
		}
	}, [i18n.language]);

	// Helper function to handle API response
	const handleApiResponse = useCallback(
		(
			result: PromiseSettledResult<{
				success: boolean;
				data?: unknown;
				error?: string;
			}>,
			setter: (value: unknown) => void,
			silent: boolean,
			errorKey: string,
		) => {
			if (result.status === "fulfilled" && result.value?.success) {
				const value = result.value as Record<string, unknown>;
				setter(result.value.success ? value.summary || value.budget : null);
				return true;
			}

			if (!silent && (result.status === "rejected" || !result.value?.success)) {
				const msg =
					result.status === "fulfilled" ? result.value?.error : undefined;
				setError(msg || t(errorKey));
			}

			return false;
		},
		[t],
	);

	// Helper function to fetch data from APIs
	const fetchFromAPIs = useCallback(
		async (silent: boolean) => {
			try {
				// A server project keeps no budget: only what its agents spent.
				const [summaryRes, budgetRes] = await Promise.allSettled([
					loadCostSummary(projectPath, serverProjectId),
					serverProjectId
						? Promise.resolve({ success: false })
						: globalThis.electronAPI.getCostBudget(projectPath),
				]);

				const summarySuccess = handleApiResponse(
					summaryRes,
					(v) => setSummary(v as CostSummary | null),
					silent,
					"error",
				);
				const budgetSuccess = handleApiResponse(
					budgetRes,
					(v) => setBudget(v as BudgetInfo | null),
					silent || Boolean(serverProjectId),
					"error",
				);

				return summarySuccess || budgetSuccess;
			} catch (e) {
				if (!silent) {
					setError(e instanceof Error ? e.message : t("error"));
				}
				return false;
			}
		},
		[projectPath, serverProjectId, handleApiResponse, t],
	);

	// Main fetchData function
	const fetchData = useCallback(
		async (silent = false) => {
			if (!silent) {
				setLoading(true);
				setError(null);
			}

			try {
				await fetchFromAPIs(silent);
			} finally {
				if (!silent) {
					setLoading(false);
				}
			}
		},
		[fetchFromAPIs],
	);

	// Initial load
	useEffect(() => {
		fetchData();
	}, [fetchData]);

	// Auto-refresh when cost_data.json changes (pushed by main process; this
	// computer's file, so not for a server project)
	useEffect(() => {
		if (serverProjectId) return;
		if (typeof globalThis.electronAPI?.onCostsUpdated !== "function") return;
		const unsubscribe = globalThis.electronAPI.onCostsUpdated(
			(updatedPath: string) => {
				if (updatedPath === projectPath) fetchData(true);
			},
		);
		return unsubscribe;
	}, [projectPath, fetchData, serverProjectId]);

	const header = (
		<ModuleHeader
			kicker={t("navigation:groups.planning")}
			title={t("costEstimator:title")}
			description={serverProjectId ? t("costEstimator:serverSubtitle") : t("costEstimator:subtitle")}
			icon={Coins}
			tone="amber"
			actions={
				<CharterButton variant="ghost" icon={RefreshCw} busy={loading} onClick={() => fetchData()}>
					{t("common:buttons.refresh")}
				</CharterButton>
			}
		/>
	);

	if (loading || (!summary && !budget)) {
		return (
			<ModuleStage data-testid="cost-estimator-view">
				{header}
				<div className="relative z-[1] flex flex-1 items-center justify-center p-8">
					{loading ? (
						<ScanLine label={t("costEstimator:loading")} />
					) : error ? (
						<EmptyStage
							icon={AlertTriangle}
							title={error}
							tone="red"
							action={
								<CharterButton icon={RefreshCw} onClick={() => fetchData()}>
									{t("costEstimator:retry")}
								</CharterButton>
							}
						/>
					) : (
						<EmptyStage icon={Wallet} title={t("costEstimator:emptyTitle")} tone="amber">
							{t("costEstimator:emptyBody")}
						</EmptyStage>
					)}
				</div>
			</ModuleStage>
		);
	}

	return (
		<ModuleStage scroll="page" data-testid="cost-estimator-view">
			{header}
			<Page className="max-w-none space-y-4">
				{error && (
					<Notice tone="amber" icon={AlertTriangle}>
						{error}
					</Notice>
				)}
				{summary && (
					<Stats>
						<Stat
							label={t("costEstimator:kpi.totalCost.title")}
							value={fmtCurrency(summary.total_cost)}
							tone="accent"
						/>
						<Stat
							label={t("costEstimator:kpi.dailyAverage.title")}
							value={
								<span className="inline-flex items-center gap-2">
									{fmtCurrency(summary.daily_avg)}
									<Chip tone={trendTone(summary.trend_pct)} dot={false}>
										{summary.trend_pct >= 0 ? (
											<TrendingUp className="h-3 w-3" aria-hidden="true" />
										) : (
											<TrendingDown className="h-3 w-3" aria-hidden="true" />
										)}
										{Math.abs(summary.trend_pct).toFixed(0)}%
									</Chip>
								</span>
							}
						/>
						<Stat
							label={t("costEstimator:kpi.totalTokens.title")}
							value={summary.total_tokens.toLocaleString()}
							tone="amber"
						/>
						<Stat
							label={t("costEstimator:kpi.providers.title")}
							value={Object.values(summary.cost_by_provider).filter((v) => v > 0).length}
							tone="green"
						/>
					</Stats>
				)}
				{summary && (
					<p className="wp-meta">
						{t("costEstimator:kpi.totalCost.period", { days: summary.period_days })}
						{" · "}
						{t("costEstimator:kpi.totalTokens.inOut", {
							input: summary.tokens_input.toLocaleString(),
							output: summary.tokens_output.toLocaleString(),
						})}
						{" · "}
						{t("costEstimator:kpi.providers.models", {
							count: Object.keys(summary.cost_by_model).length,
						})}
					</p>
				)}

				{budget && <BudgetPanel budget={budget} formatAmount={fmtCurrency} />}

				{summary && (
					<Section kicker={t("costEstimator:kickers.breakdown")} title={t("costEstimator:breakdownTitle")}>
						<div className="grid gap-4 lg:grid-cols-2">
							<Breakdown
								title={t("costEstimator:breakdown.costByProvider")}
								data={summary.cost_by_provider}
								formatAmount={fmtCurrency}
							/>
							<Breakdown
								title={t("costEstimator:breakdown.costByModel")}
								data={summary.cost_by_model}
								formatAmount={fmtCurrency}
							/>
						</div>
					</Section>
				)}
			</Page>
		</ModuleStage>
	);
}
