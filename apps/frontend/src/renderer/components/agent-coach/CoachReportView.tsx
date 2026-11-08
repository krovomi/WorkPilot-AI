/**
 * Personal Agent Coach, in the UI charter (docs/architecture/ui-charter.md):
 * the run statistics on the left, the coaching tips on the right, the scan
 * in the composer.
 */
import { GraduationCap, Lightbulb, RotateCcw, Sparkles, X } from "lucide-react";
import type React from "react";
import { useTranslation } from "react-i18next";
import type { CoachReport, TipPriority } from "../../../shared/types/agent-coach";
import { useCurrency } from "../../hooks/useCurrency";
import { formatCurrency } from "../../lib/currency";
import { useAgentCoachStore } from "../../stores/agent-coach-store";
import {
	CharterButton,
	Column,
	Columns,
	Composer,
	EmptyStage,
	ModuleHeader,
	ModuleStage,
	Notice,
	ScanLine,
	Stat,
	Stats,
	StepCard,
	type Tone,
} from "../charter";

const PRIORITY_TONE: Record<TipPriority, Tone> = {
	high: "red",
	medium: "amber",
	low: "blue",
};

interface CoachReportViewProps {
	readonly projectPath?: string;
}

export function CoachReportView({ projectPath }: CoachReportViewProps): React.ReactElement {
	const { t, i18n } = useTranslation(["agentCoach", "navigation"]);
	const { rate } = useCurrency();

	const formatCost = (usd: number, decimals: number): string =>
		formatCurrency(usd, i18n.language, rate, decimals);

	const phase = useAgentCoachStore((s) => s.phase);
	const status = useAgentCoachStore((s) => s.status);
	const report = useAgentCoachStore((s) => s.report);
	const error = useAgentCoachStore((s) => s.error);
	const startScan = useAgentCoachStore((s) => s.startScan);
	const cancelScan = useAgentCoachStore((s) => s.cancelScan);
	const reset = useAgentCoachStore((s) => s.reset);

	const handleRun = (): void => {
		if (!projectPath) return;
		void startScan(projectPath);
	};

	const isScanning = phase === "scanning";
	const ready: CoachReport | null = phase === "complete" && report && report.totalRuns > 0 ? report : null;

	return (
		<ModuleStage data-testid="agent-coach-view">
			<ModuleHeader
				kicker={t("navigation:groups.agents")}
				icon={GraduationCap}
				title={t("agentCoach:title")}
				description={t("agentCoach:description")}
				tone="violet"
			/>
			<Columns template="minmax(280px, 34%) minmax(320px, 1fr)">
				<Column kicker={t("agentCoach:kickers.overview")} title={t("agentCoach:overviewTitle")} tone="blue">
					{isScanning && <ScanLine label={status || t("agentCoach:actions.scanning")} />}
					{!isScanning && !ready && (
						<EmptyStage icon={GraduationCap} title={t("agentCoach:emptyTitle")} tone="violet">
							{phase === "complete" ? t("agentCoach:noData") : t("agentCoach:emptyHint")}
						</EmptyStage>
					)}
					{ready && (
						<div className="flex flex-col gap-3">
							<Stats>
								<Stat label={t("agentCoach:stats.runs")} value={ready.totalRuns} tone="blue" />
								<Stat
									label={t("agentCoach:stats.successRate")}
									value={`${(ready.successRate * 100).toFixed(0)}%`}
									tone={ready.successRate >= 0.8 ? "green" : "amber"}
								/>
								<Stat
									label={t("agentCoach:stats.avgCost")}
									value={formatCost(ready.avgCostUsd, 4)}
									tone="violet"
								/>
								<Stat
									label={t("agentCoach:stats.mostFailing")}
									value={<span className="truncate">{ready.mostFailingAgent || t("agentCoach:stats.none")}</span>}
									tone="red"
								/>
							</Stats>
							<p className="wp-muted text-sm">
								{t("agentCoach:summaryDetail", {
									tips: ready.tips.length,
									runs: ready.totalRuns,
									successRate: (ready.successRate * 100).toFixed(0),
									cost: formatCost(ready.totalCostUsd, 2),
								})}
							</p>
						</div>
					)}
				</Column>
				<Column
					kicker={t("agentCoach:kickers.tips")}
					title={t("agentCoach:tipsTitle", { count: ready?.tips.length ?? 0 })}
					tone="amber"
				>
					{!ready && (
						<EmptyStage icon={Lightbulb} title={t("agentCoach:tipsEmptyTitle")} tone="amber">
							{t("agentCoach:tipsEmptyHint")}
						</EmptyStage>
					)}
					{ready && (
						<div className="flex flex-col gap-3">
							{ready.tips.map((tip) => (
								<StepCard
									key={`${tip.category}-${tip.priority}-${tip.title}`}
									tone={PRIORITY_TONE[tip.priority]}
									kicker={`${t(`agentCoach:priority.${tip.priority}`)} · ${tip.category.replaceAll("_", " ")}`}
									title={tip.title}
								>
									<span className="wp-muted mt-1 text-xs whitespace-normal">{tip.description}</span>
									{tip.evidence && (
										<span className="wp-meta mt-1 whitespace-normal">
											{t("agentCoach:evidence")} {tip.evidence}
										</span>
									)}
									{tip.action && (
										<span className="mt-1 text-xs whitespace-normal text-success">→ {tip.action}</span>
									)}
								</StepCard>
							))}
						</div>
					)}
				</Column>
			</Columns>
			{!projectPath && (
				<Notice tone="amber" className="relative z-[2] mx-5 mb-2">
					{t("agentCoach:errors.noProject")}
				</Notice>
			)}
			{phase === "error" && error && (
				<Notice tone="red" role="alert" className="relative z-[2] mx-5 mb-2">
					{t("agentCoach:errors.failed", { error })}
				</Notice>
			)}
			<Composer
				prompt={
					<span className="wp-muted flex min-w-0 items-center gap-2 text-xs">
						<Sparkles className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
						<span className="truncate">{t("agentCoach:description")}</span>
					</span>
				}
				hint={
					ready
						? t("agentCoach:summary", {
								runs: ready.totalRuns,
								successRate: (ready.successRate * 100).toFixed(1),
								cost: formatCost(ready.totalCostUsd, 2),
							})
						: undefined
				}
				actions={
					<>
						{phase === "complete" && (
							<CharterButton variant="ghost" icon={RotateCcw} onClick={reset}>
								{t("agentCoach:actions.reset")}
							</CharterButton>
						)}
						{isScanning ? (
							<CharterButton variant="danger" icon={X} onClick={() => void cancelScan()}>
								{t("agentCoach:actions.cancel")}
							</CharterButton>
						) : (
							<CharterButton variant="primary" icon={GraduationCap} onClick={handleRun} disabled={!projectPath}>
								{t("agentCoach:actions.runScan")}
							</CharterButton>
						)}
					</>
				}
			/>
		</ModuleStage>
	);
}
