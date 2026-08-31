/**
 * Settings for one MCP server, opened from the server itself.
 *
 * The MCP overview listed every server an agent has and let you remove one,
 * but a server's own settings lived in a separate section further down the
 * page — so "Context7 is on this agent" and "here is Context7's API key" were
 * two places with nothing linking them. Clicking the server is the obvious
 * gesture; this is what it opens.
 *
 * Only what the project actually stores is offered. A server whose credentials
 * live in the integrations screen (GitHub, Jira, Sentry…) says so rather than
 * showing a switch that would write nothing.
 */

import type { ProjectEnvConfig } from "@shared/types";
import { ExternalLink, Server } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Switch } from "./ui/switch";

type McpServers = NonNullable<ProjectEnvConfig["mcpServers"]>;
type ToggleKey = keyof McpServers;

/** Server id -> the project setting that switches it on and off. */
const TOGGLE_BY_SERVER: Record<string, ToggleKey> = {
	context7: "context7Enabled",
	"graphiti-memory": "graphitiEnabled",
	linear: "linearMcpEnabled",
	electron: "electronEnabled",
	puppeteer: "puppeteerEnabled",
	"chrome-devtools": "chromeDevtoolsEnabled",
};

/** Servers configured by an API key on the integrations screen, not here. */
const CONFIGURED_IN_INTEGRATIONS = new Set([
	"github",
	"gitlab",
	"jira",
	"azure-devops",
	"sentry",
	"slack",
	"postman",
	"teams",
	"brave-search",
]);

export interface McpServerSettingsDialogProps {
	readonly open: boolean;
	readonly onOpenChange: (open: boolean) => void;
	readonly serverId: string | null;
	readonly serverName: string;
	readonly serverDescription?: string;
	readonly icon?: React.ElementType;
	readonly mcpServers: McpServers;
	readonly envConfig: ProjectEnvConfig | null;
	readonly onUpdate: (key: ToggleKey, value: boolean | string) => void;
}

export function McpServerSettingsDialog({
	open,
	onOpenChange,
	serverId,
	serverName,
	serverDescription,
	icon: Icon = Server,
	mcpServers,
	envConfig,
	onUpdate,
}: McpServerSettingsDialogProps) {
	const { t } = useTranslation(["settings"]);
	if (!serverId) return null;

	const toggleKey = TOGGLE_BY_SERVER[serverId];
	// A toggle the user cannot honour is worse than no toggle: Graphiti and
	// Linear only start when their own configuration exists, so the switch is
	// disabled and the reason is stated instead of failing at build time.
	const requirementMet =
		serverId === "graphiti-memory"
			? Boolean(envConfig?.graphitiProviderConfig)
			: serverId === "linear"
				? Boolean(envConfig?.linearEnabled)
				: true;
	const enabled =
		toggleKey === "electronEnabled" ||
		toggleKey === "puppeteerEnabled" ||
		toggleKey === "chromeDevtoolsEnabled"
			? mcpServers[toggleKey] === true
			: mcpServers[toggleKey] !== false;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<Icon className="h-4 w-4 text-muted-foreground" />
						{serverName}
					</DialogTitle>
					{serverDescription && (
						<DialogDescription>{serverDescription}</DialogDescription>
					)}
				</DialogHeader>

				<div className="space-y-4 py-2">
					{toggleKey && (
						<div className="flex items-center justify-between gap-4 rounded-lg border border-border p-3">
							<div className="space-y-0.5">
								<p className="text-sm font-medium">
									{t("mcp.serverDialog.enabled")}
								</p>
								<p className="text-xs text-muted-foreground">
									{requirementMet
										? t("mcp.serverDialog.enabledHint")
										: t("mcp.serverDialog.requirementMissing")}
								</p>
							</div>
							<Switch
								checked={enabled && requirementMet}
								disabled={!requirementMet}
								onCheckedChange={(checked) => onUpdate(toggleKey, checked)}
							/>
						</div>
					)}

					{serverId === "context7" && (
						<div className="space-y-1.5">
							<p className="text-sm font-medium">
								{t("mcp.servers.context7.apiKeyPlaceholder")}
							</p>
							<Input
								type="password"
								placeholder="ctx7sk-..."
								defaultValue={mcpServers.context7ApiKey || ""}
								onBlur={(e) => {
									const value = e.target.value.trim();
									if (value !== (mcpServers.context7ApiKey || "")) {
										onUpdate("context7ApiKey", value);
									}
								}}
								className="h-9 text-sm"
							/>
							<p className="text-xs text-muted-foreground">
								{t("mcp.servers.context7.apiKeyHint")}
							</p>
						</div>
					)}

					{serverId === "auto-claude" && (
						<p className="text-xs text-muted-foreground">
							{t("mcp.serverDialog.alwaysOn")}
						</p>
					)}

					{CONFIGURED_IN_INTEGRATIONS.has(serverId) && (
						<div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 p-3">
							<ExternalLink className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
							<p className="text-xs text-muted-foreground">
								{t("mcp.serverDialog.configuredInIntegrations")}
							</p>
						</div>
					)}
				</div>
			</DialogContent>
		</Dialog>
	);
}
