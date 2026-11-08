import type { IncidentSource } from "@shared/types/self-healing";
import { useTranslation } from "react-i18next";
import { Panel } from "../charter";
import { useSelfHealingStore } from "@/stores/self-healing-store";
import { IncidentCard } from "./IncidentCard";

interface ProductionTabProps {
	readonly projectPath: string;
}

const APM_SOURCES: Array<{
	source: IncidentSource;
	label: string;
	icon: string;
}> = [
	{ source: "sentry", label: "Sentry", icon: "\uD83D\uDC1B" },
	{ source: "datadog", label: "Datadog", icon: "\uD83D\uDC15" },
	{ source: "cloudwatch", label: "CloudWatch", icon: "\u2601\uFE0F" },
	{ source: "new_relic", label: "New Relic", icon: "\uD83D\uDC8E" },
	{ source: "pagerduty", label: "PagerDuty", icon: "\uD83D\uDCDF" },
];

export function ProductionTab({ projectPath }: ProductionTabProps) {
	const { t } = useTranslation(["selfHealing"]);
	const {
		incidents,
		productionConfig,
		setProductionConfig,
		triggerFix,
		dismissIncident,
		retryIncident,
	} = useSelfHealingStore();

	const productionIncidents = incidents.filter((i) => i.mode === "production");

	return (
		<div className="space-y-4">
			{/* Config panel */}
			<Panel>
				<h3 className="wp-kicker mb-3 block">
					{t("selfHealing:productionConfig")}
				</h3>
				<div className="grid grid-cols-2 gap-4 mb-4">
					<label className="flex items-center gap-2 text-sm text-muted-foreground">
						<input
							type="checkbox"
							checked={productionConfig.enabled}
							onChange={(e) =>
								setProductionConfig(projectPath, { enabled: e.target.checked })
							}
							className="rounded"
						/>
						{t("selfHealing:productionEnabled")}
					</label>
					<label className="flex items-center gap-2 text-sm text-muted-foreground">
						<input
							type="checkbox"
							checked={productionConfig.autoAnalyze}
							onChange={(e) =>
								setProductionConfig(projectPath, {
									autoAnalyze: e.target.checked,
								})
							}
							className="rounded"
						/>
						{t("selfHealing:autoAnalyze")}
					</label>
					<label className="flex items-center gap-2 text-sm text-muted-foreground">
						<input
							type="checkbox"
							checked={productionConfig.autoFix}
							onChange={(e) =>
								setProductionConfig(projectPath, { autoFix: e.target.checked })
							}
							className="rounded"
						/>
						{t("selfHealing:autoFixProduction")}
					</label>
				</div>
			</Panel>

			{/* Connected sources panel */}
			<Panel>
				<h3 className="wp-kicker mb-3 block">
					{t("selfHealing:connectedSources")}
				</h3>
				<div className="grid grid-cols-5 gap-2">
					{APM_SOURCES.map(({ source, label, icon }) => {
						const isConnected =
							productionConfig.connectedSources.includes(source);
						return (
							<button
								key={source}
								type="button"
								className="wp-card wp-card-pad wp-rail wp-step flex flex-col items-center gap-1"
								data-active={isConnected ? "true" : undefined}
							>
								<span className="text-xl">{icon}</span>
								<span className="text-xs text-muted-foreground">
									{label}
								</span>
								<span
									className={`text-xs ${isConnected ? "text-success" : "text-muted-foreground"}`}
								>
									{isConnected
										? t("selfHealing:connected")
										: t("selfHealing:disconnected")}
								</span>
							</button>
						);
					})}
				</div>
				<p className="wp-meta mt-3">
					{t("selfHealing:productionDescription")}
				</p>
			</Panel>

			{/* Live incidents */}
			<div>
				<h3 className="wp-kicker mb-2 block">
					{t("selfHealing:liveIncidents")} ({productionIncidents.length})
				</h3>
				{productionIncidents.length === 0 ? (
					<Panel className="text-center">
						<p className="wp-muted text-sm">
							{t("selfHealing:noProductionIncidents")}
						</p>
					</Panel>
				) : (
					<div className="space-y-2">
						{productionIncidents.map((incident) => (
							<IncidentCard
								key={incident.id}
								incident={incident}
								onTriggerFix={(id) => triggerFix(projectPath, id)}
								onDismiss={(id) => dismissIncident(projectPath, id)}
								onRetry={(id) => retryIncident(projectPath, id)}
							/>
						))}
					</div>
				)}
			</div>
		</div>
	);
}
