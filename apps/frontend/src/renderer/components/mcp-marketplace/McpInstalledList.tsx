/**
 * MCP Installed Servers List
 *
 * The selected project's MCP servers, as its agents get them: every custom
 * server of `.workpilot/.env`, with the agents that use it. A server added
 * by hand in Agent Tools shows here too; which agents use a server is
 * changed in Agent Tools.
 */

import { Globe, Power, Terminal, Trash2, Wrench } from "lucide-react";
import { useTranslation } from "react-i18next";
import { agentsUsingServer } from "../../../shared/mcp-catalog/install";
import {
	uninstallMarketplaceServer,
	useMcpMarketplaceStore,
} from "../../stores/mcp-marketplace-store";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

export function McpInstalledList() {
	const { t } = useTranslation(["common"]);
	const { installed, agentOverrides, projectId, isInstalledLoading, catalog } =
		useMcpMarketplaceStore();

	if (isInstalledLoading) {
		return (
			<div className="flex-1 flex items-center justify-center">
				<div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
			</div>
		);
	}

	if (!projectId || installed.length === 0) {
		return (
			<div className="flex-1 flex flex-col items-center justify-center text-muted-foreground px-6">
				<Power className="h-16 w-16 mb-4 opacity-20" />
				<h2 className="text-lg font-medium mb-1">
					{projectId
						? t("mcpMarketplace.installedTab.empty")
						: t("mcpMarketplace.noProject")}
				</h2>
				{projectId && (
					<p className="text-sm text-center max-w-md">
						{t("mcpMarketplace.installedTab.emptyHint")}
					</p>
				)}
			</div>
		);
	}

	return (
		<div className="flex-1 overflow-auto p-6">
			<div className="space-y-3 max-w-4xl mx-auto">
				{installed.map((server) => {
					const catalogInfo = catalog.find((s) => s.id === server.id);
					const color = catalogInfo?.color || "#6B7280";
					const agents = agentsUsingServer(agentOverrides, server.id);
					const agentNames = agents
						.map((agent) =>
							t(`mcpMarketplace.agents.${agent}`, { defaultValue: agent }),
						)
						.join(", ");

					return (
						<div
							key={server.id}
							className="flex items-center gap-4 p-4 rounded-xl border border-border bg-card hover:border-border/80 transition-colors"
						>
							<div
								className="shrink-0 flex items-center justify-center w-10 h-10 rounded-lg text-white text-sm font-bold"
								style={{ backgroundColor: color }}
							>
								{server.name.charAt(0)}
							</div>

							<div className="flex-1 min-w-0">
								<div className="flex items-center gap-2">
									<h3 className="font-medium text-sm">{server.name}</h3>
									{!catalogInfo && (
										<Badge variant="outline" className="text-[10px] gap-1">
											<Wrench className="h-3 w-3" />
											{t("mcpMarketplace.installedTab.custom")}
										</Badge>
									)}
								</div>
								<div className="flex items-center gap-3 text-xs text-muted-foreground mt-1">
									<span className="flex items-center gap-1">
										{server.type === "command" ? (
											<Terminal className="h-3 w-3" />
										) : (
											<Globe className="h-3 w-3" />
										)}
										{server.type === "command" ? server.command : server.type}
									</span>
									<span>
										{agents.length > 0
											? t("mcpMarketplace.installedTab.usedBy", {
													agents: agentNames,
												})
											: t("mcpMarketplace.installedTab.notUsed")}
									</span>
								</div>
							</div>

							<Button
								variant="ghost"
								size="icon"
								className="h-8 w-8 shrink-0 text-destructive hover:text-destructive"
								onClick={() => uninstallMarketplaceServer(projectId, server.id)}
								title={t("mcpMarketplace.uninstall")}
							>
								<Trash2 className="h-4 w-4" />
							</Button>
						</div>
					);
				})}
			</div>
		</div>
	);
}
