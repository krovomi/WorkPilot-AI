/**
 * Who is signed in to the organization now (`GET /admin/sessions`), by
 * person: how and when each sign-in was made, and until when it lasts.
 * Someone with `org.session.revoke` signs a person out of every device;
 * the person's own sign-ins are left to Settings.
 */

import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Alert, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useAdminApi } from "../../../admin/api";
import { loginMethodKey } from "../../../admin/audit";
import { byPerson, deviceOf } from "../../../admin/sessions";
import { useAction } from "../../../admin/useAction";
import { useSession } from "../../../auth/session";
import { useLoad } from "../../../hooks/useLoad";
import { Button, ErrorBanner, Loading } from "../../../ui/components";
import { formatDate } from "../../../ui/format";
import { EmptyState } from "../../../ui/kit";
import { RADIUS, SPACE, TYPE, useTheme } from "../../../ui/theme";

export default function Sessions() {
	const { t, i18n } = useTranslation();
	const theme = useTheme();
	const admin = useAdminApi();
	const { can, user } = useSession();
	const canRevoke = can("org.session.revoke");
	const load = useCallback(() => admin.sessions(), [admin]);
	const { data, error, loading, refreshing, reload } = useLoad(load);
	const action = useAction();
	if (loading && !data) return <Loading />;
	const people = byPerson(data ?? []);
	const lang = i18n.language;

	const revoke = (userId: string, name: string) =>
		Alert.alert(t("admin.sessions.revokeTitle", { name }), t("admin.sessions.revokeBody"), [
			{ text: t("common.cancel"), style: "cancel" },
			{
				text: t("admin.sessions.revoke"),
				style: "destructive",
				onPress: async () => {
					if (await action.run(`revoke:${userId}`, () => admin.revokeSessions(userId))) await reload();
				},
			},
		]);

	return (
		<ScrollView
			contentContainerStyle={styles.content}
			refreshControl={<RefreshControl refreshing={refreshing} onRefresh={reload} tintColor={theme.accent} />}
		>
			<ErrorBanner message={action.error} error={error} />
			{data && !people.length ? <EmptyState icon="log-in" title={t("admin.sessions.empty")} /> : null}
			{people.map((person) => {
				const self = person.userId === user?.id;
				const name = person.email ?? person.userId;
				return (
					<View key={person.userId} style={[styles.row, { borderColor: theme.border, backgroundColor: theme.surface }]}>
						<Text style={{ color: theme.text, fontWeight: "600" }}>
							{name}
							{self ? ` ${t("admin.members.you")}` : ""}
						</Text>
						{person.sessions.map((s) => (
							<Text key={s.id} style={[TYPE.small, { color: theme.textMuted }]}>
									{[
										t(`admin.audit.methods.${loginMethodKey(s.login_method)}`),
										t("admin.sessions.since", { date: formatDate(s.created_at, lang) }),
										t("admin.sessions.until", { date: formatDate(s.expires_at, lang) }),
										deviceOf(s.user_agent),
									]
										.filter(Boolean)
										.join(" · ")}
								</Text>
						))}
						{canRevoke && !self ? (
							<Button
								label={t("admin.sessions.revoke")}
								icon="log-out"
								variant="danger"
								busy={action.busy === `revoke:${person.userId}`}
								disabled={!!action.busy}
								onPress={() => revoke(person.userId, name)}
							/>
						) : null}
					</View>
				);
			})}
		</ScrollView>
	);
}

const styles = StyleSheet.create({
	content: { padding: SPACE.lg, gap: SPACE.md, paddingBottom: SPACE.xl * 2 },
	row: { borderWidth: StyleSheet.hairlineWidth, borderRadius: RADIUS.md, padding: SPACE.md, gap: SPACE.xs },
});
