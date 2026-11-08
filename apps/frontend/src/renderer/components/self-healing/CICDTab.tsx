import { useTranslation } from "react-i18next";
import { Panel } from "../charter";
import { useSelfHealingStore } from "@/stores/self-healing-store";
import { HealingTimeline } from "./HealingTimeline";
import { IncidentCard } from "./IncidentCard";

interface CICDTabProps {
	readonly projectPath: string;
}

export function CICDTab({ projectPath }: CICDTabProps) {
	const { t } = useTranslation(["selfHealing", "common"]);
	const {
		incidents,
		activeOperations,
		cicdConfig,
		setCICDConfig,
		triggerFix,
		dismissIncident,
		retryIncident,
	} = useSelfHealingStore();

	const cicdIncidents = incidents.filter((i) => i.mode === "cicd");
	const cicdOperations = activeOperations.filter(
		(o) => o.incident?.mode === "cicd",
	);

	return (
		<div className="space-y-4">
			{/* Config panel */}
			<Panel>
				<h3 className="wp-kicker mb-3 block">
					{t("selfHealing:cicdConfig")}
				</h3>
				<div className="grid grid-cols-2 gap-4">
					<label className="flex items-center gap-2 text-sm text-muted-foreground">
						<input
							type="checkbox"
							checked={cicdConfig.enabled}
							onChange={(e) =>
								setCICDConfig(projectPath, { enabled: e.target.checked })
							}
							className="rounded"
						/>
						{t("selfHealing:cicdEnabled")}
					</label>
					<label className="flex items-center gap-2 text-sm text-muted-foreground">
						<input
							type="checkbox"
							checked={cicdConfig.autoFixEnabled}
							onChange={(e) =>
								setCICDConfig(projectPath, { autoFixEnabled: e.target.checked })
							}
							className="rounded"
						/>
						{t("selfHealing:autoFix")}
					</label>
					<label className="flex items-center gap-2 text-sm text-muted-foreground">
						<input
							type="checkbox"
							checked={cicdConfig.autoCreatePR}
							onChange={(e) =>
								setCICDConfig(projectPath, { autoCreatePR: e.target.checked })
							}
							className="rounded"
						/>
						{t("selfHealing:autoCreatePR")}
					</label>
				</div>
			</Panel>

			{/* Active operations */}
			{cicdOperations.length > 0 && (
				<div>
					<h3 className="wp-kicker mb-2 block">
						{t("selfHealing:activeOperations")}
					</h3>
					<div className="space-y-2">
						{cicdOperations.map((op) => (
							<HealingTimeline key={op.id} operation={op} />
						))}
					</div>
				</div>
			)}

			{/* Incident list */}
			<div>
				<h3 className="wp-kicker mb-2 block">
					{t("selfHealing:incidents")} ({cicdIncidents.length})
				</h3>
				{cicdIncidents.length === 0 ? (
					<Panel className="text-center">
						<p className="wp-muted text-sm">
							{t("selfHealing:noIncidents")}
						</p>
						<p className="wp-meta mt-1">
							{t("selfHealing:cicdDescription")}
						</p>
					</Panel>
				) : (
					<div className="space-y-2">
						{cicdIncidents.map((incident) => (
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
