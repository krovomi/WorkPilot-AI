/**
 * #3.9 Architecture Drift panel.
 *
 * Three actions: scan now, save current as baseline, compare against baseline.
 * Shows new / resolved / persistent violations + severity badge, and the
 * violations themselves (type, file, imported target), not only their count.
 */

import { Info } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ArchViolation } from "../../../preload/api/modules/phase35-features-api";
import { useArchDriftStore } from "../../stores/phase35-stores";
import { Notice } from "../charter";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { PanelShell } from "./_panel-shell";

interface ArchDriftPanelProps {
	projectPath: string;
}

const SEV_COLOR: Record<string, string> = {
	none: "bg-muted text-muted-foreground",
	low: "bg-warning/20 text-warning border-warning/40",
	medium: "bg-orange-500/20 text-orange-700 border-orange-500/40",
	high: "bg-destructive/20 text-destructive border-destructive/40",
	critical: "bg-destructive/30 text-destructive border-destructive/40",
};

/** How many findings a list shows before it stops; the counts stay exact. */
const MAX_LISTED = 50;

function ViolationList({ title, items }: { title: string; items: ArchViolation[] }) {
	const { t } = useTranslation("phase35");
	if (items.length === 0) return null;
	return (
		<div>
			<div className="mb-1 font-medium">
				{title} ({items.length})
			</div>
			<ul className="max-h-72 space-y-1 overflow-auto text-xs">
				{items.slice(0, MAX_LISTED).map((v, i) => (
					<li key={v.fingerprint ?? `${v.type}-${v.file}-${v.line ?? 0}-${i}`} className="rounded border p-2">
						<div className="flex flex-wrap items-center gap-2">
							<Badge className={SEV_COLOR[v.severity === "error" ? "high" : "low"]}>
								{t(`archDrift.violationTypes.${v.type}` as never, { defaultValue: v.type })}
							</Badge>
							<span className="font-mono">
								{v.file}
								{v.line ? `:${v.line}` : ""}
							</span>
							{v.import_target && (
								<span className="font-mono text-muted-foreground">→ {v.import_target}</span>
							)}
						</div>
						{v.rule && <div className="mt-1 font-mono text-muted-foreground">{v.rule}</div>}
					</li>
				))}
			</ul>
		</div>
	);
}

export function ArchDriftPanel({ projectPath }: ArchDriftPanelProps) {
	const { t } = useTranslation("phase35");
	const {
		phase,
		error,
		scanReport,
		driftReport,
		configSource,
		baselineCount,
		scan,
		saveBaseline,
		compare,
	} = useArchDriftStore();
	const isRunning = phase === "running";

	return (
		<PanelShell
			title={t("archDrift.title")}
			subtitle={t("archDrift.subtitle")}
			error={error}
			actions={
				<>
					<Button
						size="sm"
						variant="outline"
						onClick={() => scan(projectPath)}
						disabled={isRunning || !projectPath}
					>
						{t("archDrift.scan")}
					</Button>
					<Button
						size="sm"
						variant="outline"
						onClick={() => saveBaseline(projectPath)}
						disabled={isRunning || !projectPath}
					>
						{t("archDrift.saveBaseline")}
					</Button>
					<Button
						size="sm"
						onClick={() => compare(projectPath)}
						disabled={isRunning || !projectPath}
					>
						{t("archDrift.compare")}
					</Button>
				</>
			}
		>
			{!projectPath && (
				<p className="text-sm text-muted-foreground">
					{t("common.projectPathRequired")}
				</p>
			)}
			{configSource && (
				<Notice tone={configSource === "none" ? "amber" : "accent"} icon={Info} className="mb-3">
					{t(`archDrift.configSource.${configSource}` as never, { defaultValue: configSource })}
				</Notice>
			)}
			{baselineCount !== null && (
				<p className="mb-3 text-sm text-muted-foreground">
					{t("archDrift.baselineSaved", { count: baselineCount })}
				</p>
			)}
			{scanReport && (
				<div className="mb-3 space-y-3 text-sm">
					<div className="flex flex-wrap items-center gap-3">
						<span className="font-medium">{t("common.status")}:</span>
						<Badge
							className={
								scanReport.status === "approved"
									? "bg-success/20 text-success border-success/40"
									: "bg-destructive/20 text-destructive border-destructive/40"
							}
						>
							{scanReport.status === "approved"
								? t("archDrift.statusApproved")
								: t("archDrift.statusRejected")}
						</Badge>
						{typeof scanReport.files_analyzed === "number" && (
							<span className="text-muted-foreground">
								{t("archDrift.filesAnalyzed", { count: scanReport.files_analyzed })}
							</span>
						)}
					</div>
					<ViolationList title={t("archDrift.violationsTitle")} items={scanReport.violations} />
					<ViolationList title={t("archDrift.warningsTitle")} items={scanReport.warnings} />
				</div>
			)}
			{driftReport && !driftReport.has_baseline && (
				<p className="text-sm text-muted-foreground">{t("archDrift.noBaseline")}</p>
			)}
			{driftReport?.has_baseline && (
				<div className="space-y-3 text-sm">
					<div className="flex items-center gap-3">
						<span className="font-medium">{t("archDrift.severity")}:</span>
						<Badge className={SEV_COLOR[driftReport.severity] ?? "bg-muted"}>
							{t(`common.severity.${driftReport.severity}` as never, {
								defaultValue: driftReport.severity,
							})}
						</Badge>
					</div>
					<div className="grid grid-cols-3 gap-3">
						<div className="rounded border p-2">
							<div className="text-xs text-muted-foreground">
								{t("archDrift.newViolations")}
							</div>
							<div className="text-2xl font-semibold">
								{driftReport.new_violations.length}
							</div>
						</div>
						<div className="rounded border p-2">
							<div className="text-xs text-muted-foreground">
								{t("archDrift.resolvedViolations")}
							</div>
							<div className="text-2xl font-semibold">
								{driftReport.resolved_violations.length}
							</div>
						</div>
						<div className="rounded border p-2">
							<div className="text-xs text-muted-foreground">
								{t("archDrift.persistentViolations")}
							</div>
							<div className="text-2xl font-semibold">
								{driftReport.persistent_violations.length}
							</div>
						</div>
					</div>
					<ViolationList title={t("archDrift.newViolations")} items={driftReport.new_violations} />
					<ViolationList
						title={t("archDrift.resolvedViolations")}
						items={driftReport.resolved_violations}
					/>
				</div>
			)}
		</PanelShell>
	);
}
