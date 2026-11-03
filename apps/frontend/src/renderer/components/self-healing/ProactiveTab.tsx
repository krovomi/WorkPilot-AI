import { useTranslation } from "react-i18next";
import { useSelfHealingStore } from "@/stores/self-healing-store";
import { FragilityChart } from "./FragilityChart";
import { IncidentCard } from "./IncidentCard";

import { Input } from "../ui/input";
import { NativeSelect } from "../ui/native-select";
interface ProactiveTabProps {
	readonly projectPath: string;
}

export function ProactiveTab({ projectPath }: ProactiveTabProps) {
	const { t } = useTranslation(["selfHealing"]);
	const {
		incidents,
		fragilityReports,
		proactiveConfig,
		setProactiveConfig,
		isScanning,
		triggerProactiveScan,
		triggerFix,
		dismissIncident,
	} = useSelfHealingStore();

	const proactiveIncidents = incidents.filter((i) => i.mode === "proactive");

	return (
		<div className="space-y-4">
			{/* Config + scan trigger */}
			<div className="rounded-lg border border-border bg-card p-4">
				<div className="flex items-center justify-between mb-3">
					<h3 className="text-sm font-medium text-foreground">
						{t("selfHealing:proactiveConfig")}
					</h3>
					<button
						type="button"
						onClick={() => triggerProactiveScan(projectPath)}
						disabled={isScanning}
						className="text-xs px-3 py-1.5 rounded bg-primary text-white hover:opacity-80 disabled:opacity-50"
					>
						{isScanning ? t("selfHealing:scanning") : t("selfHealing:runScan")}
					</button>
				</div>
				<div className="grid grid-cols-2 gap-4">
					<label className="flex items-center gap-2 text-sm text-muted-foreground">
						<input
							type="checkbox"
							checked={proactiveConfig.enabled}
							onChange={(e) =>
								setProactiveConfig(projectPath, { enabled: e.target.checked })
							}
							className="rounded"
						/>
						{t("selfHealing:proactiveEnabled")}
					</label>
					<label className="flex items-center gap-2 text-sm text-muted-foreground">
						<input
							type="checkbox"
							checked={proactiveConfig.autoGenerateTests}
							onChange={(e) =>
								setProactiveConfig(projectPath, {
									autoGenerateTests: e.target.checked,
								})
							}
							className="rounded"
						/>
						{t("selfHealing:autoGenerateTests")}
					</label>
					<div className="flex items-center gap-2 text-sm text-muted-foreground">
						<span>{t("selfHealing:riskThreshold")}:</span>
						<Input
							type="number"
							min={0}
							max={100}
							value={proactiveConfig.riskThreshold}
							onChange={(e) =>
								setProactiveConfig(projectPath, {
									riskThreshold: Number(e.target.value),
								})
							}
							className="w-16 px-2 py-0.5 text-sm h-auto"
						/>
					</div>
					<div className="flex items-center gap-2 text-sm text-muted-foreground">
						<span>{t("selfHealing:scanFrequency")}:</span>
						<NativeSelect
							value={proactiveConfig.scanFrequency}
							onChange={(e) =>
								setProactiveConfig(projectPath, {
									scanFrequency: e.target.value as
										| "daily"
										| "weekly"
										| "on_push",
								})
							}
							className="px-2 py-0.5 text-sm h-auto"
						>
							<option value="daily">{t("selfHealing:daily")}</option>
							<option value="weekly">{t("selfHealing:weekly")}</option>
							<option value="on_push">{t("selfHealing:onPush")}</option>
						</NativeSelect>
					</div>
				</div>
			</div>

			{/* Fragility chart */}
			<FragilityChart reports={fragilityReports} />

			{/* Fragility table */}
			{fragilityReports.length > 0 && (
				<div className="rounded-lg border border-border bg-card overflow-hidden">
					<table className="w-full text-sm">
						<thead>
							<tr className="border-b border-border bg-muted">
								<th className="text-left p-2 text-xs font-medium text-muted-foreground">
									{t("selfHealing:file")}
								</th>
								<th className="text-right p-2 text-xs font-medium text-muted-foreground">
									{t("selfHealing:risk")}
								</th>
								<th className="text-right p-2 text-xs font-medium text-muted-foreground">
									{t("selfHealing:complexity")}
								</th>
								<th className="text-right p-2 text-xs font-medium text-muted-foreground">
									{t("selfHealing:churn")}
								</th>
								<th className="text-right p-2 text-xs font-medium text-muted-foreground">
									{t("selfHealing:coverage")}
								</th>
							</tr>
						</thead>
						<tbody>
							{fragilityReports.map((report) => (
								<tr
									key={report.file_path}
									className="border-b border-border last:border-0 hover:bg-muted"
								>
									<td className="p-2 font-mono text-xs text-foreground truncate max-w-[300px]">
										{report.file_path}
									</td>
									<td className="p-2 text-right text-xs font-semibold text-foreground">
										{report.risk_score.toFixed(0)}%
									</td>
									<td className="p-2 text-right text-xs text-muted-foreground">
										{report.cyclomatic_complexity.toFixed(0)}
									</td>
									<td className="p-2 text-right text-xs text-muted-foreground">
										{report.git_churn_count}
									</td>
									<td className="p-2 text-right text-xs text-muted-foreground">
										{report.test_coverage_percent.toFixed(0)}%
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}

			{/* Proactive incidents */}
			{proactiveIncidents.length > 0 && (
				<div>
					<h3 className="text-sm font-medium text-foreground mb-2">
						{t("selfHealing:suggestedFixes")} ({proactiveIncidents.length})
					</h3>
					<div className="space-y-2">
						{proactiveIncidents.map((incident) => (
							<IncidentCard
								key={incident.id}
								incident={incident}
								onTriggerFix={(id) => triggerFix(projectPath, id)}
								onDismiss={(id) => dismissIncident(projectPath, id)}
							/>
						))}
					</div>
				</div>
			)}
		</div>
	);
}
