import {
	AlertTriangle,
	Check,
	Download,
	ExternalLink,
	Loader2,
	RefreshCw,
	ScanSearch,
	X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import {
	REA_DOCS_URL,
	REA_PIN,
	REA_SPEC,
	type ReaInstallResult,
	type ReaState,
	type ReaStatus,
} from "../../shared/types/rea";
import { type CliPresence, useReportCliPresence } from "./cli-tool-order";
import { Button } from "./ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

/** Product name: a proper noun, identical in every language. */
const NAME = "REA";
const version = REA_PIN.version;
const ranges = REA_PIN.node.join(" || ");

type BadgeState = "loading" | ReaState;

interface ReaStatusBadgeProps {
	/** Collapsed sidebar: the icon only. */
	readonly isCollapsed?: boolean;
	/** Where the « Outils CLI » panel places this badge, once its check answers. */
	readonly onPresenceChange?: (presence: CliPresence) => void;
}

/**
 * Sidebar badge for REA, the static reader of shipped artifacts the backend
 * runs (`apps/backend/rea/`). Not a provider, so not an `AgentCliStatusBadge`:
 * it says whether `rea` on PATH is the pinned release and installs exactly
 * that release. Another version counts as present but is offered the pinned
 * one: WorkPilot never runs it. No `@latest` update, by design (`REA_PIN`).
 */
export function ReaStatusBadge({ isCollapsed = false, onPresenceChange }: ReaStatusBadgeProps) {
	const { t } = useTranslation(["navigation", "common"]);
	const [status, setStatus] = useState<ReaStatus | null>(null);
	const [isOpen, setIsOpen] = useState(false);
	const [isInstalling, setIsInstalling] = useState(false);
	const [installError, setInstallError] = useState<string | null>(null);
	const [docsError, setDocsError] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		setStatus(null);
		const check = globalThis.electronAPI?.checkRea;
		if (!check) {
			setStatus({ state: "absent", pinned: version });
			return;
		}
		try {
			setStatus(await check());
		} catch (err) {
			setStatus({
				state: "absent",
				pinned: version,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const install = useCallback(async () => {
		const run = globalThis.electronAPI?.installRea;
		if (!run) return;
		setIsInstalling(true);
		setInstallError(null);
		let answer: ReaInstallResult;
		try {
			answer = await run();
		} catch (err) {
			answer = {
				success: false,
				error: "failed",
				detail: err instanceof Error ? err.message : String(err),
			};
		} finally {
			setIsInstalling(false);
		}
		if (answer.status) setStatus(answer.status);
		if (answer.success) return;
		const message = t(`navigation:rea.error.${answer.error ?? "failed"}`, { version, ranges });
		setInstallError(answer.detail ? `${message}\n${answer.detail}` : message);
		if (!answer.status) void refresh();
	}, [t, refresh]);

	const openDocs = useCallback(async () => {
		setDocsError(null);
		try {
			await globalThis.electronAPI?.openExternal?.(REA_DOCS_URL);
		} catch (err) {
			// The main process says what it tried: a click that does nothing
			// and says nothing is what the user saw under WSL.
			const error = err instanceof Error ? err.message : String(err);
			setDocsError(t("navigation:rea.docsFailed", { error }));
		}
	}, [t]);

	const state: BadgeState = status ? status.state : "loading";
	const ready = state === "ready";
	const canInstall =
		Boolean(globalThis.electronAPI?.installRea) &&
		(state === "absent" || state === "other_version");
	const missing = state !== "loading" && state !== "ready" && state !== "other_version";
	useReportCliPresence(onPresenceChange, state === "loading" ? null : missing ? "missing" : "installed");

	const statusColor = {
		loading: "bg-muted-foreground",
		ready: "bg-success",
		other_version: "bg-warning",
		absent: "bg-destructive",
		node_missing: "bg-destructive",
		node_too_old: "bg-destructive",
	}[state];

	const statusIcon = {
		loading: <Loader2 className="h-3 w-3 animate-spin" />,
		ready: <Check className="h-3 w-3" />,
		other_version: <AlertTriangle className="h-3 w-3" />,
		absent: <X className="h-3 w-3" />,
		node_missing: <AlertTriangle className="h-3 w-3" />,
		node_too_old: <AlertTriangle className="h-3 w-3" />,
	}[state];

	const statusLabel =
		state === "loading"
			? t("navigation:agentCli.checkingShort")
			: t(`navigation:rea.state.${state}`, { version });

	const hint = (() => {
		if (!status) return null;
		switch (status.state) {
			case "other_version":
				return status.installedVersion
					? t("navigation:rea.otherVersion", { installed: status.installedVersion, version })
					: t("navigation:rea.otherVersionUnknown", { version });
			case "absent":
				return t("navigation:rea.absentHint", { version });
			case "node_too_old":
				return t("navigation:rea.nodeTooOld", {
					version,
					ranges,
					node: status.nodeVersion ?? "",
				});
			case "node_missing":
				return t("navigation:rea.nodeMissing", { ranges });
			default:
				return null;
		}
	})();

	return (
		<Popover open={isOpen} onOpenChange={setIsOpen}>
			<Tooltip>
				<TooltipTrigger asChild>
					<PopoverTrigger asChild>
						<Button
							variant="ghost"
							size={isCollapsed ? "icon" : "sm"}
							className={cn(
								isCollapsed ? "justify-center" : "w-full justify-start gap-2 text-xs",
								missing ? "text-muted-foreground" : "",
								state === "other_version" ? "text-warning" : "",
							)}
						>
							<div className="relative">
								<ScanSearch className="h-4 w-4" />
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
										{NAME}
										{ready ? ` (${version})` : ""}
									</span>
									{canInstall && (
										<span className="ml-auto text-3xs bg-primary/15 text-primary px-1.5 py-0.5 rounded flex items-center gap-1">
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
				<TooltipContent side="right">{statusLabel}</TooltipContent>
			</Tooltip>

			<PopoverContent side="right" align="end" className="w-64">
				<div className="space-y-3">
					<div className="flex items-center gap-2">
						<div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
							<ScanSearch className="h-4 w-4 text-primary" />
						</div>
						<div>
							<h4 className="text-sm font-medium">{NAME}</h4>
							<p className="text-xs text-muted-foreground flex items-center gap-1">
								{statusIcon}
								{statusLabel}
							</p>
						</div>
					</div>

					<p className="text-xs text-muted-foreground">
						{t("navigation:rea.description", { version })}
					</p>

					{hint && (
						<p className="text-xs p-2 bg-muted/50 rounded-md text-muted-foreground">{hint}</p>
					)}

					{status?.nodeManager && status.nodeVersion && (
						<p className="text-2xs text-muted-foreground">
							{t("navigation:rea.nodeFromManager", {
								node: status.nodeVersion,
								manager: status.nodeManager,
							})}
						</p>
					)}

					{canInstall && (
						<>
							<p className="text-xs font-mono bg-muted px-1 rounded break-all">
								<code>{`npm install -g --ignore-scripts ${REA_SPEC}`}</code>
							</p>
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
									: t("navigation:rea.installButton", { version })}
							</Button>
						</>
					)}

					{installError && (
						<p
							role="alert"
							className="text-xs text-destructive whitespace-pre-wrap break-words max-h-32 overflow-auto"
						>
							{installError}
						</p>
					)}

					<p className="text-2xs text-muted-foreground">{t("navigation:rea.noCredentials")}</p>

					<Button
						variant="outline"
						size="sm"
						className="w-full gap-1"
						onClick={() => {
							void refresh();
						}}
						disabled={state === "loading" || isInstalling}
					>
						<RefreshCw className={cn("h-3 w-3", state === "loading" && "animate-spin")} />
						{t("common:refresh")}
					</Button>

					<Button
						variant="link"
						size="sm"
						className="w-full text-xs text-muted-foreground gap-1"
						onClick={() => {
							void openDocs();
						}}
					>
						{t("navigation:agentCli.viewDocs", { name: NAME })}
						<ExternalLink className="h-3 w-3" />
					</Button>

					{docsError && (
						<p role="alert" className="text-xs text-destructive break-words">
							{docsError}
						</p>
					)}
				</div>
			</PopoverContent>
		</Popover>
	);
}
