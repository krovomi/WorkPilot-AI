import { AlertTriangle, Car, Download, History, Leaf, Lightbulb, RotateCcw, Square } from "lucide-react";
import type React from "react";
import { useEffect, useId } from "react";
import { useTranslation } from "react-i18next";
import type { CarbonAdvice, CarbonBreakdown, CarbonExportFormat, CarbonReport } from "../../../shared/types/carbon-profiler";
import { formatAppDateTime } from "../../lib/date-format";
import { currentMonth, useCarbonProfilerStore } from "../../stores/carbon-profiler-store";
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
} from "../charter";
import { Label } from "../ui/label";
import { NativeSelect } from "../ui/native-select";
import { BudgetMeter, CarbonSettings, kg } from "./CarbonBudgetPanel";

interface CarbonReportViewProps {
	readonly projectPath?: string;
}

const EXPORTS: CarbonExportFormat[] = ["json", "csv", "md"];

/** The months to offer: this one, the ones the ledger has, and the whole ledger (""). */
function monthChoices(report: CarbonReport | null, chosen: string): string[] {
	const months = new Set([currentMonth(), ...(report?.months.map((m) => m.month) ?? [])]);
	if (chosen) months.add(chosen);
	return [...[...months].sort().reverse(), ""];
}

/** The estimated CO₂ of the project's model calls: month, budget, advice, ESG export. */
export function CarbonReportView({ projectPath }: CarbonReportViewProps): React.ReactElement {
	const { t } = useTranslation(["carbonProfiler", "navigation"]);
	const monthId = useId();

	const phase = useCarbonProfilerStore((s) => s.phase);
	const status = useCarbonProfilerStore((s) => s.status);
	const report = useCarbonProfilerStore((s) => s.report);
	const error = useCarbonProfilerStore((s) => s.error);
	const month = useCarbonProfilerStore((s) => s.month);
	const saving = useCarbonProfilerStore((s) => s.saving);
	const exported = useCarbonProfilerStore((s) => s.exported);
	const setMonth = useCarbonProfilerStore((s) => s.setMonth);
	const startScan = useCarbonProfilerStore((s) => s.startScan);
	const cancelScan = useCarbonProfilerStore((s) => s.cancelScan);
	const saveConfig = useCarbonProfilerStore((s) => s.saveConfig);
	const exportReport = useCarbonProfilerStore((s) => s.exportReport);

	const isScanning = phase === "scanning";

	// The report is read again when the project or the month changes.
	useEffect(() => {
		if (projectPath) void startScan(projectPath, { month });
	}, [projectPath, month, startScan]);

	return (
		<ModuleStage scroll="page" data-testid="carbon-profiler-view">
			<ModuleHeader
				kicker={t("navigation:groups.planning")}
				title={t("carbonProfiler:title")}
				description={t("carbonProfiler:description")}
				icon={Leaf}
				tone="green"
				actions={
					<>
						<div className="flex items-center gap-2">
							<Label htmlFor={monthId} className="wp-meta">
								{t("carbonProfiler:month.label")}
							</Label>
							<NativeSelect id={monthId} value={month} onChange={(e) => setMonth(e.target.value)}>
								{monthChoices(report, month).map((m) => (
									<option key={m || "all"} value={m}>
										{m || t("carbonProfiler:month.all")}
									</option>
								))}
							</NativeSelect>
						</div>
						{isScanning ? (
							<CharterButton variant="danger" icon={Square} onClick={() => cancelScan()}>
								{t("carbonProfiler:actions.cancel")}
							</CharterButton>
						) : (
							<>
								<CharterButton
									variant="ghost"
									icon={History}
									onClick={() => projectPath && startScan(projectPath, { backfill: true })}
									disabled={!projectPath}
									title={t("carbonProfiler:actions.backfillHint")}
								>
									{t("carbonProfiler:actions.backfill")}
								</CharterButton>
								<CharterButton
									variant="primary"
									icon={RotateCcw}
									onClick={() => projectPath && startScan(projectPath)}
									disabled={!projectPath}
								>
									{t("carbonProfiler:actions.refresh")}
								</CharterButton>
							</>
						)}
					</>
				}
			/>
			<Page className="max-w-none space-y-4">
				{!projectPath && (
					<Notice tone="amber" icon={AlertTriangle}>
						{t("carbonProfiler:errors.noProject")}
					</Notice>
				)}
				{isScanning && <ScanLine label={status || t("carbonProfiler:actions.scanning")} />}
				{phase === "error" && error && (
					<Notice tone="red" icon={AlertTriangle} role="alert">
						{t("carbonProfiler:errors.failed", { error })}
					</Notice>
				)}
				{report ? (
					<>
						<ReportBody report={report} />
						{projectPath && (
							<Section
								kicker={t("carbonProfiler:kickers.export")}
								title={t("carbonProfiler:export.title", { month: month || currentMonth() })}
								description={t("carbonProfiler:export.description")}
							>
								<div className="flex flex-wrap gap-2">
									{EXPORTS.map((format) => (
										<CharterButton
											key={format}
											size="sm"
											icon={Download}
											onClick={() => exportReport(projectPath, format)}
										>
											{t(`carbonProfiler:export.formats.${format}`)}
										</CharterButton>
									))}
								</div>
								{exported && <p className="wp-meta mt-2">{t("carbonProfiler:export.saved", { path: exported })}</p>}
							</Section>
						)}
						{projectPath && (
							<CarbonSettings
								config={report.config}
								saving={saving}
								onSave={(config) => saveConfig(projectPath, config)}
							/>
						)}
					</>
				) : (
					phase === "idle" && (
						<EmptyStage icon={Leaf} title={t("carbonProfiler:emptyTitle")} tone="green">
							{t("carbonProfiler:noData")}
						</EmptyStage>
					)
				)}
			</Page>
		</ModuleStage>
	);
}

function Breakdown({
	kicker,
	title,
	values,
}: {
	readonly kicker: string;
	readonly title: string;
	readonly values: Record<string, number>;
}): React.ReactElement | null {
	const entries = Object.entries(values).sort(([, a], [, b]) => b - a);
	if (entries.length === 0) return null;
	return (
		<Section kicker={kicker} title={title}>
			<div className="wp-chips">
				{entries.map(([name, co2]) => (
					<Chip key={name} tone="muted" dot={false} title={name}>
						<span className="max-w-[14rem] truncate">{name}</span>
						<span className="font-mono">{co2.toFixed(1)} g</span>
					</Chip>
				))}
			</div>
		</Section>
	);
}

function Shares({
	kicker,
	title,
	values,
}: {
	readonly kicker: string;
	readonly title: string;
	readonly values: Record<string, CarbonBreakdown>;
}): React.ReactElement | null {
	const { t } = useTranslation("carbonProfiler");
	const entries = Object.entries(values);
	const top = Math.max(...entries.map(([, v]) => v.co2G), 0);
	if (entries.length === 0 || top <= 0) return null;
	return (
		<Section kicker={kicker} title={title}>
			<div className="grid gap-2">
				{entries.map(([name, value]) => (
					<div key={name} className="grid grid-cols-[minmax(0,12rem)_1fr_auto] items-center gap-3 text-xs">
						<span className="truncate font-mono" title={name}>
							{name}
						</span>
						<Bar value={(value.co2G / top) * 100} tone="green" />
						<span className="font-mono">
							{t("share", { co2: value.co2G.toFixed(1), calls: value.calls })}
						</span>
					</div>
				))}
			</div>
		</Section>
	);
}

function adviceText(t: (key: string, values?: Record<string, unknown>) => string, advice: CarbonAdvice): string {
	switch (advice.code) {
		case "review_on_fast":
			return t("advice.review_on_fast", { share: advice.share, saving: advice.saving });
		case "use_cache":
			return t("advice.use_cache", { provider: advice.provider, share: advice.share });
		case "cleaner_region":
			return t("advice.cleaner_region", {
				provider: advice.provider,
				from: t(`regions.${advice.from}`, { defaultValue: advice.from }),
				to: t(`regions.${advice.to}`, { defaultValue: advice.to }),
				saving: advice.saving,
			});
		case "local_vs_cloud":
			return t(advice.localWh > advice.cloudWh ? "advice.local_heavier" : "advice.local_lighter", {
				local: advice.localWh,
				cloud: advice.cloudWh,
			});
	}
}

function ReportBody({ report }: { readonly report: CarbonReport }): React.ReactElement {
	const { t } = useTranslation("carbonProfiler");
	const trendTop = Math.max(...report.months.map((m) => m.co2G), 0);
	return (
		<>
			<Notice tone="muted" icon={Leaf}>
				{t("estimated")} {report.unknownHosts.length > 0 && t("unknownHosts", { providers: report.unknownHosts.join(", ") })}
			</Notice>
			{!report.hasLedger && (
				<Notice tone="amber" icon={AlertTriangle}>
					{t("noLedger")}
				</Notice>
			)}

			<BudgetMeter budget={report.budget} />

			<Stats>
				<Stat label={t("co2Emissions")} value={`${kg(report.totalCo2G)} kg`} tone="red" />
				<Stat label={t("totalEnergy")} value={`${report.totalKwh.toFixed(3)} kWh`} tone="amber" />
				<Stat label={t("records")} value={report.recordCount} tone="blue" />
				<Stat
					label={
						<span className="inline-flex items-center gap-1">
							<Car className="h-3 w-3" aria-hidden="true" />
							{t("carKm")}
						</span>
					}
					value={`${report.carKm} km`}
					tone="violet"
				/>
			</Stats>
			{report.periodStart && (
				<p className="wp-meta">
					{t("period", { start: formatAppDateTime(report.periodStart), end: formatAppDateTime(report.periodEnd) })}
				</p>
			)}

			{report.advice.length > 0 && (
				<Section kicker={t("kickers.advice")} title={t("adviceTitle")}>
					<div className="grid gap-2">
						{report.advice.map((advice) => (
							<Panel key={`${advice.code}-${"provider" in advice ? advice.provider : ""}`} rail tone="green">
								<p className="flex items-start gap-2 text-sm">
									<Lightbulb className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
									{adviceText(t, advice)}
								</p>
							</Panel>
						))}
					</div>
				</Section>
			)}

			{report.months.length > 1 && trendTop > 0 && (
				<Section kicker={t("kickers.trend")} title={t("trendTitle")}>
					<div className="grid gap-1.5">
						{report.months.map((m) => (
							<div key={m.month} className="grid grid-cols-[5rem_1fr_6rem] items-center gap-3 text-xs">
								<span className="font-mono">{m.month}</span>
								<Bar value={(m.co2G / trendTop) * 100} tone="green" />
								<span className="text-right font-mono">{kg(m.co2G)} kg</span>
							</div>
						))}
					</div>
				</Section>
			)}

			<Shares kicker={t("kickers.phases")} title={t("co2ByPhase")} values={report.byPhase} />
			<Shares kicker={t("kickers.tasks")} title={t("co2ByTask")} values={report.byTask} />
			<Breakdown kicker={t("kickers.providers")} title={t("co2ByProvider")} values={report.byProvider} />
			<Breakdown kicker={t("kickers.models")} title={t("co2ByModel")} values={report.byModel} />

			{report.records.length > 0 && (
				<Section kicker={t("kickers.records")} title={t("recentRecords")}>
					<div className="grid gap-2">
						{report.records
							.slice(-20)
							.reverse()
							.map((rec) => (
								<Panel
									key={`${rec.timestamp}-${rec.task}-${rec.phase}-${rec.model}-${rec.tokensOut}`}
									className="flex flex-wrap items-center gap-3 text-xs"
								>
									<Chip tone={rec.source === "llm_local" ? "violet" : "blue"}>{t(`sources.${rec.source}`)}</Chip>
									<span className="min-w-0 flex-1 truncate font-mono">{rec.model || rec.provider}</span>
									{rec.phase && <span className="wp-meta">{rec.phase}</span>}
									<span className="font-mono">{rec.kwh.toFixed(4)} kWh</span>
									<span className="font-mono">{rec.co2G.toFixed(2)} g</span>
								</Panel>
							))}
					</div>
				</Section>
			)}
		</>
	);
}
