/**
 * The current server session (server mode): who is signed in, how the
 * session was opened (a password, Microsoft Entra ID, the server's OpenID
 * Connect provider, an invitation) and when, as the server reports it
 * (`main/server-session-info.ts`). Display only: the tokens stay in main.
 */

import { Loader2, LogOut } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui";
import { formatAppDateTime } from "@/lib/date-format";
import { useServerSessionStore } from "@/stores/server-session-store";
import type { ServerSessionInfo } from "../../../shared/types/server-session";
import { Notice } from "../charter";
import { SettingsSection } from "./SettingsSection";

function Row({ label, children }: { readonly label: string; readonly children: React.ReactNode }) {
	return (
		<div className="flex flex-col gap-1 sm:flex-row sm:gap-4">
			<dt className="w-48 shrink-0 text-sm text-muted-foreground">{label}</dt>
			<dd className="text-sm break-all">{children}</dd>
		</div>
	);
}

export function ServerSessionSettings() {
	const { t } = useTranslation("settings");
	const logout = useServerSessionStore((s) => s.logout);
	const [session, setSession] = useState<ServerSessionInfo | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [signingOut, setSigningOut] = useState(false);

	useEffect(() => {
		let current = true;
		void window.electronAPI.serverAuth.getSession().then((result) => {
			if (!current) return;
			if (result.success && result.data) setSession(result.data);
			else setError(result.error ?? t("serverSession.unavailable"));
		});
		return () => {
			current = false;
		};
	}, [t]);

	const signOut = useCallback(async () => {
		setSigningOut(true);
		try {
			await logout();
		} finally {
			setSigningOut(false);
		}
	}, [logout]);

	const method = session?.method
		? t(`serverSession.methods.${session.method}`, { name: session.providerName ?? "SSO" })
		: t("serverSession.methods.unknown");

	return (
		<SettingsSection
			title={t("serverSession.title")}
			description={t("serverSession.description")}
		>
			{error && (
				<Notice tone="red" role="alert">
					{error}
				</Notice>
			)}
			{!session && !error && (
				<Loader2 className="h-4 w-4 animate-spin" aria-label={t("serverSession.loading")} />
			)}
			{session && (
				<dl className="space-y-3 rounded-lg border border-border p-4" data-testid="server-session">
					<Row label={t("serverSession.server")}>{session.serverUrl}</Row>
					<Row label={t("serverSession.identity")}>
						{t("serverSession.identityValue", {
							name: session.user.displayName,
							email: session.user.email,
						})}
					</Row>
					{session.user.role && <Row label={t("serverSession.role")}>{session.user.role}</Row>}
					<Row label={t("serverSession.method")}>{method}</Row>
					{session.issuerHost && (
						<Row label={t("serverSession.issuer")}>{session.issuerHost}</Row>
					)}
					{session.signedInAt && (
						<Row label={t("serverSession.signedInAt")}>
							{formatAppDateTime(session.signedInAt)}
						</Row>
					)}
				</dl>
			)}
			<Button variant="outline" onClick={signOut} disabled={signingOut}>
				{signingOut ? (
					<Loader2 className="mr-2 h-4 w-4 animate-spin" />
				) : (
					<LogOut className="mr-2 h-4 w-4" />
				)}
				{t("serverSession.signOut")}
			</Button>
		</SettingsSection>
	);
}
