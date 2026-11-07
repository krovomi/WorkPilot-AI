import type React from "react";
import { useTranslation } from "react-i18next";
import { useComplianceStore } from "../../stores/compliance-store";
import type {
	ComplianceFramework,
	ComplianceReport,
	EvidenceStatus,
} from "../../../shared/types/compliance";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../ui/select";

const STATUS_STYLES: Record<EvidenceStatus, string> = {
	collected: "text-success bg-success/10",
	verified: "text-blue-400 bg-blue-500/10",
	missing: "text-destructive bg-destructive/10",
	expired: "text-warning bg-warning/10",
};

const FRAMEWORK_OPTIONS: ComplianceFramework[] = ["SOC2", "ISO_27001"];

interface ComplianceReportViewProps {
	readonly projectPath?: string;
}

export function ComplianceReportView({
	projectPath,
}: ComplianceReportViewProps): React.ReactElement {
	const { t } = useTranslation("compliance");

	const phase = useComplianceStore((s) => s.phase);
	const status = useComplianceStore((s) => s.status);
	const report = useComplianceStore((s) => s.report);
	const error = useComplianceStore((s) => s.error);
	const framework = useComplianceStore((s) => s.framework);
	const setFramework = useComplianceStore((s) => s.setFramework);
	const startScan = useComplianceStore((s) => s.startScan);
	const cancelScan = useComplianceStore((s) => s.cancelScan);
	const reset = useComplianceStore((s) => s.reset);

	const isScanning = phase === "scanning";
	const canRun = !!projectPath && !isScanning;

	return (
		<div className="flex flex-col gap-4 p-6 bg-background text-foreground">
			<div className="flex items-center gap-3 flex-wrap">
				<div className="flex items-center gap-2">
					<span className="text-sm text-muted-foreground">
						{t("framework")}
					</span>
					<Select
						value={framework}
						disabled={isScanning}
						onValueChange={(value) => setFramework(value as ComplianceFramework)}
					>
						<SelectTrigger className="w-32">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{FRAMEWORK_OPTIONS.map((f) => (
								<SelectItem key={f} value={f}>
									{f}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>

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

function ReportBody({
	report,
	t,
}: {
	readonly report: ComplianceReport;
	readonly t: (key: string, opts?: Record<string, unknown>) => string;
}): React.ReactElement {
	let barColor = "bg-destructive";
	if (report.coveragePercent >= 80) {
		barColor = "bg-success";
	} else if (report.coveragePercent >= 50) {
		barColor = "bg-warning";
	}

	return (
		<div className="flex flex-col gap-4">
			<div>
				<h2 className="text-lg font-semibold">{t("title")}</h2>
				<p className="text-sm text-muted-foreground">
					{report.framework} · {report.collectedCount} {t("evidenceItems")} ·{" "}
					{report.coveragePercent}% {t("coverage")}
				</p>
			</div>

			<div className="w-full h-3 rounded-full bg-card overflow-hidden">
				<div
					className={`h-full rounded-full transition-all ${barColor}`}
					style={{ width: `${report.coveragePercent}%` }}
				/>
			</div>

			{report.missingControls.length > 0 && (
				<div className="p-3 rounded-lg bg-destructive/10 border border-destructive/20">
					<p className="text-xs font-medium text-destructive mb-1">
						{t("missingControls")}
					</p>
					<div className="flex flex-wrap gap-1">
						{report.missingControls.map((ctrl) => (
							<span
								key={ctrl}
								className="px-2 py-0.5 rounded text-xs bg-destructive/20 text-destructive"
							>
								{ctrl}
							</span>
						))}
					</div>
				</div>
			)}

			<div className="space-y-2">
				{report.evidence.map((item) => (
					<div
						key={item.id}
						className="flex items-center gap-3 px-4 py-3 rounded-lg border border-border hover:bg-card transition-colors"
					>
						<span
							className={`px-2 py-0.5 rounded text-xs font-medium ${STATUS_STYLES[item.status]}`}
						>
							{item.status}
						</span>
						<div className="flex-1 min-w-0">
							<p className="text-sm font-medium truncate">{item.title}</p>
							<p className="text-xs text-muted-foreground">
								{item.controlId} · {item.evidenceType.replaceAll("_", " ")}
								{item.source ? ` · ${item.source}` : ""}
							</p>
						</div>
					</div>
				))}
			</div>

			{report.summary && (
				<p className="text-sm text-muted-foreground italic mt-2">
					{report.summary}
				</p>
			)}
		</div>
	);
}
