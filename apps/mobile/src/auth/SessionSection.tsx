/**
 * "My session" on the settings screen: who is signed in, how the session was
 * opened (a password, Microsoft Entra ID, the server's OpenID Connect
 * provider, an invitation) and since when, as the server reports it
 * (`GET /auth/me/session`). Display only, from bounded fields (`my-session.ts`).
 */

import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { useLoad } from "../hooks/useLoad";
import { ErrorBanner, Section } from "../ui/components";
import { formatDate } from "../ui/format";
import { SPACE, useTheme } from "../ui/theme";
import { type MySession, toMySession } from "./my-session";
import { useApi, useSession } from "./session";

function Row({ label, value }: { label: string; value: string }) {
	const theme = useTheme();
	return (
		<View style={styles.row}>
			<Text style={{ color: theme.textMuted, fontSize: 13 }}>{label}</Text>
			<Text style={{ color: theme.text }} selectable>
				{value}
			</Text>
		</View>
	);
}

function Details({ session }: { session: MySession }) {
	const { t, i18n } = useTranslation();
	const method = session.method
		? t(`mySession.methods.${session.method}`, { name: session.providerName ?? "SSO" })
		: t("mySession.methods.unknown");
	return (
		<>
			<Row label={t("mySession.method")} value={method} />
			{session.issuerHost ? <Row label={t("mySession.issuer")} value={session.issuerHost} /> : null}
			{session.signedInAt ? (
				<Row label={t("mySession.signedInAt")} value={formatDate(session.signedInAt, i18n.language)} />
			) : null}
		</>
	);
}

export function SessionSection() {
	const { t } = useTranslation();
	const theme = useTheme();
	const { user } = useSession();
	const api = useApi();
	const load = useCallback(async () => toMySession(await api.mySession()), [api]);
	const { data, error, loading } = useLoad(load);

	let details = null;
	if (loading) details = <ActivityIndicator color={theme.accent} accessibilityLabel={t("mySession.loading")} />;
	else if (error) details = <ErrorBanner error={error} />;
	else if (data) details = <Details session={data} />;
	else details = <ErrorBanner message={t("mySession.unavailable")} />;

	return (
		<Section title={t("mySession.title")}>
			<Text style={{ color: theme.text, fontSize: 16, fontWeight: "600" }}>{user?.display_name}</Text>
			<Text style={{ color: theme.textMuted }}>{user?.email}</Text>
			{details}
		</Section>
	);
}

const styles = StyleSheet.create({
	row: { gap: SPACE.xs },
});
