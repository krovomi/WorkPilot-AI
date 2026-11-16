/**
 * The security score of a catalog server, on its card (issue #369).
 *
 * The badge shows the score from the catalog at once; opening the card's
 * details reads the registry and the known vulnerabilities (main process)
 * and replaces it. Scoring: `shared/mcp-catalog/security-score.ts`.
 */

import { AlertTriangle, Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { scoreServer } from "../../../shared/mcp-catalog/security-score";
import type { McpMarketplaceServer } from "../../../shared/types/mcp-marketplace";
import type {
	McpSecurityLevel,
	McpSecurityScore,
	McpSecurityStatus,
} from "../../../shared/types/mcp-security";
import { formatAppDateTime } from "../../lib/date-format";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

export interface McpServerSecurity {
	score: McpSecurityScore;
	checking: boolean;
	error: string | null;
	check: (refresh?: boolean) => Promise<void>;
}

/** The score of `server`, from the catalog until the registry has been read. */
export function useMcpServerSecurity(
	server: McpMarketplaceServer,
	projectId: string | null,
): McpServerSecurity {
	const local = useMemo(() => scoreServer(server), [server]);
	const [read, setRead] = useState<McpSecurityScore | null>(null);
	const [checking, setChecking] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const check = useCallback(
		async (refresh = false) => {
			setChecking(true);
			setError(null);
			try {
				const result = await window.electronAPI.getMcpServerSecurity({
					serverId: server.id,
					projectId,
					refresh,
				});
				if (result.success && result.data) setRead(result.data);
				else setError(result.error ?? "");
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			} finally {
				setChecking(false);
			}
		},
		[server.id, projectId],
	);

	return { score: read ?? local, checking, error, check };
}

const LEVEL_CLASS: Record<McpSecurityLevel, string> = {
	high: "border-success/40 text-success",
	medium: "border-warning/40 text-warning",
	low: "border-destructive/40 text-destructive",
};

const STATUS_CLASS: Record<McpSecurityStatus, string> = {
	ok: "text-success",
	warn: "text-warning",
	risk: "text-destructive",
	unknown: "text-muted-foreground",
};

export function McpSecurityBadge({ score }: { readonly score: McpSecurityScore }) {
	const { t } = useTranslation(["common"]);
	const level = t(`mcpMarketplace.security.level.${score.level}`);
	return (
		<Badge
			variant="outline"
			className={cn("text-3xs px-1.5 py-0 gap-1", LEVEL_CLASS[score.level])}
			title={t("mcpMarketplace.security.badgeTitle", { score: score.score, level })}
			data-testid="mcp-security-badge"
		>
			<ShieldCheck className="h-3 w-3" />
			{t("mcpMarketplace.security.badge", { score: score.score })}
		</Badge>
	);
}

function uncheckedNote(score: McpSecurityScore): string | null {
	if (score.unchecked) return `mcpMarketplace.security.unchecked.${score.unchecked}`;
	if (!score.checked) return "mcpMarketplace.security.unchecked.notYet";
	return null;
}

/** The dimensions and alerts; reads the registry when it first shows. */
export function McpSecurityDetails({ security }: { readonly security: McpServerSecurity }) {
	const { t } = useTranslation(["common"]);
	const { score, checking, error, check } = security;
	const remote = score.unchecked === "remote";

	useEffect(() => {
		if (!remote) void check();
	}, [remote, check]);

	const note = uncheckedNote(score);
	return (
		<div className="space-y-1.5 rounded border border-border p-2" data-testid="mcp-security-details">
			<div className="flex items-center gap-2">
				<span className="font-medium text-foreground">{t("mcpMarketplace.security.title")}</span>
				<McpSecurityBadge score={score} />
				{!remote && (
					<Button
						variant="ghost"
						size="sm"
						className="ml-auto h-6 px-2 text-3xs"
						onClick={() => void check(true)}
						disabled={checking}
					>
						{checking ? (
							<Loader2 className="h-3 w-3 animate-spin" />
						) : (
							<RefreshCw className="h-3 w-3" />
						)}
						{t("mcpMarketplace.security.recheck")}
					</Button>
				)}
			</div>
			{checking && <p>{t("mcpMarketplace.security.checking")}</p>}
			{error && (
				<p role="alert" className="text-destructive">
					{error}
				</p>
			)}
			{note && !checking && <p>{t(note)}</p>}
			{score.checkedAt && (
				<p>
					{t("mcpMarketplace.security.checkedAt", {
						date: formatAppDateTime(score.checkedAt),
					})}
				</p>
			)}
			<ul className="space-y-0.5">
				{score.dimensions.map((d) => (
					<li key={d.key} className="flex gap-1">
						<span className={cn("font-medium shrink-0", STATUS_CLASS[d.status])}>
							{t(`mcpMarketplace.security.dimensions.${d.key}`)} {d.points}/{d.max}
						</span>
						<span>{t(`mcpMarketplace.security.reasons.${d.reason}`, d.values ?? {})}</span>
					</li>
				))}
			</ul>
			{score.level === "low" && (
				<p className="text-destructive">{t("mcpMarketplace.security.lowScore")}</p>
			)}
			{score.alerts.length > 0 && (
				<ul className="space-y-0.5" data-testid="mcp-security-alerts">
					{score.alerts.map((alert) => (
						<li
							key={`${alert.kind}-${JSON.stringify(alert.values ?? {})}`}
							className="flex items-start gap-1 text-warning"
						>
							<AlertTriangle className="h-3 w-3 shrink-0 mt-0.5" />
							{t(`mcpMarketplace.security.alerts.${alert.kind}`, alert.values ?? {})}
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
