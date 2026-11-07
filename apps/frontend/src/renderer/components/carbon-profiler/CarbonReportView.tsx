import type React from "react";
import { useTranslation } from "react-i18next";
import { useCarbonProfilerStore } from "../../stores/carbon-profiler-store";
import type { CarbonReport } from "../../../shared/types/carbon-profiler";

interface CarbonReportViewProps {
	readonly projectPath?: string;
}

export function CarbonReportView({
	projectPath,
}: CarbonReportViewProps): React.ReactElement {
	const { t } = useTranslation("carbonProfiler");

	const phase = useCarbonProfilerStore((s) => s.phase);
	const status = useCarbonProfilerStore((s) => s.status);
	const report = useCarbonProfilerStore((s) => s.report);
	const error = useCarbonProfilerStore((s) => s.error);
	const startScan = useCarbonProfilerStore((s) => s.startScan);
	const cancelScan = useCarbonProfilerStore((s) => s.cancelScan);
	const reset = useCarbonProfilerStore((s) => s.reset);

	const isScanning = phase === "scanning";
	const canRun = !!projectPath && !isScanning;

	return (
		<div className="flex flex-col gap-4 p-6 bg-background text-foreground">
			<div className="flex items-center gap-3 flex-wrap">
				{isScanning ? (
					<button
						type="button"
						onClick={() => cancelScan()}
						className="px-3 py-1.5 rounded bg-destructive/10 text-destructive border border-destructive/20 text-sm hover:bg-destructive/20"
					>
						{t("actions.cancel")}
					</button>
				) : (
					<button
						type="button"
						onClick={() => projectPath && startScan(projectPath)}
						disabled={!canRun}
						className="px-3 py-1.5 rounded bg-primary text-white text-sm disabled:opacity-50"
					>
						{t("actions.runScan")}
					</button>
				)}
				{report && !isScanning && (
					<button
						type="button"
						onClick={reset}
						className="px-3 py-1.5 rounded bg-card border border-border text-sm hover:bg-muted"
					>
						{t("actions.reset")}
					</button>
				)}
			</div>

			{!projectPath && (
				<div className="text-sm text-muted-foreground">
					{t("errors.noProject")}
				</div>
			)}

			{isScanning && (
				<div className="text-sm text-muted-foreground animate-pulse">
					{status || t("actions.scanning")}
				</div>
			)}

			{phase === "error" && error && (
				<div className="text-sm text-destructive">
					{t("errors.failed", { error })}
				</div>
			)}

			{report ? (
				<ReportBody report={report} t={t} />
			) : (
				phase === "idle" && (
					<div className="flex items-center justify-center h-40 text-muted-foreground">
						<p>{t("noData")}</p>
					</div>
				)
			)}
		</div>
	);
}

function StatCard({
	label,
	value,
	color,
}: {
	readonly label: string;
	readonly value: string;
	readonly color: string;
}): React.ReactElement {
	return (
		<div className="p-3 rounded-lg bg-card border border-border">
			<p className="text-xs text-muted-foreground">{label}</p>
			<p className={`text-xl font-bold ${color}`}>{value}</p>
		</div>
	);
}

function ReportBody({
	report,
	t,
}: {
	readonly report: CarbonReport;
	readonly t: (key: string, opts?: Record<string, unknown>) => string;
}): React.ReactElement {
	return (
		<div className="flex flex-col gap-4">
			<div>
				<h2 className="text-lg font-semibold">{t("title")}</h2>
				<p className="text-sm text-muted-foreground">
					{report.periodStart || "—"} → {report.periodEnd || "—"}
				</p>
			</div>

			<div className="grid grid-cols-3 gap-3">
				<StatCard
					label={t("totalEnergy")}
					value={`${report.totalKwh.toFixed(3)} kWh`}
					color="text-warning"
				/>
				<StatCard
					label={t("co2Emissions")}
					value={`${report.totalCo2G.toFixed(1)} g`}
					color="text-destructive"
				/>
				<StatCard
					label={t("records")}
					value={String(report.records.length)}
					color="text-blue-400"
				/>
			</div>

			{Object.keys(report.byProvider).length > 0 && (
				<div>
					<h3 className="text-sm font-medium text-muted-foreground mb-2">
						{t("co2ByProvider")}
					</h3>
					<div className="grid grid-cols-4 gap-2">
						{Object.entries(report.byProvider).map(([provider, co2]) => (
							<div
								key={provider}
								className="p-2 rounded-lg bg-card border border-border"
							>
								<p className="text-xs text-muted-foreground truncate">
									{provider}
								</p>
								<p className="text-sm font-bold text-orange-400">
									{co2.toFixed(1)}
								</p>
							</div>
						))}
					</div>
				</div>
			)}

			{Object.keys(report.byModel).length > 0 && (
				<div>
					<h3 className="text-sm font-medium text-muted-foreground mb-2">
						{t("co2ByModel")}
					</h3>
					<div className="grid grid-cols-4 gap-2">
						{Object.entries(report.byModel).map(([model, co2]) => (
							<div
								key={model}
								className="p-2 rounded-lg bg-card border border-border"
							>
								<p className="text-xs text-muted-foreground truncate">
									{model}
								</p>
								<p className="text-sm font-bold text-purple-400">
									{co2.toFixed(1)}
								</p>
							</div>
						))}
					</div>
				</div>
			)}

			{report.records.length > 0 && (
				<div>
					<h3 className="text-sm font-medium text-muted-foreground mb-2">
						{t("recentRecords")}
					</h3>
					<div className="space-y-1">
						{report.records.slice(0, 20).map((rec) => (
							<div
								key={rec.timestamp}
								className="flex items-center gap-3 px-3 py-2 text-xs rounded hover:bg-card transition-colors"
							>
								<span className="text-muted-foreground w-20 shrink-0">
									{rec.source}
								</span>
								<span className="font-mono w-28 shrink-0 truncate">
									{rec.model || rec.provider}
								</span>
								<span className="text-warning w-20 shrink-0">
									{rec.kwh.toFixed(4)} kWh
								</span>
								<span className="text-destructive w-16 shrink-0">
									{rec.co2G.toFixed(2)} g
								</span>
								<span className="text-muted-foreground ml-auto">
									{rec.durationS.toFixed(1)}s
								</span>
							</div>
						))}
					</div>
				</div>
			)}

			{report.summary && (
				<p className="text-sm text-muted-foreground italic mt-2">
					{report.summary}
				</p>
			)}
		</div>
	);
}
