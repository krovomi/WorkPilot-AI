import { AlertTriangle, ClipboardCheck, Play, RotateCcw, Save, Square } from "lucide-react";
import type React from "react";
import { useEffect, useId } from "react";
import { useTranslation } from "react-i18next";
import type { ComplianceReport } from "../../../shared/types/compliance";
import { useComplianceStore } from "../../stores/compliance-store";
import {
	CharterButton,
	Chip,
	EmptyStage,
	Gauge,
	ModuleHeader,
	ModuleStage,
	Notice,
	Page,
	ScanLine,
	Stat,
	Stats,
	type Tone,
} from "../charter";
import { ControlsSection, ExportButtons, GapsSection, SavedReports, SummaryCard } from "./CompliancePanels";

interface ComplianceReportViewProps {
	readonly projectPath?: string;
}

/** Dated audit evidence judged against a framework's controls, month by month (#357). */
export function ComplianceReportView({ projectPath }: ComplianceReportViewProps): React.ReactElement {
	const { t } = useTranslation(["compliance", "navigation"]);
	const monthId = useId();
	const monthlyId = useId();

	const phase = useComplianceStore((s) => s.phase);
	const report = useComplianceStore((s) => s.report);
	const error = useComplianceStore((s) => s.error);
	const framework = useComplianceStore((s) => s.framework);
	const period = useComplianceStore((s) => s.period);
	const catalog = useComplianceStore((s) => s.catalog);
	const reports = useComplianceStore((s) => s.reports);
	const savingConfig = useComplianceStore((s) => s.savingConfig);
	const { setFramework, setPeriod, startScan, openReport, setMonthly, cancelScan, reset } =
		useComplianceStore.getState();

	useEffect(() => {
		if (projectPath) void useComplianceStore.getState().loadCatalog(projectPath);
	}, [projectPath]);

	const isScanning = phase === "scanning";
	const monthly = Boolean(catalog?.config.monthly && catalog.config.frameworks.includes(framework));

	return (
		<ModuleStage scroll="page" data-testid="compliance-view">
			<ModuleHeader
				kicker={t("navigation:groups.toolbox")}
				title={t("compliance:title")}
				description={t("compliance:description")}
				icon={ClipboardCheck}
				tone="blue"
				actions={
					<>
						{report && !isScanning && (
							<CharterButton variant="ghost" icon={RotateCcw} onClick={reset}>
								{t("compliance:actions.reset")}
							</CharterButton>
						)}
						{isScanning ? (
							<CharterButton variant="danger" icon={Square} onClick={() => cancelScan()}>
								{t("compliance:actions.cancel")}
							</CharterButton>
						) : (
							<>
								<CharterButton
									variant="ghost"
									icon={Save}
									onClick={() => projectPath && startScan(projectPath, true)}
									disabled={!projectPath}
								>
									{t("compliance:actions.save")}
								</CharterButton>
								<CharterButton
									variant="primary"
									icon={Play}
									onClick={() => projectPath && startScan(projectPath)}
									disabled={!projectPath}
								>
									{t("compliance:actions.runScan")}
								</CharterButton>
							</>
						)}
					</>
				}
			/>
			<Page className="max-w-none space-y-4">
				<div className="flex flex-wrap items-center gap-2">
					<span className="wp-kicker">{t("compliance:framework")}</span>
					{(catalog?.frameworks ?? []).map((f) => (
						<Chip
							key={f.id}
							tone="blue"
							dot={false}
							pressed={framework === f.id}
							onClick={isScanning ? undefined : () => setFramework(f.id)}
							title={`${f.name} ${f.version} · ${f.controls}`}
						>
							{f.name}
						</Chip>
					))}
					<label htmlFor={monthId} className="wp-kicker ml-2">
						{t("compliance:period")}
					</label>
					<input
						id={monthId}
						type="month"
						className="h-7 rounded-md border border-border bg-background px-2 text-xs"
						value={period}
						max={new Date().toISOString().slice(0, 7)}
						onChange={(e) => setPeriod(e.target.value)}
						disabled={isScanning}
						aria-describedby={`${monthId}-hint`}
					/>
					<span id={`${monthId}-hint`} className="wp-meta">
						{period ? "" : t("compliance:thisMonth")}
					</span>
				</div>
				{projectPath && catalog && (
					<div className="flex items-start gap-2 text-sm">
						<input
							id={monthlyId}
							type="checkbox"
							className="mt-1"
							checked={monthly}
							disabled={savingConfig}
							onChange={(e) => setMonthly(projectPath, e.target.checked)}
						/>
						<label htmlFor={monthlyId}>
							{t("compliance:monthly.label")}
							<span className="wp-meta block">{t("compliance:monthly.hint")}</span>
						</label>
					</div>
				)}
				{catalog && catalog.errors.length > 0 && (
					<Notice tone="amber" icon={AlertTriangle}>
						{t("compliance:errors.frameworkFiles")} {catalog.errors.join(" · ")}
					</Notice>
				)}
				{!projectPath && (
					<Notice tone="amber" icon={AlertTriangle}>
						{t("compliance:errors.noProject")}
					</Notice>
				)}
				{isScanning && <ScanLine label={t("compliance:actions.scanning")} />}
				{error && (
					<Notice tone="red" icon={AlertTriangle} role="alert">
						{t("compliance:errors.failed", { error })}
					</Notice>
				)}
				{report ? (
					<ReportBody report={report} />
				) : (
					phase === "idle" && (
						<EmptyStage icon={ClipboardCheck} title={t("compliance:emptyTitle")} tone="blue">
							{t("compliance:noData")}
						</EmptyStage>
					)
				)}
				{projectPath && (
					<SavedReports reports={reports} onOpen={(name) => openReport(projectPath, name)} />
				)}
			</Page>
		</ModuleStage>
	);
}

function ReportBody({ report }: { readonly report: ComplianceReport }): React.ReactElement {
	const { t } = useTranslation("compliance");
	const coverage = report.coveragePercent;
	const tone: Tone = coverage >= 80 ? "green" : coverage >= 50 ? "amber" : "red";
	const s = report.summary;
	return (
		<>
			<div className="flex flex-wrap items-center gap-4">
				<Gauge value={coverage} tone={tone} label={t("coverage")} />
				<div className="min-w-0 flex-1">
					<Stats>
						<Stat label={t("stats.covered")} value={s.covered} tone="green" />
						<Stat label={t("stats.failing")} value={s.failing} tone={s.failing ? "red" : "muted"} />
						<Stat label={t("stats.stale")} value={s.stale} tone={s.stale ? "amber" : "muted"} />
						<Stat label={t("stats.missing")} value={s.missing} tone={s.missing ? "red" : "muted"} />
						<Stat label={t("stats.alerts")} value={s.alerts} tone={s.alerts ? "red" : "green"} />
					</Stats>
				</div>
			</div>
			{report.saved && (
				<p className="wp-meta" role="status">
					{t("saved.savedAs", { name: report.saved })}
				</p>
			)}
			<ExportButtons report={report} />
			<SummaryCard report={report} />
			<GapsSection report={report} />
			<ControlsSection report={report} />
		</>
	);
}
