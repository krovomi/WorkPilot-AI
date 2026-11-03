import {
	AlertTriangle,
	Check,
	ExternalLink,
	Loader2,
	RefreshCw,
	Sparkles,
	TerminalSquare,
	X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { useHermesStore } from "../stores/hermes-store";
import { CheckRow } from "./task-detail/HermesLearningCard";
import { type CliPresence, useReportCliPresence } from "./cli-tool-order";
import { Button } from "./ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

/** Product name: a proper noun, identical in every language. */
const NAME = "Hermes Agent";
const SHORT_NAME = "Hermes";
const DOCS_URL = "https://github.com/NousResearch/hermes-agent";

type BadgeState = "loading" | "ready" | "degraded" | "absent" | "error";

interface HermesStatusBadgeProps {
	/** Collapsed sidebar: the icon only. */
	readonly isCollapsed?: boolean;
	/** Where the « Outils CLI » panel places this badge, once the doctor answers. */
	readonly onPresenceChange?: (presence: CliPresence) => void;
}

/**
 * Sidebar badge for hermes-agent, beside the coding-agent CLIs.
 *
 * Hermes is not a provider WorkPilot hands a task to (`capabilities/harnesses.yaml`
 * says why), so this is not an `AgentCliStatusBadge`: it reads the same doctor
 * the task panel reads (`GET /api/hermes/status`) and offers what the panel
 * offers — the conditions with the command that meets each one, and the
 * persona install. It types nothing for the person: installing hermes and
 * trusting a checkout are theirs to run.
 *
 * Hidden in server mode, where the backend refuses: the hermes home there is
 * the server's, not the person's.
 */
export function HermesStatusBadge({
	isCollapsed = false,
	onPresenceChange,
}: HermesStatusBadgeProps) {
	const { t } = useTranslation(["hermes", "common"]);
	const [isOpen, setIsOpen] = useState(false);
	const status = useHermesStore((s) => s.status);
	const loading = useHermesStore((s) => s.loading);
	const running = useHermesStore((s) => s.running);
	const unavailable = useHermesStore((s) => s.unavailable);
	const error = useHermesStore((s) => s.error);
	const load = useHermesStore((s) => s.load);
	const installSoul = useHermesStore((s) => s.installSoul);

	useEffect(() => {
		void load();
	}, [load]);

	// A degraded hermes is installed; an unreachable doctor reads as missing,
	// as the badge itself shows it.
	const installed = status?.readiness.installed;
	useReportCliPresence(
		onPresenceChange,
		loading || (installed === undefined && !error)
			? null
			: installed
				? "installed"
				: "missing",
	);

	if (unavailable) return null;

	const state: BadgeState =
		loading || (!status && !error)
			? "loading"
			: status
				? status.readiness.state
				: "error";
	const readiness = status?.readiness;
	const soul = status?.soul;
	const soulMissing = Boolean(soul?.offered && !soul.installed);
	const pending = status?.pending.length ?? 0;
	const missing = state === "absent" || state === "error";

	const statusColor = {
		loading: "bg-muted-foreground",
		ready: "bg-green-500",
		degraded: "bg-amber-500",
		absent: "bg-destructive",
		error: "bg-destructive",
	}[state];

	const statusIcon = {
		loading: <Loader2 className="h-3 w-3 animate-spin" />,
		ready: <Check className="h-3 w-3" />,
		degraded: <AlertTriangle className="h-3 w-3" />,
		absent: <X className="h-3 w-3" />,
		error: <AlertTriangle className="h-3 w-3" />,
	}[state];

	const statusLabel =
		state === "loading"
			? t("hermes:sidebar.checking")
			: state === "error"
				? t("common:labels.error")
				: t(`hermes:state.${state}`);

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
									<span className="truncate">{SHORT_NAME}</span>
									{pending > 0 && (
										<span className="ml-auto text-[10px] bg-primary/15 text-primary px-1.5 py-0.5 rounded">
											{pending}
										</span>
									)}
								</>
							)}
						</Button>
					</PopoverTrigger>
				</TooltipTrigger>
				<TooltipContent side="right">
					{t("hermes:sidebar.tooltip", { name: NAME, state: statusLabel })}
				</TooltipContent>
			</Tooltip>

			<PopoverContent side="right" align="end" className="w-72">
				<div className="space-y-3">
					<div className="flex items-center gap-2">
						<div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
							<TerminalSquare className="h-4 w-4 text-primary" />
						</div>
						<div>
							<h4 className="text-sm font-medium">{NAME}</h4>
							<p className="text-xs text-muted-foreground flex items-center gap-1">
								{statusIcon}
								{statusLabel}
							</p>
						</div>
					</div>

					<p className="text-xs text-muted-foreground">{t("hermes:sidebar.description")}</p>

					{readiness && readiness.checks.length > 0 && (
						<ul className="space-y-1.5">
							{readiness.checks.map((check) => (
								<CheckRow key={check.name} check={check} />
							))}
						</ul>
					)}

					{pending > 0 && (
						<p className="text-xs p-2 bg-muted rounded-md">
							{t("hermes:sidebar.pending", { count: pending })}
						</p>
					)}

					{soulMissing && (
						<Button
							size="sm"
							variant="outline"
							className="w-full gap-1"
							disabled={running}
							onClick={() => void installSoul(soul?.state === "diverged")}
						>
							<Sparkles className="h-3 w-3" aria-hidden />
							{soul?.state === "diverged"
								? t("hermes:soul.replace")
								: t("hermes:soul.install")}
						</Button>
					)}

					{error && (
						<p
							role="alert"
							className="text-xs text-destructive whitespace-pre-wrap break-words max-h-32 overflow-auto"
						>
							{error}
						</p>
					)}

					<Button
						variant="outline"
						size="sm"
						className="w-full gap-1"
						onClick={() => void load(true)}
						disabled={state === "loading" || running}
					>
						<RefreshCw className={cn("h-3 w-3", state === "loading" && "animate-spin")} />
						{t("common:refresh")}
					</Button>

					<Button
						variant="link"
						size="sm"
						className="w-full text-xs text-muted-foreground gap-1"
						onClick={() => globalThis.electronAPI?.openExternal?.(DOCS_URL)}
					>
						{t("hermes:sidebar.docs", { name: NAME })}
						<ExternalLink className="h-3 w-3" />
					</Button>
				</div>
			</PopoverContent>
		</Popover>
	);
}
