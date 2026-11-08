/**
 * MCP access to the team server (server mode): the person's access tokens
 * for `<server>/mcp`, and what to paste in each AI app.
 *
 * A token is made for the organization the person acts in, read-only or
 * read and write, and shown once: the server keeps only its hash
 * (`apps/backend/server/auth/access_tokens.py`). It reaches only `/mcp`, and
 * only what the person's own role reaches there.
 */

import { Check, Copy, KeyRound, Loader2, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	Badge,
	Button,
	Input,
	Label,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui";
import {
	BOARD_MCP_CLIENT_NAMES,
	BOARD_MCP_CLIENTS,
	type BoardMcpClientId,
	type ServerAccessToken,
	type ServerAccessTokenCreated,
} from "../../../shared/types/board-mcp";
import { httpSnippet } from "../../../shared/utils/board-mcp-http";
import { formatAppDate } from "../../lib/date-format";
import { Notice } from "../charter";
import { SettingsSection } from "./SettingsSection";

const DURATIONS = [30, 90, 365] as const;
type Scope = ServerAccessToken["scope"];

function CopyButton({ text, label }: { readonly text: string; readonly label: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<Button
			size="sm"
			variant="outline"
			aria-label={label}
			onClick={async () => {
				try {
					await navigator.clipboard.writeText(text);
					setCopied(true);
					setTimeout(() => setCopied(false), 2000);
				} catch {
					// The text stays on screen to copy by hand.
				}
			}}
		>
			{copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
		</Button>
	);
}

/** The token just made, the only time it is shown, with each app's entry. */
function CreatedToken({
	created,
	onDone,
}: {
	readonly created: ServerAccessTokenCreated;
	readonly onDone: () => void;
}) {
	const { t } = useTranslation("settings");
	const [client, setClient] = useState<BoardMcpClientId>("claude-code");
	const snippet = httpSnippet(client, created.mcpUrl, created.token);
	return (
		<div
			className="space-y-3 rounded-lg border border-primary/40 bg-primary/5 p-4"
			data-testid="server-mcp-created"
		>
			<p className="text-sm font-medium">{t("serverMcp.created.title", { name: created.name })}</p>
			<p className="text-xs text-muted-foreground">{t("serverMcp.created.once")}</p>
			<div className="flex items-center gap-2">
				<code className="flex-1 overflow-x-auto rounded bg-muted px-2 py-1 text-xs">
					{created.token}
				</code>
				<CopyButton text={created.token} label={t("serverMcp.copyToken")} />
			</div>
			<p className="text-xs text-muted-foreground">
				{t("serverMcp.created.endpoint", { url: created.mcpUrl })}
			</p>
			<div className="space-y-2">
				<Label>{t("serverMcp.created.pasteIn")}</Label>
				<div className="flex flex-wrap gap-1" role="tablist">
					{BOARD_MCP_CLIENTS.map((id) => (
						<Button
							key={id}
							size="sm"
							role="tab"
							aria-selected={client === id}
							variant={client === id ? "default" : "outline"}
							onClick={() => setClient(id)}
						>
							{BOARD_MCP_CLIENT_NAMES[id]}
						</Button>
					))}
				</div>
				<div className="flex items-start gap-2">
					<pre
						className="flex-1 overflow-x-auto rounded bg-muted p-2 text-xs"
						data-testid="server-mcp-snippet"
					>
						{snippet}
					</pre>
					<CopyButton text={snippet} label={t("serverMcp.copySnippet")} />
				</div>
				<p className="text-xs text-muted-foreground">
					{t(`serverMcp.where.${client}`)}
				</p>
			</div>
			<Button size="sm" variant="outline" onClick={onDone}>
				{t("serverMcp.created.done")}
			</Button>
		</div>
	);
}

export function ServerMcpSettings() {
	const { t } = useTranslation("settings");
	const [tokens, setTokens] = useState<ServerAccessToken[]>([]);
	const [name, setName] = useState("");
	const [scope, setScope] = useState<Scope>("read");
	const [ttlDays, setTtlDays] = useState<number>(90);
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [created, setCreated] = useState<ServerAccessTokenCreated | null>(null);

	const refresh = useCallback(async () => {
		const result = await window.electronAPI.serverAuth.listAccessTokens();
		if (result.success) setTokens(result.data ?? []);
		else setError(result.error ?? t("serverMcp.unavailable"));
	}, [t]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const create = async () => {
		setError(null);
		setBusy("create");
		try {
			const result = await window.electronAPI.serverAuth.createAccessToken(
				name.trim(),
				scope,
				ttlDays,
			);
			if (result.success && result.data) {
				setCreated(result.data);
				setName("");
			} else {
				setError(result.error ?? t("serverMcp.unavailable"));
			}
			await refresh();
		} finally {
			setBusy(null);
		}
	};

	const revoke = async (token: ServerAccessToken) => {
		setError(null);
		setBusy(token.id);
		try {
			const result = await window.electronAPI.serverAuth.revokeAccessToken(token.id);
			if (!result.success) setError(result.error ?? t("serverMcp.unavailable"));
			if (created?.id === token.id) setCreated(null);
			await refresh();
		} finally {
			setBusy(null);
		}
	};

	return (
		<SettingsSection
			title={t("serverMcp.title")}
			description={t("serverMcp.description")}
		>
			<p className="wp-meta">{t("serverMcp.limits")}</p>
			{error && (
				<Notice tone="red" role="alert">
					{error}
				</Notice>
			)}
			{created && <CreatedToken created={created} onDone={() => setCreated(null)} />}
			<div className="wp-card space-y-3 p-4">
				<div className="space-y-2">
					<Label htmlFor="server-mcp-name">{t("serverMcp.form.name")}</Label>
					<Input
						id="server-mcp-name"
						maxLength={80}
						placeholder={t("serverMcp.form.namePlaceholder")}
						value={name}
						onChange={(e) => setName(e.target.value)}
					/>
				</div>
				<div className="grid gap-3 sm:grid-cols-2">
					<div className="space-y-2">
						<Label htmlFor="server-mcp-scope">{t("serverMcp.form.scope")}</Label>
						<Select value={scope} onValueChange={(value) => setScope(value as Scope)}>
							<SelectTrigger id="server-mcp-scope">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="read">{t("serverMcp.scope.read")}</SelectItem>
								<SelectItem value="write">{t("serverMcp.scope.write")}</SelectItem>
							</SelectContent>
						</Select>
					</div>
					<div className="space-y-2">
						<Label htmlFor="server-mcp-ttl">{t("serverMcp.form.duration")}</Label>
						<Select value={String(ttlDays)} onValueChange={(value) => setTtlDays(Number(value))}>
							<SelectTrigger id="server-mcp-ttl">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{DURATIONS.map((days) => (
									<SelectItem key={days} value={String(days)}>
										{t("serverMcp.form.days", { count: days })}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
				</div>
				<Button onClick={() => void create()} disabled={!name.trim() || busy !== null}>
					{busy === "create" ? (
						<Loader2 className="mr-2 h-4 w-4 animate-spin" />
					) : (
						<KeyRound className="mr-2 h-4 w-4" />
					)}
					{t("serverMcp.form.create")}
				</Button>
			</div>
			<div className="space-y-2">
				<h4 className="text-sm font-medium">{t("serverMcp.list.title")}</h4>
				{tokens.length === 0 ? (
					<p className="text-sm text-muted-foreground">{t("serverMcp.list.empty")}</p>
				) : (
					<ul className="divide-y divide-border rounded-md border border-border">
						{tokens.map((token) => (
							<li
								key={token.id}
								className="flex flex-wrap items-center gap-2 p-3"
								data-testid={`server-mcp-token-${token.id}`}
							>
								<span className="font-medium">{token.name}</span>
								<code className="text-xs text-muted-foreground">{token.prefix}…</code>
								<Badge variant={token.scope === "write" ? "default" : "outline"}>
									{t(`serverMcp.scope.${token.scope}`)}
								</Badge>
								<span className="text-xs text-muted-foreground">
									{t("serverMcp.list.expires", { date: formatAppDate(token.expiresAt) })}
									{" · "}
									{token.lastUsedAt
										? t("serverMcp.list.lastUsed", { date: formatAppDate(token.lastUsedAt) })
										: t("serverMcp.list.neverUsed")}
								</span>
								<Button
									size="sm"
									variant="outline"
									className="ml-auto"
									onClick={() => void revoke(token)}
									disabled={busy !== null}
									aria-label={t("serverMcp.list.revoke", { name: token.name })}
								>
									{busy === token.id ? (
										<Loader2 className="h-3.5 w-3.5 animate-spin" />
									) : (
										<Trash2 className="h-3.5 w-3.5" />
									)}
								</Button>
							</li>
						))}
					</ul>
				)}
			</div>
		</SettingsSection>
	);
}
