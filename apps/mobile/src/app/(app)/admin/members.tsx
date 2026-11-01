import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { orgRoles, useAdminApi } from "../../../admin/api";
import { Choice } from "../../../admin/Choice";
import { useAction } from "../../../admin/useAction";
import { useSession } from "../../../auth/session";
import { useLoad } from "../../../hooks/useLoad";
import { describeError } from "../../../i18n";
import { Button, ErrorBanner, Loading } from "../../../ui/components";
import { RADIUS, SPACE, useTheme } from "../../../ui/theme";

export default function Members() {
	const { t } = useTranslation();
	const theme = useTheme();
	const admin = useAdminApi();
	const { can, user } = useSession();
	const canWrite = can("org.member.write");
	const load = useCallback(async () => {
		const [members, roles] = await Promise.all([
			admin.members(),
			can("org.role.read") ? admin.roles().catch(() => []) : Promise.resolve([]),
		]);
		return { members, roles: orgRoles(roles) };
	}, [admin, can]);
	const { data, error, loading, refreshing, reload } = useLoad(load);
	const [open, setOpen] = useState<string | null>(null);
	const action = useAction();

	if (loading && !data) return <Loading />;
	const remove = (userId: string, name: string) =>
		Alert.alert(t("admin.members.removeTitle", { name }), t("admin.members.removeBody"), [
			{ text: t("common.cancel"), style: "cancel" },
			{
				text: t("admin.remove"),
				style: "destructive",
				onPress: async () => {
					if (await action.run(`remove:${userId}`, () => admin.removeMember(userId))) await reload();
				},
			},
		]);

	return (
		<ScrollView
			contentContainerStyle={styles.content}
			refreshControl={<RefreshControl refreshing={refreshing} onRefresh={reload} tintColor={theme.accent} />}
		>
			<ErrorBanner message={action.error ?? (error ? describeError(error) : null)} />
			{(data?.members ?? []).map((m) => {
				const expanded = open === m.user_id;
				const self = m.user_id === user?.id;
				return (
					<View key={m.user_id} style={[styles.row, { borderColor: theme.border, backgroundColor: theme.surface }]}>
						<Pressable
							accessibilityRole="button"
							accessibilityState={{ expanded }}
							disabled={!canWrite || self}
							onPress={() => setOpen(expanded ? null : m.user_id)}
						>
							<Text style={{ color: theme.text, fontWeight: "600" }}>
								{m.display_name}
								{self ? ` ${t("admin.members.you")}` : ""}
							</Text>
							<Text style={{ color: theme.textMuted }}>
								{[m.email, m.role_name, m.is_active ? null : t("admin.members.inactive")].filter(Boolean).join(" · ")}
							</Text>
						</Pressable>
						{expanded ? (
							<>
								{data?.roles.length ? (
									<Choice
										options={data.roles.map((r) => ({ value: r.slug, label: r.name, detail: r.description }))}
										selected={m.role_slug}
										disabled={!!action.busy}
										onSelect={async (slug) => {
											if (slug === m.role_slug) return;
											if (await action.run(`role:${m.user_id}`, () => admin.setMemberRole(m.user_id, slug))) await reload();
										}}
									/>
								) : null}
								<Button
									label={t("admin.members.remove")}
									variant="danger"
									busy={action.busy === `remove:${m.user_id}`}
									onPress={() => remove(m.user_id, m.display_name)}
								/>
							</>
						) : null}
					</View>
				);
			})}
		</ScrollView>
	);
}

const styles = StyleSheet.create({
	content: { padding: SPACE.lg, gap: SPACE.md, paddingBottom: SPACE.xl * 2 },
	row: { borderWidth: StyleSheet.hairlineWidth, borderRadius: RADIUS.md, padding: SPACE.md, gap: SPACE.sm },
});
