import {
	AlertCircle,
	CheckCircle,
	Download,
	ExternalLink,
	Loader2,
	RefreshCw,
	TerminalSquare,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/hooks/use-toast";
import { refreshProviderModelCatalog } from "@/hooks/useProviderModelCatalog";
import {
	AGENT_CLI_DOCS,
	AGENT_CLI_EXECUTABLES,
	AGENT_CLI_LOGIN_COMMAND,
	type AgentCliInstallResult,
	type AgentCliStatus,
	type AgentCliTool,
} from "../../../shared/types/agent-cli";
import { Button } from "../ui/button";
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { AuthTerminal } from "./AuthTerminal";

const KEY = "sections.accounts.providerConfig.agentCli";

interface AgentCliConfigContentProps {
	readonly tool: AgentCliTool;
	readonly providerName: string;
	readonly description?: string;
	/** Make this CLI the default provider (the card's "activate"). */
	readonly onActivate?: (providerId: string) => void | Promise<void>;
	readonly onClose: () => void;
}

/**
 * "Configure" for a coding-agent CLI provider (OpenCode, Google Antigravity,
 * pi, Gemini CLI). These have no API key field in WorkPilot: each CLI owns its
 * sign-in. So the dialog shows whether the CLI is installed (and installs it),
 * opens a terminal with the CLI's own login command, and sets it as the
 * default provider.
 */
export function AgentCliConfigContent({
	tool,
	providerName,
	description,
	onActivate,
	onClose,
}: AgentCliConfigContentProps) {
	const { t } = useTranslation(["settings", "navigation", "common"]);
	const { toast } = useToast();
	const [status, setStatus] = useState<AgentCliStatus | null>(null);
	const [isChecking, setIsChecking] = useState(false);
	const [isInstalling, setIsInstalling] = useState(false);
	const [installError, setInstallError] = useState<string | null>(null);
	const [terminalId, setTerminalId] = useState<string | null>(null);

	const command = AGENT_CLI_LOGIN_COMMAND[tool];
	const executable = AGENT_CLI_EXECUTABLES[tool];

	const check = useCallback(async () => {
		const run = globalThis.electronAPI?.checkAgentCli;
		if (!run) {
			setStatus({ tool, installed: false, error: "unavailable" });
			return;
		}
		setIsChecking(true);
		try {
			setStatus(await run(tool));
		} catch (err) {
			setStatus({
				tool,
				installed: false,
				error: err instanceof Error ? err.message : String(err),
			});
		} finally {
			setIsChecking(false);
		}
	}, [tool]);

	useEffect(() => {
		void check();
	}, [check]);

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
		if (answer.status) setStatus(answer.status);
		if (answer.success) {
			refreshProviderModelCatalog(tool);
			return;
		}
		const message = t(
			`navigation:agentCli.install.error.${answer.error ?? "failed"}`,
			{ name: providerName },
		);
		setInstallError(answer.detail ? `${message}\n${answer.detail}` : message);
		if (!answer.status) void check();
	}, [tool, providerName, t, check]);

	const instructions = useMemo(
		() => ({
			title: t(`${KEY}.terminalTitle`, { name: providerName }),
			steps: [
				t(`${KEY}.terminalStep1`, { command }),
				t(`${KEY}.terminalStep2`),
				t(`${KEY}.terminalStep3`),
			],
		}),
		[t, providerName, command],
	);

	const closeTerminal = useCallback(() => {
		setTerminalId(null);
		void check();
	}, [check]);

	const activate = async () => {
		await onActivate?.(tool);
		toast({
			title: t(`${KEY}.activated`, { name: providerName }),
		});
		onClose();
	};

	const installed = status?.installed === true;
	const canInstall = Boolean(globalThis.electronAPI?.installAgentCli);

	return (
		<div className="flex flex-col gap-4">
			<DialogHeader>
				<div className="flex items-center gap-3">
					<div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center">
						<TerminalSquare className="w-4 h-4" />
					</div>
					<div>
						<DialogTitle className="text-lg">{providerName}</DialogTitle>
						<DialogDescription className="text-sm">
							{description}
						</DialogDescription>
					</div>
				</div>
			</DialogHeader>

			{/* CLI status */}
			<section className="rounded-lg border border-border p-4 space-y-3">
				<div className="flex items-center justify-between gap-3">
					<h3 className="text-sm font-medium">{t(`${KEY}.status`)}</h3>
					<Button
						variant="ghost"
						size="sm"
						onClick={() => void check()}
						disabled={isChecking || isInstalling}
					>
						<RefreshCw
							className={`w-3.5 h-3.5 mr-1.5 ${isChecking ? "animate-spin" : ""}`}
						/>
						{t(`${KEY}.recheck`)}
					</Button>
				</div>
				<div className="flex items-center gap-2 text-sm" data-testid="agent-cli-status">
					{status === null ? (
						<>
							<Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
							<span>{t(`${KEY}.checking`)}</span>
						</>
					) : installed ? (
						<>
							<CheckCircle className="w-4 h-4 text-success" />
							<span>
								{status.version
									? t(`${KEY}.installedVersion`, { version: status.version })
									: t(`${KEY}.installed`)}
							</span>
						</>
					) : (
						<>
							<AlertCircle className="w-4 h-4 text-destructive" />
							<span>{t(`${KEY}.notInstalled`, { executable })}</span>
						</>
					)}
				</div>
				{status !== null && !installed && canInstall && (
					<Button onClick={() => void install()} disabled={isInstalling}>
						{isInstalling ? (
							<Loader2 className="w-4 h-4 mr-2 animate-spin" />
						) : (
							<Download className="w-4 h-4 mr-2" />
						)}
						{isInstalling
							? t(`${KEY}.installing`)
							: t(`${KEY}.install`, { name: providerName })}
					</Button>
				)}
				{installError && (
					<p className="text-sm text-destructive whitespace-pre-wrap">
						{installError}
					</p>
				)}
			</section>

			{/* Sign-in */}
			<section className="rounded-lg border border-border p-4 space-y-3">
				<h3 className="text-sm font-medium">{t(`${KEY}.signInTitle`)}</h3>
				<p className="text-sm text-muted-foreground">
					{t(`${KEY}.signInDescription`, { name: providerName })}
				</p>
				<p className="text-sm text-muted-foreground">{t(`${KEY}.hints.${tool}`)}</p>
				<div className="space-y-1">
					<span className="text-xs text-muted-foreground">
						{t(`${KEY}.signInCommand`)}
					</span>
					<code className="block rounded bg-muted px-3 py-2 font-mono text-sm">
						{command}
					</code>
				</div>
				<div className="flex flex-wrap gap-2">
					{terminalId ? (
						<Button variant="outline" onClick={closeTerminal}>
							{t(`${KEY}.closeTerminal`)}
						</Button>
					) : (
						<Button
							variant="outline"
							disabled={!installed}
							onClick={() => setTerminalId(`agent-cli-login-${tool}-${Date.now()}`)}
						>
							<TerminalSquare className="w-4 h-4 mr-2" />
							{t(`${KEY}.openTerminal`)}
						</Button>
					)}
					<Button
						variant="ghost"
						onClick={() => globalThis.electronAPI?.openExternal?.(AGENT_CLI_DOCS[tool])}
					>
						<ExternalLink className="w-4 h-4 mr-2" />
						{t(`${KEY}.docs`)}
					</Button>
				</div>
				{terminalId && (
					<div className="h-[320px]">
						<AuthTerminal
							terminalId={terminalId}
							configDir=""
							profileName={providerName}
							loginCommand={command}
							instructions={instructions}
							onClose={closeTerminal}
						/>
					</div>
				)}
			</section>

			{/* Model */}
			<section className="rounded-lg border border-border p-4 space-y-1">
				<h3 className="text-sm font-medium">{t(`${KEY}.modelTitle`)}</h3>
				<p className="text-sm text-muted-foreground">{t(`${KEY}.modelDescription`)}</p>
			</section>

			<DialogFooter className="flex shrink-0 gap-2 border-t border-border/40 pt-3">
				<Button onClick={() => void activate()} disabled={!installed}>
					{t(`${KEY}.activate`)}
				</Button>
				<Button variant="outline" onClick={onClose}>
					{t("common:buttons.close")}
				</Button>
			</DialogFooter>
		</div>
	);
}
