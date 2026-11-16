/**
 * Root cause clusters (#372): open production incidents whose most suspect
 * commit is the same. One fix covers the cluster, and it carries the highest
 * severity among them.
 */
import type { IncidentCluster, IncidentSeverity } from "@shared/types/self-healing";
import { Network } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Panel, type Tone } from "../charter";

const SEVERITY_TONE: Record<IncidentSeverity, Tone> = {
	critical: "red",
	high: "orange",
	medium: "amber",
	low: "blue",
	info: "muted",
};

export function IncidentClusters({ clusters }: { readonly clusters: IncidentCluster[] }) {
	const { t } = useTranslation(["selfHealing"]);
	if (clusters.length === 0) return null;
	return (
		<div data-testid="incident-clusters">
			<h3 className="wp-kicker mb-2 flex items-center gap-1.5">
				<Network className="h-3.5 w-3.5" aria-hidden="true" />
				{t("selfHealing:groups.clustersTitle")}
			</h3>
			<div className="space-y-2">
				{clusters.map((cluster) => (
					<Panel key={cluster.id} rail tone={SEVERITY_TONE[cluster.severity]}>
						<div className="flex items-center gap-2">
							<span className="wp-kicker">{cluster.severity}</span>
							<code className="text-xs">{cluster.commit.slice(0, 8)}</code>
							<span className="truncate text-xs text-foreground" title={cluster.subject}>
								{cluster.subject}
							</span>
						</div>
						<p className="wp-meta mt-1">
							{t("selfHealing:groups.clusterLine", {
								count: cluster.incident_ids.length,
								occurrences: cluster.occurrences,
								users: cluster.affected_users,
							})}{" "}
							{t("selfHealing:groups.oneFix")}
						</p>
					</Panel>
				))}
			</div>
		</div>
	);
}
