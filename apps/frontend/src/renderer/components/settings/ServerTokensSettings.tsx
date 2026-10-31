/**
 * The person's own integration tokens on the server (server mode).
 *
 * Each run someone starts on the server receives their tokens, so what it
 * does on GitHub, GitLab, Jira, Linear or Azure DevOps is done as them. A
 * token is typed here and sent once: the server keeps it encrypted and only
 * ever says which ones are set (`main/server-user-secrets.ts`).
 */

import { Check, KeyRound, Loader2, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Input, Label } from "@/components/ui";
import type { ServerSecretKind } from "../../../preload/api/modules/server-auth-api";

const KINDS: readonly ServerSecretKind[] = [
	"github_token",
	"gitlab_token",
	"jira_token",
	"linear_api_key",
	"azure_pat",
];

export function ServerTokensSettings() {
	const { t } = useTranslation("settings");
	const [stored, setStored] = useState<ReadonlySet<ServerSecretKind>>(new Set());
	const [drafts, setDrafts] = useState<Partial<Record<ServerSecretKind, string>>>({});
	const [busy, setBusy] = useState<ServerSecretKind | null>(null);
	const [error, setError] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		const result = await window.electronAPI.serverAuth.listSecrets();
		if (result.success) setStored(new Set(result.data ?? []));
		else setError(result.error ?? t("serverTokens.unavailable"));
	}, [t]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const run = useCallback(
		async (kind: ServerSecretKind, action: () => Promise<{ success: boolean; error?: string }>) => {
			setError(null);
			setBusy(kind);
			try {
				const result = await action();
				if (!result.success) setError(result.error ?? t("serverTokens.unavailable"));
				else setDrafts((current) => ({ ...current, [kind]: "" }));
				await refresh();
			} finally {
				setBusy(null);
			}
		},
		[refresh, t],
	);

	return (
		<div className="space-y-6">
			<div>
				<h3 className="text-lg font-semibold">{t("serverTokens.title")}</h3>
				<p className="text-sm text-muted-foreground">{t("serverTokens.description")}</p>
			</div>
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}
			<div className="space-y-3">
				{KINDS.map((kind) => {
					const draft = drafts[kind] ?? "";
					const isSet = stored.has(kind);
					return (
						<div
							key={kind}
							className="flex flex-col gap-3 rounded-lg border border-border p-4 sm:flex-row sm:items-end"
						>
							<div className="flex-1 space-y-2">
								<Label htmlFor={`server-token-${kind}`} className="flex items-center gap-2">
									<KeyRound className="h-4 w-4" />
									{t(`serverTokens.kinds.${kind}`)}
									{isSet && (
										<span className="flex items-center gap-1 text-xs text-success">
											<Check className="h-3 w-3" />
											{t("serverTokens.stored")}
										</span>
									)}
								</Label>
								<Input
									id={`server-token-${kind}`}
									type="password"
									autoComplete="off"
									placeholder={
										isSet ? t("serverTokens.replacePlaceholder") : t("serverTokens.placeholder")
									}
									value={draft}
									onChange={(e) =>
										setDrafts((current) => ({ ...current, [kind]: e.target.value }))
									}
								/>
							</div>
							<div className="flex gap-2">
								<Button
									onClick={() =>
										run(kind, () => window.electronAPI.serverAuth.setSecret(kind, draft))
									}
									disabled={!draft.trim() || busy !== null}
								>
									{busy === kind && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
									{t("serverTokens.save")}
								</Button>
								{isSet && (
									<Button
										variant="outline"
										onClick={() =>
											run(kind, () => window.electronAPI.serverAuth.deleteSecret(kind))
										}
										disabled={busy !== null}
										aria-label={t("serverTokens.remove")}
									>
										<Trash2 className="h-4 w-4" />
									</Button>
								)}
							</div>
						</div>
					);
				})}
			</div>
		</div>
	);
}
