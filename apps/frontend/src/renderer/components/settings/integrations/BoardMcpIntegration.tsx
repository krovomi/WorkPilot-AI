import { Check, Copy, Plug, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
	BoardMcpClientId,
	BoardMcpClientStatus,
	BoardMcpStatus,
} from "../../../../shared/types";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";

/** Product names: the same in every language. */
const CLIENT_NAMES: Record<BoardMcpClientId, string> = {
	"claude-code": "Claude Code",
	codex: "Codex",
	"gemini-cli": "Gemini CLI",
	"copilot-cli": "GitHub Copilot CLI",
	vscode: "VS Code (GitHub Copilot)",
	cursor: "Cursor",
	"claude-desktop": "Claude Desktop",
	windsurf: "Windsurf",
	opencode: "OpenCode",
	hermes: "Hermes Agent",
};

interface BoardMcpIntegrationProps {
	readonly projectId: string;
}

/**
 * "Use from other apps": registers this project's `workpilot-board` MCP
 * server with the AI apps of this computer, or shows what to paste.
 */
export function BoardMcpIntegration({ projectId }: BoardMcpIntegrationProps) {
	const { t } = useTranslation("settings");
	const [status, setStatus] = useState<BoardMcpStatus | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState<BoardMcpClientId | null>(null);
	const [clientErrors, setClientErrors] = useState<Partial<Record<BoardMcpClientId, string>>>(
		{},
	);
	const [copied, setCopied] = useState<BoardMcpClientId | null>(null);
	const [open, setOpen] = useState<BoardMcpClientId | null>(null);

	const load = useCallback(async () => {
		const result = await window.electronAPI.getBoardMcpStatus(projectId);
		if (result.success && result.data) {
			setStatus(result.data);
			setError(null);
		} else {
			setStatus(null);
			setError(result.error ?? "unknown");
		}
	}, [projectId]);

	useEffect(() => {
		void load();
	}, [load]);

	const apply = async (client: BoardMcpClientStatus, add: boolean) => {
		setBusy(client.id);
		const result = await window.electronAPI.applyBoardMcp(projectId, client.id, add);
		setBusy(null);
		if (result.success && result.data) {
			const updated = result.data;
			setClientErrors((current) => ({ ...current, [client.id]: undefined }));
			setStatus((current) =>
				current
					? {
							...current,
							clients: current.clients.map((c) => (c.id === updated.id ? updated : c)),
						}
					: current,
			);
		} else {
			setClientErrors((current) => ({ ...current, [client.id]: result.error ?? "unknown" }));
		}
	};

	const copy = async (client: BoardMcpClientStatus) => {
		try {
			await navigator.clipboard.writeText(client.snippet);
			setCopied(client.id);
			setTimeout(() => setCopied(null), 2000);
		} catch {
			setOpen(client.id);
		}
	};

	const errorText = (code: string) =>
		t(`boardMcp.errors.${code}`, { defaultValue: t("boardMcp.errors.generic", { detail: code }) });

	if (error) {
		return (
			<p className="text-sm text-muted-foreground" data-testid="board-mcp-error">
				{errorText(error)}
			</p>
		);
	}
	if (!status) {
		return <p className="text-sm text-muted-foreground">{t("boardMcp.loading")}</p>;
	}

	return (
		<div className="space-y-4">
			<p className="text-sm text-muted-foreground">
				{t("boardMcp.intro", { name: status.serverName })}
			</p>
			<p className="text-xs text-muted-foreground">{t("boardMcp.limits")}</p>
			<ul className="divide-y divide-border rounded-md border border-border">
				{status.clients.map((client) => {
					const clientError = clientErrors[client.id];
					return (
						<li key={client.id} className="space-y-2 p-3" data-testid={`board-mcp-${client.id}`}>
							<div className="flex flex-wrap items-center gap-2">
								<span className="font-medium">{CLIENT_NAMES[client.id]}</span>
								<StateBadge client={client} />
								<span className="ml-auto flex gap-2">
									{client.writable && client.state !== "current" && (
										<Button
											size="sm"
											onClick={() => void apply(client, true)}
											disabled={busy !== null}
										>
											{client.state === "stale" ? (
												<RefreshCw className="mr-1 h-3.5 w-3.5" />
											) : (
												<Plug className="mr-1 h-3.5 w-3.5" />
											)}
											{client.state === "stale" ? t("boardMcp.update") : t("boardMcp.add")}
										</Button>
									)}
									{client.writable && client.state !== "absent" && (
										<Button
											size="sm"
											variant="outline"
											onClick={() => void apply(client, false)}
											disabled={busy !== null}
											aria-label={t("boardMcp.remove")}
										>
											<Trash2 className="h-3.5 w-3.5" />
										</Button>
									)}
									<Button
										size="sm"
										variant="outline"
										onClick={() => void copy(client)}
										aria-label={t("boardMcp.copy")}
									>
										{copied === client.id ? (
											<Check className="h-3.5 w-3.5" />
										) : (
											<Copy className="h-3.5 w-3.5" />
										)}
									</Button>
								</span>
							</div>
							<p className="text-xs text-muted-foreground">
								{t("boardMcp.location", { location: client.location })}
							</p>
							{client.readError && (
								<p className="text-xs text-amber-600">{t("boardMcp.errors.config_unreadable")}</p>
							)}
							{clientError && <p className="text-xs text-destructive">{errorText(clientError)}</p>}
							{client.state === "current" && (
								<p className="text-xs text-muted-foreground">{t("boardMcp.restartHint")}</p>
							)}
							<button
								type="button"
								className="text-xs text-primary underline-offset-2 hover:underline"
								onClick={() => setOpen(open === client.id ? null : client.id)}
							>
								{open === client.id ? t("boardMcp.hideSnippet") : t("boardMcp.showSnippet")}
							</button>
							{open === client.id && (
								<pre className="overflow-x-auto rounded bg-muted p-2 text-xs">{client.snippet}</pre>
							)}
						</li>
					);
				})}
			</ul>
		</div>
	);
}

function StateBadge({ client }: { readonly client: BoardMcpClientStatus }) {
	const { t } = useTranslation("settings");
	if (client.state === "current") {
		return <Badge variant="default">{t("boardMcp.state.current")}</Badge>;
	}
	if (client.state === "stale") {
		return <Badge variant="secondary">{t("boardMcp.state.stale")}</Badge>;
	}
	if (!client.detected) {
		return <Badge variant="outline">{t("boardMcp.state.notDetected")}</Badge>;
	}
	return <Badge variant="outline">{t("boardMcp.state.absent")}</Badge>;
}
