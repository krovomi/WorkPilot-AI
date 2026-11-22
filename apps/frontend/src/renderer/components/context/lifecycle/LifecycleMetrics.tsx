import { Activity, AlertTriangle } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { MemoryLifecycleMetrics } from "../../../../shared/types";
import { Card, CardContent, CardHeader, CardTitle } from "../../ui/card";

interface LifecycleMetricsProps {
	readonly metrics: MemoryLifecycleMetrics;
}

/** How the lifecycle behaves: restores, automatic removals, pins, conflicts, consensus notes. */
export function LifecycleMetrics({ metrics }: LifecycleMetricsProps) {
	const { t } = useTranslation(["context"]);
	const lines = [
		t("context:lifecycle.metrics.restores", { count: metrics.restores_week }),
		t("context:lifecycle.metrics.automaticForgets", { count: metrics.automatic_forgets_week }),
		t("context:lifecycle.metrics.pinRate", {
			rate: Math.round(metrics.pin_rate * 100),
			pinned: metrics.pinned,
			live: metrics.live,
		}),
		t("context:lifecycle.metrics.conflicts", {
			count: metrics.conflicts_month,
			auto: metrics.auto_settled_month,
			resolved: metrics.resolved_month,
		}),
		metrics.mean_resolution_hours === null
			? null
			: t("context:lifecycle.metrics.resolution", { hours: metrics.mean_resolution_hours }),
		t("context:lifecycle.metrics.views", { count: metrics.history_views }),
		t("context:lifecycle.metrics.consensus", {
			count: metrics.consensus_month ?? 0,
			live: metrics.consensus_live ?? 0,
		}),
	].filter((line): line is string => line !== null);
	return (
		<Card data-testid="memory-lifecycle-metrics">
			<CardHeader className="pb-3">
				<CardTitle className="flex items-center gap-2 text-base">
					<Activity className="h-4 w-4" />
					{t("context:lifecycle.metrics.title")}
				</CardTitle>
			</CardHeader>
			<CardContent className="space-y-2 text-xs text-muted-foreground">
				{metrics.too_aggressive && (
					<p role="status" className="flex items-center gap-2 text-warning">
						<AlertTriangle className="h-3.5 w-3.5" />
						{t("context:lifecycle.metrics.tooAggressive")}
					</p>
				)}
				<ul className="space-y-1">
					{lines.map((line) => (
						<li key={line}>{line}</li>
					))}
				</ul>
			</CardContent>
		</Card>
	);
}
