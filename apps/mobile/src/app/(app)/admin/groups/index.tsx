import { useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text } from "react-native";
import { useAdminApi } from "../../../../admin/api";
import { useAction } from "../../../../admin/useAction";
import { useSession } from "../../../../auth/session";
import { useLoad } from "../../../../hooks/useLoad";
import { describeError } from "../../../../i18n";
import { Button, ErrorBanner, Field, Loading, Section } from "../../../../ui/components";
import { RADIUS, SPACE, useTheme } from "../../../../ui/theme";

export default function Groups() {
	const { t } = useTranslation();
	const theme = useTheme();
	const router = useRouter();
	const admin = useAdminApi();
	const { can } = useSession();
	const load = useCallback(() => admin.groups(), [admin]);
	const { data, error, loading, refreshing, reload } = useLoad(load);
	const [name, setName] = useState("");
	const action = useAction();

	if (loading && !data) return <Loading />;
	const create = async () => {
		if (await action.run("create", () => admin.createGroup(name.trim(), ""))) {
			setName("");
			await reload();
		}
	};
	return (
		<ScrollView
			contentContainerStyle={styles.content}
			keyboardShouldPersistTaps="handled"
			refreshControl={<RefreshControl refreshing={refreshing} onRefresh={reload} tintColor={theme.accent} />}
		>
			<ErrorBanner message={action.error ?? (error ? describeError(error) : null)} />
			{can("org.member.write") ? (
				<Section title={t("admin.groups.new")}>
					<Field label={t("admin.groups.name")} value={name} onChangeText={setName} maxLength={120} />
					<Button
						label={t("admin.groups.create")}
						busy={action.busy === "create"}
						disabled={!name.trim()}
						onPress={() => void create()}
					/>
				</Section>
			) : null}
			{!data?.length ? <Text style={{ color: theme.textMuted }}>{t("admin.groups.none")}</Text> : null}
			{(data ?? []).map((g) => (
				<Pressable
					key={g.id}
					accessibilityRole="link"
					onPress={() => router.push({ pathname: "/admin/groups/[groupId]", params: { groupId: g.id } })}
					style={[styles.row, { borderColor: theme.border, backgroundColor: theme.surface }]}
				>
					<Text style={{ color: theme.text, fontWeight: "600" }}>{g.name}</Text>
					<Text style={{ color: theme.textMuted }}>
						{[
							t("admin.groups.memberCount", { count: g.members.length }),
							t("admin.groups.projectCount", { count: g.projects.length }),
							g.role_name,
						]
							.filter(Boolean)
							.join(" · ")}
					</Text>
				</Pressable>
			))}
		</ScrollView>
	);
}

const styles = StyleSheet.create({
	content: { padding: SPACE.lg, gap: SPACE.md, paddingBottom: SPACE.xl * 2 },
	row: { borderWidth: StyleSheet.hairlineWidth, borderRadius: RADIUS.md, padding: SPACE.md, gap: SPACE.xs },
});
