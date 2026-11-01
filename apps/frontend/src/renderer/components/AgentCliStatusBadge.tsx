import {
	AlertTriangle,
	Check,
	Download,
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
	ACP_AGENT_ARGS,
	type AcpAgentDeclaration,
	AGENT_CLI_DOCS,
	AGENT_CLI_EXECUTABLES,
	AGENT_CLI_INSTALL,
	type AgentCliInstallResult,
	type AgentCliStatus,
	type AgentCliTool,
} from "../../shared/types/agent-cli";
import { refreshProviderModelCatalog } from "@/hooks/useProviderModelCatalog";
import { Button } from "./ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

type BadgeStatus = "loading" | "installed" | "not-found" | "error";

/** Product names: proper nouns, identical in every language. */
const TOOL_NAMES: Readonly<Record<AgentCliTool, string>> = {
	opencode: "OpenCode CLI",
	antigravity: "Antigravity CLI",
	pi: "pi (pi.dev)",
	"gemini-cli": "Gemini CLI",
};

const SHORT_NAMES: Readonly<Record<AgentCliTool, string>> = {
	opencode: "OpenCode",
	antigravity: "Antigravity",
	pi: "pi",
	"gemini-cli": "Gemini",
};

/** The capabilities an ACP agent can declare, in the order they are listed. */
const ACP_CAPABILITIES = [
	"loadSession",
	"images",
	"audio",
	"embeddedContext",
	"mcpHttp",
	"mcpSse",
] as const;

/**
 * What an ACP agent declared in `initialize`. A capability it did not declare
 * is listed as such, never as available.
 */
function AcpDeclarationList({ tool }: { readonly tool: AgentCliTool }) {
	const { t } = useTranslation(["navigation"]);
	const [answer, setAnswer] = useState<AcpAgentDeclaration | null>(null);

	useEffect(() => {
		let cancelled = false;
		const probe = globalThis.electronAPI?.probeAcpAgent;
		if (!probe) {
			setAnswer({ tool, error: "failed" });
			return;
		}
		probe(tool)
			.then((result) => {
				if (!cancelled) setAnswer(result);
			})
			.catch(() => {
				if (!cancelled) setAnswer({ tool, error: "failed" });
			});
		return () => {
			cancelled = true;
		};
	}, [tool]);

	if (!answer) {
		return (
			<p className="text-xs text-muted-foreground flex items-center gap-1">
				<Loader2 className="h-3 w-3 animate-spin" />
				{t("navigation:agentCli.acp.probing")}
			</p>
		);
	}
	if (!answer.declared) {
		return (
			<p className="text-xs text-muted-foreground">
				{t(`navigation:agentCli.acp.error.${answer.error ?? "failed"}`)}
			</p>
		);
	}
	const declared = answer.declared;
	return (
		<div className="text-xs p-2 bg-muted rounded-md space-y-1">
			<p className="text-muted-foreground">{t("navigation:agentCli.acp.declares")}</p>
			<ul className="space-y-0.5">
				{ACP_CAPABILITIES.map((capability) => (
					<li
						key={capability}
						className={cn(
							"flex items-center gap-1",
							!declared[capability] && "text-muted-foreground",
						)}
					>
						{declared[capability] ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
						{t(`navigation:agentCli.acp.capability.${capability}`)}
						{!declared[capability] && ` (${t("navigation:agentCli.acp.notDeclared")})`}
					</li>
				))}
			</ul>
		</div>
	);
}

/** The command the install button runs first, shown before it runs. */
function installCommandHint(tool: AgentCliTool): string {
	const recipe = AGENT_CLI_INSTALL[tool];
	if (recipe.npmPackage) {
		return ["npm install -g", ...(recipe.npmArgs ?? []), recipe.npmPackage].join(" ");
	}
	const isWindows = globalThis.navigator?.userAgent?.includes("Windows") ?? false;
	if (isWindows && recipe.windowsScript) return `irm ${recipe.windowsScript} | iex`;
	return recipe.unixScript
		? `curl -fsSL ${recipe.unixScript.url} | ${recipe.unixScript.shell}`
		: "";
}

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
 * (OpenCode, Google Antigravity, pi, Gemini CLI). It says whether the
 * executable is on PATH and its version, and for an ACP agent what it declares
 * once the popover opens: each CLI owns its own sign-in.
 */
export function AgentCliStatusBadge({
	tool,
	className,
	isCollapsed = false,
}: AgentCliStatusBadgeProps) {
	const { t } = useTranslation(["common", "navigation"]);
	const [result, setResult] = useState<AgentCliStatus | null>(null);
	const [isOpen, setIsOpen] = useState(false);
	const [isInstalling, setIsInstalling] = useState(false);
	const [installError, setInstallError] = useState<string | null>(null);
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

	const install = useCallback(async () => {
		const run = globalThis.electronAPI?.installAgentCli;
		if (!run) return;
		setIsInstalling(true);
		setInstallError(null);
		let answer: AgentCliInstallResult;
		try {
			answer = await run(tool);
		} catch (err) {
			answer = {
				tool,
				success: false,
				error: "failed",
				detail: err instanceof Error ? err.message : String(err),
			};
		} finally {
			setIsInstalling(false);
		}
		if (answer.status) setResult(answer.status);
		if (answer.success) {
			refreshProviderModelCatalog(tool);
			return;
		}
		const message = t(`navigation:agentCli.install.error.${answer.error ?? "failed"}`, {
			name,
		});
		setInstallError(answer.detail ? `${message}\n${answer.detail}` : message);
		if (!answer.status) void refresh();
	}, [tool, name, t, refresh]);

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
	const canInstall = Boolean(globalThis.electronAPI?.installAgentCli);

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
								<>
									<span className="truncate">
										{SHORT_NAMES[tool]}
										{version ? ` (${version})` : ""}
									</span>
									{missing && canInstall && (
										<span className="ml-auto text-[10px] bg-primary/15 text-primary px-1.5 py-0.5 rounded flex items-center gap-1">
											{isInstalling && <Loader2 className="h-2.5 w-2.5 animate-spin" />}
											{isInstalling
												? t("navigation:agentCli.install.installingShort")
												: t("common:install")}
										</span>
									)}
								</>
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

					{status === "installed" && isOpen && ACP_AGENT_ARGS[tool] && (
						<AcpDeclarationList tool={tool} />
					)}

					{missing && (
						<div className="text-xs p-2 bg-muted/50 rounded-md text-muted-foreground space-y-1">
							<p>
								{canInstall
									? t("navigation:agentCli.install.description", { name })
									: t("navigation:agentCli.notInstalledDescription", { name })}
							</p>
							<p className="font-mono bg-muted px-1 rounded break-all">
								{canInstall ? installCommandHint(tool) : AGENT_CLI_EXECUTABLES[tool]}
							</p>
						</div>
					)}

					{missing && canInstall && (
						<Button
							size="sm"
							className="w-full gap-1"
							onClick={() => {
								void install();
							}}
							disabled={isInstalling}
						>
							{isInstalling ? (
								<Loader2 className="h-3 w-3 animate-spin" />
							) : (
								<Download className="h-3 w-3" />
							)}
							{isInstalling
								? t("navigation:agentCli.install.installing")
								: t("navigation:agentCli.install.button", { name })}
						</Button>
					)}

					{installError && (
						<p
							role="alert"
							className="text-xs text-destructive whitespace-pre-wrap break-words max-h-32 overflow-auto"
						>
							{installError}
						</p>
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
						disabled={status === "loading" || isInstalling}
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
