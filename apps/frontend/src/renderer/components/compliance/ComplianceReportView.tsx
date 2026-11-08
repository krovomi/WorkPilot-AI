import { AlertTriangle, ClipboardCheck, Play, RotateCcw, Square } from "lucide-react";
import type React from "react";
import { useTranslation } from "react-i18next";
import { useComplianceStore } from "../../stores/compliance-store";
import type {
	ComplianceFramework,
	ComplianceReport,
	EvidenceStatus,
} from "../../../shared/types/compliance";
import {
	CharterButton,
	Chip,
	EmptyStage,
	Gauge,
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
} from "../charter";

const STATUS_TONES: Record<EvidenceStatus, Tone> = {
	collected: "green",
	verified: "blue",
	missing: "red",
	expired: "amber",
};

/** The frameworks whose controls the collector maps today. */
const FRAMEWORK_OPTIONS: ComplianceFramework[] = ["SOC2", "ISO_27001"];

interface ComplianceReportViewProps {
	readonly projectPath?: string;
}

/** Audit evidence (reviews, scans, policies, deploys) mapped to a framework's controls. */
export function ComplianceReportView({
	projectPath,
}: ComplianceReportViewProps): React.ReactElement {
	const { t } = useTranslation(["compliance", "navigation"]);

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
							<CharterButton
								variant="primary"
								icon={Play}
								onClick={() => projectPath && startScan(projectPath)}
								disabled={!projectPath}
							>
								{t("compliance:actions.runScan")}
							</CharterButton>
						)}
					</>
				}
			/>
			<Page className="max-w-none space-y-4">
				<div className="flex flex-wrap items-center gap-2">
					<span className="wp-kicker">{t("compliance:framework")}</span>
					{FRAMEWORK_OPTIONS.map((f) => (
						<Chip
							key={f}
							tone="blue"
							dot={false}
							pressed={framework === f}
							onClick={isScanning ? undefined : () => setFramework(f)}
						>
							{t(`compliance:frameworks.${f}`, { defaultValue: f })}
						</Chip>
					))}
				</div>
				{!projectPath && (
					<Notice tone="amber" icon={AlertTriangle}>
						{t("compliance:errors.noProject")}
					</Notice>
				)}
				{isScanning && <ScanLine label={status || t("compliance:actions.scanning")} />}
				{phase === "error" && error && (
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
			</Page>
		</ModuleStage>
	);
}

function ReportBody({ report }: { readonly report: ComplianceReport }): React.ReactElement {
	const { t } = useTranslation("compliance");
	const coverage = report.coveragePercent;
	const tone: Tone = coverage >= 80 ? "green" : coverage >= 50 ? "amber" : "red";

	return (
		<>
			<div className="flex flex-wrap items-center gap-4">
				<Gauge value={coverage} tone={tone} label={t("coverage")} />
				<div className="min-w-0 flex-1">
					<Stats>
						<Stat label={t("evidence")} value={report.collectedCount} tone="blue" />
						<Stat
							label={t("missingControls")}
							value={report.missingControls.length}
							tone={report.missingControls.length ? "red" : "green"}
						/>
						<Stat label={t("framework")} value={t(`frameworks.${report.framework}`, { defaultValue: report.framework })} tone="muted" />
					</Stats>
				</div>
			</div>

			{report.missingControls.length > 0 && (
				<Section kicker={t("kickers.gaps")} title={t("missingControls")}>
					<div className="wp-chips">
						{report.missingControls.map((ctrl) => (
							<Chip key={ctrl} tone="red">
								{ctrl}
							</Chip>
						))}
					</div>
				</Section>
			)}

			{report.evidence.length > 0 && (
				<Section kicker={t("kickers.evidence")} title={t("evidence")}>
					<div className="grid gap-2.5 lg:grid-cols-2">
						{report.evidence.map((item) => (
							<Panel key={item.id} rail tone={STATUS_TONES[item.status]}>
								<div className="flex items-start justify-between gap-2">
									<span className="wp-title truncate text-sm">{item.title}</span>
									<Chip tone={STATUS_TONES[item.status]}>
										{t(`statuses.${item.status}`, { defaultValue: item.status })}
									</Chip>
								</div>
								<p className="wp-meta mt-1">
									{item.controlId} ·{" "}
									{t(`evidenceTypes.${item.evidenceType}`, {
										defaultValue: item.evidenceType.replaceAll("_", " "),
									})}
									{item.source ? ` · ${item.source}` : ""}
								</p>
							</Panel>
						))}
					</div>
				</Section>
			)}

			{report.summary && (
				<Notice tone={tone} icon={ClipboardCheck}>
					{report.summary}
				</Notice>
			)}
		</>
	);
}
