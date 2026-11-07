import type { McpPinnedServer } from "@shared/types/mcp-pins";
import { AlertTriangle, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";

/**
 * Les outils MCP épinglés (`apps/backend/mcp_pins`).
 *
 * Un serveur MCP personnalisé n'atteint un agent qu'avec les outils que la
 * personne a approuvés. La description d'un outil est lue par le modèle et
 * jamais montrée : c'est ici qu'elle l'est, en clair, avec l'ancienne quand
 * elle a changé depuis l'approbation. Une description qui ressemble à une
 * instruction cachée demande une confirmation explicite.
 *
 * Rien ne s'affiche tant qu'aucun serveur n'attend : les serveurs déjà
 * configurés sont épinglés au premier contact.
 */
export function McpPinsSection({ projectPath }: { projectPath?: string }) {
	const { t } = useTranslation(["settings"]);
	const [servers, setServers] = useState<McpPinnedServer[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [confirming, setConfirming] = useState<string | null>(null);
	const [busy, setBusy] = useState<string | null>(null);

	const load = useCallback(async () => {
		if (!projectPath) return;
		const result = await globalThis.electronAPI.getMcpPins(projectPath);
		if (result.success) {
			setServers(result.data ?? []);
			setError(null);
		} else {
			setError(result.error ?? null);
		}
	}, [projectPath]);

	useEffect(() => {
		void load();
	}, [load]);

	const approve = async (serverId: string, confirmSuspicious: boolean) => {
		if (!projectPath) return;
		setBusy(serverId);
		const result = await globalThis.electronAPI.approveMcpServer(
			projectPath,
			serverId,
			confirmSuspicious,
		);
		setBusy(null);
		if (result.success) {
			setServers(result.data ?? []);
			setConfirming(null);
			setError(null);
		} else if (result.suspicious) {
			setConfirming(serverId);
		} else {
			setError(result.error ?? null);
		}
	};

	/** A finding is `code` or `code:detail` (`mcp_pins/scan.py`). */
	const findingLabel = (finding: string) => {
		const [code, ...rest] = finding.split(":");
		return t(`settings:mcp.pins.finding.${code}`, {
			detail: rest.join(":"),
			defaultValue: finding,
		});
	};

	const waiting = servers.filter((s) => s.status !== "approved");
	if (waiting.length === 0 && !error) return null;

	return (
		<section
			className="pt-4 border-t border-border"
			aria-label={t("settings:mcp.pins.title")}
		>
			<div className="flex items-center gap-2 mb-2">
				<ShieldCheck className="h-3 w-3 text-muted-foreground" aria-hidden />
				<span className="text-xs text-muted-foreground uppercase tracking-wider">
					{t("settings:mcp.pins.title")}
				</span>
			</div>
			<p className="text-xs text-muted-foreground mb-3">
				{t("settings:mcp.pins.description")}
			</p>
			{error && (
				<p className="text-xs text-destructive mb-2" role="alert">
					{error}
				</p>
			)}
			<div className="space-y-3">
				{waiting.map((server) => {
					const suspicious = server.pendingTools.some((tool) => tool.findings.length);
					return (
						<div
							key={server.serverId}
							className="rounded-md border border-warning/40 bg-warning/5 p-3"
						>
							<div className="flex items-center justify-between gap-2 mb-2">
								<div className="min-w-0">
									<span className="text-sm font-medium">{server.serverId}</span>
									<p className="text-xs text-muted-foreground">
										{server.programChanged
											? t("settings:mcp.pins.programChanged")
											: server.status === "pending"
												? t("settings:mcp.pins.pending")
												: t("settings:mcp.pins.changed")}
									</p>
								</div>
								<Button
									size="sm"
									variant={confirming === server.serverId ? "destructive" : "outline"}
									disabled={busy === server.serverId}
									onClick={() =>
										approve(server.serverId, confirming === server.serverId)
									}
								>
									{confirming === server.serverId
										? t("settings:mcp.pins.confirmApprove")
										: t("settings:mcp.pins.approve")}
								</Button>
							</div>
							{suspicious && (
								<p className="flex items-center gap-1 text-xs text-destructive mb-2">
									<AlertTriangle className="h-3 w-3" aria-hidden />
									{t("settings:mcp.pins.suspicious")}
								</p>
							)}
							<ul className="space-y-2">
								{server.pendingTools.map((tool) => (
									<li key={tool.name} className="text-xs">
										<span className="font-mono font-medium">{tool.name}</span>{" "}
										<span className="text-muted-foreground">
											{tool.change === "added"
												? t("settings:mcp.pins.toolAdded")
												: t("settings:mcp.pins.toolChanged")}
										</span>
										{tool.previousDescription != null && (
											<pre className="mt-1 whitespace-pre-wrap break-words rounded bg-muted p-2 line-through opacity-70">
												{tool.previousDescription}
											</pre>
										)}
										<pre className="mt-1 whitespace-pre-wrap break-words rounded bg-muted p-2">
											{tool.description || t("settings:mcp.pins.noDescription")}
										</pre>
										{tool.findings.length > 0 && (
											<ul className="mt-1 list-disc pl-4 text-destructive">
												{tool.findings.map((finding) => (
													<li key={finding}>{findingLabel(finding)}</li>
												))}
											</ul>
										)}
									</li>
								))}
							</ul>
							{server.removed.length > 0 && (
								<p className="mt-2 text-xs text-muted-foreground">
									{t("settings:mcp.pins.removed", { tools: server.removed.join(", ") })}
								</p>
							)}
						</div>
					);
				})}
			</div>
		</section>
	);
}
