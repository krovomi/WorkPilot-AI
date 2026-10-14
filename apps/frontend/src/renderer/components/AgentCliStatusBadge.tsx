import {
	AlertTriangle,
	Check,
	ExternalLink,
	Loader2,
	RefreshCw,
	TerminalSquare,
	X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import {
	AGENT_CLI_DOCS,
	AGENT_CLI_EXECUTABLES,
	type AgentCliStatus,
	type AgentCliTool,
} from "../../shared/types/agent-cli";
import { Button } from "./ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

type BadgeStatus = "loading" | "installed" | "not-found" | "error";

/** Product names: proper nouns, identical in every language. */
const TOOL_NAMES: Readonly<Record<AgentCliTool, string>> = {
	opencode: "OpenCode CLI",
	antigravity: "Antigravity CLI",
};

const SHORT_NAMES: Readonly<Record<AgentCliTool, string>> = {
	opencode: "OpenCode",
	antigravity: "Antigravity",
};

interface AgentCliStatusBadgeProps {
	readonly tool: AgentCliTool;
	readonly className?: string;
	/** Collapsed sidebar: the icon only. */
	readonly isCollapsed?: boolean;
}

function toBadgeStatus(result: AgentCliStatus | null): BadgeStatus {
	if (!result) return "loading";
	if (result.installed) return "installed";
	return result.error ? "error" : "not-found";
}

/**
 * Sidebar badge for a coding-agent CLI WorkPilot drives as a provider
 * (OpenCode, Google Antigravity). It only says whether the executable is on
 * PATH and its version: each CLI owns its own sign-in.
 */
export function AgentCliStatusBadge({
	tool,
	className,
	isCollapsed = false,
}: AgentCliStatusBadgeProps) {
	const { t } = useTranslation(["common", "navigation"]);
	const [result, setResult] = useState<AgentCliStatus | null>(null);
	const [isOpen, setIsOpen] = useState(false);
	const name = TOOL_NAMES[tool];

	const refresh = useCallback(async () => {
		setResult(null);
		const check = globalThis.electronAPI?.checkAgentCli;
		if (!check) {
			setResult({ tool, installed: false });
			return;
		}
		try {
			setResult(await check(tool));
		} catch (err) {
			setResult({
				tool,
				installed: false,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}, [tool]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const status = toBadgeStatus(result);
	const version = result?.version;

	const statusColor = {
		loading: "bg-muted-foreground",
		installed: "bg-green-500",
		"not-found": "bg-destructive",
		error: "bg-destructive",
	}[status];

	const statusIcon = {
		loading: <Loader2 className="h-3 w-3 animate-spin" />,
		installed: <Check className="h-3 w-3" />,
		"not-found": <X className="h-3 w-3" />,
		error: <AlertTriangle className="h-3 w-3" />,
	}[status];

	const tooltip = {
		loading: t("navigation:agentCli.checking", { name }),
		installed: version
			? t("navigation:agentCli.installedWithVersion", { name, version })
			: t("navigation:agentCli.installed", { name }),
		"not-found": t("navigation:agentCli.notFound", { name }),
		error: t("navigation:agentCli.error", { name }),
	}[status];

	const statusLabel = {
		loading: t("navigation:agentCli.checkingShort"),
		installed: t("navigation:agentCli.installedShort"),
		"not-found": t("navigation:agentCli.notInstalledShort"),
		error: t("common:labels.error"),
	}[status];

	const missing = status === "not-found" || status === "error";

	return (
		<Popover open={isOpen} onOpenChange={setIsOpen}>
			<Tooltip>
				<TooltipTrigger asChild>
					<PopoverTrigger asChild>
						<Button
							variant="ghost"
							size={isCollapsed ? "icon" : "sm"}
							className={cn(
								isCollapsed
									? "justify-center"
									: "w-full justify-start gap-2 text-xs",
								missing ? "text-muted-foreground" : "",
								className,
							)}
						>
							<div className="relative">
								<TerminalSquare className="h-4 w-4" />
								<span
									className={cn(
										"absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full",
										statusColor,
									)}
								/>
							</div>
							{!isCollapsed && (
								<span className="truncate">
									{SHORT_NAMES[tool]}
									{version ? ` (${version})` : ""}
								</span>
							)}
						</Button>
					</PopoverTrigger>
				</TooltipTrigger>
				<TooltipContent side="right">{tooltip}</TooltipContent>
			</Tooltip>

			<PopoverContent side="right" align="end" className="w-64">
				<div className="space-y-3">
					<div className="flex items-center gap-2">
						<div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
							<TerminalSquare className="h-4 w-4 text-primary" />
						</div>
						<div>
							<h4 className="text-sm font-medium">{name}</h4>
							<p className="text-xs text-muted-foreground flex items-center gap-1">
								{statusIcon}
								{statusLabel}
							</p>
						</div>
					</div>

					{status === "installed" && version && (
						<div className="text-xs p-2 bg-muted rounded-md flex justify-between">
							<span className="text-muted-foreground">
								{t("navigation:agentCli.version")}:
							</span>
							<span className="font-mono">{version}</span>
						</div>
					)}

					{missing && (
						<div className="text-xs p-2 bg-muted/50 rounded-md text-muted-foreground space-y-1">
							<p>{t("navigation:agentCli.notInstalledDescription", { name })}</p>
							<p className="font-mono bg-muted px-1 rounded break-all">
								{AGENT_CLI_EXECUTABLES[tool]}
							</p>
						</div>
					)}

					<p className="text-[11px] text-muted-foreground">
						{t("navigation:agentCli.signInHint")}
					</p>

					<Button
						variant="outline"
						size="sm"
						className="w-full gap-1"
						onClick={() => {
							void refresh();
						}}
						disabled={status === "loading"}
					>
						<RefreshCw
							className={cn("h-3 w-3", status === "loading" && "animate-spin")}
						/>
						{t("common:refresh")}
					</Button>

					<Button
						variant="link"
						size="sm"
						className="w-full text-xs text-muted-foreground gap-1"
						onClick={() =>
							globalThis.electronAPI?.openExternal?.(AGENT_CLI_DOCS[tool])
						}
					>
						{t("navigation:agentCli.viewDocs", { name })}
						<ExternalLink className="h-3 w-3" />
					</Button>
				</div>
			</PopoverContent>
		</Popover>
	);
}
