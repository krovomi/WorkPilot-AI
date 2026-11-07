import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, RefreshControl, ScrollView, Share, StyleSheet, Text, View } from "react-native";
import { useAdminApi } from "../../../admin/api";
import { invitationRoles } from "../../../admin/pages";
import { Choice } from "../../../admin/Choice";
import type { CreatedInvitation } from "../../../admin/types";
import { useAction } from "../../../admin/useAction";
import { useSession } from "../../../auth/session";
import { useLoad } from "../../../hooks/useLoad";
import { describeError } from "../../../i18n";
import { Button, ErrorBanner, Field, Loading, Section } from "../../../ui/components";
import { formatDate } from "../../../ui/format";
import { RADIUS, SPACE, useTheme } from "../../../ui/theme";

export default function Invitations() {
	const { t, i18n } = useTranslation();
	const theme = useTheme();
	const admin = useAdminApi();
	const { can, permissions } = useSession();
	const canWrite = can("org.invitation.write");
	const load = useCallback(() => admin.invitations(), [admin]);
	const { data, error, loading, refreshing, reload } = useLoad(load);
	const [email, setEmail] = useState("");
	const [role, setRole] = useState("member");
	const [created, setCreated] = useState<CreatedInvitation | null>(null);
	const action = useAction();

	if (loading && !data) return <Loading />;
	const invite = async () => {
		const ok = await action.run("invite", async () => setCreated(await admin.invite(email.trim(), role)));
		if (ok) {
			setEmail("");
			await reload();
		}
	};
	const revoke = (id: string, to: string) =>
		Alert.alert(t("admin.invitations.revokeTitle", { email: to }), t("admin.invitations.revokeBody"), [
			{ text: t("common.cancel"), style: "cancel" },
			{
				text: t("admin.invitations.revoke"),
				style: "destructive",
				onPress: async () => {
					if (await action.run(`revoke:${id}`, () => admin.revokeInvitation(id))) await reload();
				},
			},
		]);

	return (
		<ScrollView
			contentContainerStyle={styles.content}
			keyboardShouldPersistTaps="handled"
			refreshControl={<RefreshControl refreshing={refreshing} onRefresh={reload} tintColor={theme.accent} />}
		>
			<ErrorBanner message={action.error ?? (error ? describeError(error) : null)} />
			{canWrite ? (
				<Section title={t("admin.invitations.new")}>
					<Field
						label={t("admin.invitations.email")}
						value={email}
						onChangeText={setEmail}
						autoCapitalize="none"
						autoCorrect={false}
						keyboardType="email-address"
						maxLength={320}
					/>
					<Choice
						options={invitationRoles(!!permissions?.is_platform_admin).map((r) => ({
							value: r,
							label: t(`admin.invitations.roles.${r}.label`),
							detail: t(`admin.invitations.roles.${r}.detail`),
						}))}
						selected={role}
						onSelect={setRole}
					/>
					<Button
						label={t("admin.invitations.send")}
						busy={action.busy === "invite"}
						disabled={!email.includes("@")}
						onPress={() => void invite()}
					/>
				</Section>
			) : null}
			{created ? (
				<View style={[styles.card, { borderColor: theme.accent, backgroundColor: theme.accentSoft }]}>
					<Text style={{ color: theme.text, fontWeight: "600" }}>
						{created.email_sent
							? t("admin.invitations.sent", { email: created.email })
							: t("admin.invitations.notSent", { email: created.email })}
					</Text>
					<Text style={{ color: theme.textMuted, fontSize: 12 }} selectable>
						{created.invite_link}
					</Text>
					<Button
						label={t("admin.invitations.share")}
						variant="secondary"
						onPress={() => void Share.share({ message: created.invite_link })}
					/>
				</View>
			) : null}
			<Section title={t("admin.invitations.pending", { count: data?.length ?? 0 })}>
				{(data ?? []).map((inv) => (
					<View key={inv.id} style={[styles.card, { borderColor: theme.border, backgroundColor: theme.surface }]}>
						<Text style={{ color: theme.text, fontWeight: "600" }}>{inv.email}</Text>
						<Text style={{ color: theme.textMuted }}>
							{[t(`admin.invitations.roles.${inv.role}.label`, { defaultValue: inv.role }), t("admin.invitations.expires", { date: formatDate(inv.expires_at, i18n.language) })].join(" · ")}
						</Text>
						{canWrite ? (
							<Button
								label={t("admin.invitations.revoke")}
								variant="danger"
								busy={action.busy === `revoke:${inv.id}`}
								onPress={() => revoke(inv.id, inv.email)}
							/>
						) : null}
					</View>
				))}
			</Section>
		</ScrollView>
	);
}

const styles = StyleSheet.create({
	content: { padding: SPACE.lg, gap: SPACE.lg, paddingBottom: SPACE.xl * 2 },
	card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: RADIUS.md, padding: SPACE.md, gap: SPACE.sm },
});
