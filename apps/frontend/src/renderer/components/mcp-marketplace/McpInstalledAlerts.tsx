/**
 * What the daily check found on an installed server (issue #369, lot 2):
 * a badge on its row, and the alerts with a button to acknowledge them. A
 * server outside the catalog is never read on the network: it is marked
 * not verifiable. The check itself runs in the main process
 * (`main/mcp-security/installed-watch.ts`).
 */

import { AlertTriangle, Check, ShieldQuestion } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { McpInstalledServerWatch } from "../../../shared/types/mcp-security";
import { formatAppDateTime } from "../../lib/date-format";
import { acknowledgeServerAlerts } from "../../stores/mcp-marketplace-store";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

export function McpWatchBadge({ watch }: { readonly watch: McpInstalledServerWatch }) {
	const { t } = useTranslation(["common"]);
	if (watch.alerts.length > 0) {
		return (
			<Badge
				variant="outline"
				className="text-3xs gap-1 border-destructive/40 text-destructive"
				data-testid="mcp-watch-alert-badge"
			>
				<AlertTriangle className="h-3 w-3" />
				{t("mcpMarketplace.watch.alertCount", { count: watch.alerts.length })}
			</Badge>
		);
	}
	if (watch.status === "unverifiable") {
		return (
			<Badge
				variant="outline"
				className="text-3xs gap-1 text-muted-foreground"
				title={t("mcpMarketplace.watch.unverifiableHint")}
			>
				<ShieldQuestion className="h-3 w-3" />
				{t("mcpMarketplace.watch.unverifiable")}
			</Badge>
		);
	}
	return null;
}

function statusLine(watch: McpInstalledServerWatch): { key: string; date?: string } | null {
	switch (watch.status) {
		case "watched":
			return watch.checkedAt
				? { key: "mcpMarketplace.watch.status.watched", date: formatAppDateTime(watch.checkedAt) }
				: null;
		case "unverifiable":
			return { key: "mcpMarketplace.watch.unverifiableHint" };
		default:
			return { key: `mcpMarketplace.watch.status.${watch.status}` };
	}
}

/** The alerts of `watch` and where its check stands. */
export function McpWatchDetails({
	watch,
	projectId,
}: {
	readonly watch: McpInstalledServerWatch;
	readonly projectId: string;
}) {
	const { t } = useTranslation(["common"]);
	const line = statusLine(watch);
	return (
		<div className="mt-2 space-y-1 text-xs text-muted-foreground" data-testid="mcp-watch-details">
			{line && <p>{t(line.key, line.date ? { date: line.date } : {})}</p>}
			{watch.alerts.length > 0 && (
				<div className="space-y-1 rounded border border-destructive/30 p-2">
					<div className="flex items-center gap-2">
						<span className="font-medium text-destructive">{t("mcpMarketplace.watch.title")}</span>
						<Button
							variant="ghost"
							size="sm"
							className="ml-auto h-6 px-2 text-3xs"
							onClick={() => void acknowledgeServerAlerts(projectId, watch.serverId)}
						>
							<Check className="h-3 w-3" />
							{t("mcpMarketplace.watch.acknowledge")}
						</Button>
					</div>
					<ul className="space-y-0.5">
						{watch.alerts.map((alert) => (
							<li key={alert.id} className="flex items-start gap-1 text-warning">
								<AlertTriangle className="h-3 w-3 shrink-0 mt-0.5" />
								<span>
									{t(`mcpMarketplace.watch.alerts.${alert.kind}`, alert.values ?? {})}{" "}
									<span className="text-muted-foreground">
										{t("mcpMarketplace.watch.detectedAt", {
											date: formatAppDateTime(alert.detectedAt),
										})}
									</span>
								</span>
							</li>
						))}
					</ul>
				</div>
			)}
		</div>
	);
}
