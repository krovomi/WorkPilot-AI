import { AlertTriangle, Leaf, Play, RotateCcw, Square } from "lucide-react";
import type React from "react";
import { useTranslation } from "react-i18next";
import { useCarbonProfilerStore } from "../../stores/carbon-profiler-store";
import type { CarbonReport } from "../../../shared/types/carbon-profiler";
import {
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

interface CarbonReportViewProps {
	readonly projectPath?: string;
}

/** Energy and CO₂ of the project's LLM calls and CI runs, from its ledger. */
export function CarbonReportView({
	projectPath,
}: CarbonReportViewProps): React.ReactElement {
	const { t } = useTranslation(["carbonProfiler", "navigation"]);

	const phase = useCarbonProfilerStore((s) => s.phase);
	const status = useCarbonProfilerStore((s) => s.status);
	const report = useCarbonProfilerStore((s) => s.report);
	const error = useCarbonProfilerStore((s) => s.error);
	const startScan = useCarbonProfilerStore((s) => s.startScan);
	const cancelScan = useCarbonProfilerStore((s) => s.cancelScan);
	const reset = useCarbonProfilerStore((s) => s.reset);

	const isScanning = phase === "scanning";

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
						{report && !isScanning && (
							<CharterButton variant="ghost" icon={RotateCcw} onClick={reset}>
								{t("carbonProfiler:actions.reset")}
							</CharterButton>
						)}
						{isScanning ? (
							<CharterButton variant="danger" icon={Square} onClick={() => cancelScan()}>
								{t("carbonProfiler:actions.cancel")}
							</CharterButton>
						) : (
							<CharterButton
								variant="primary"
								icon={Play}
								onClick={() => projectPath && startScan(projectPath)}
								disabled={!projectPath}
							>
								{t("carbonProfiler:actions.runScan")}
							</CharterButton>
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
					<ReportBody report={report} />
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

function ReportBody({ report }: { readonly report: CarbonReport }): React.ReactElement {
	const { t } = useTranslation("carbonProfiler");
	return (
		<>
			<Stats>
				<Stat label={t("totalEnergy")} value={`${report.totalKwh.toFixed(3)} kWh`} tone="amber" />
				<Stat label={t("co2Emissions")} value={`${report.totalCo2G.toFixed(1)} g`} tone="red" />
				<Stat label={t("records")} value={report.records.length} tone="blue" />
			</Stats>
			<p className="wp-meta">
				{t("period", { start: report.periodStart || "—", end: report.periodEnd || "—" })}
			</p>

			<Breakdown kicker={t("kickers.providers")} title={t("co2ByProvider")} values={report.byProvider} />
			<Breakdown kicker={t("kickers.models")} title={t("co2ByModel")} values={report.byModel} />

			{report.records.length > 0 && (
				<Section kicker={t("kickers.records")} title={t("recentRecords")}>
					<div className="grid gap-2">
						{report.records.slice(0, 20).map((rec) => (
							<Panel
								key={`${rec.timestamp}-${rec.source}-${rec.model || rec.provider}`}
								className="flex flex-wrap items-center gap-3 text-xs"
							>
								<Chip tone={rec.source === "ci_cd" ? "violet" : "blue"}>{rec.source}</Chip>
								<span className="min-w-0 flex-1 truncate font-mono">{rec.model || rec.provider}</span>
								<span className="font-mono">{rec.kwh.toFixed(4)} kWh</span>
								<span className="font-mono">{rec.co2G.toFixed(2)} g</span>
								<span className="wp-meta">{rec.durationS.toFixed(1)} s</span>
							</Panel>
						))}
					</div>
				</Section>
			)}

			{report.summary && <Notice tone="green" icon={Leaf}>{report.summary}</Notice>}
		</>
	);
}
