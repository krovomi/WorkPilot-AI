import { useRouter } from "expo-router";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text } from "react-native";
import { useAdminApi } from "../../../../admin/api";
import { useSession } from "../../../../auth/session";
import { useLoad } from "../../../../hooks/useLoad";
import { describeError } from "../../../../i18n";
import { Button, ErrorBanner, Loading } from "../../../../ui/components";
import { RADIUS, SPACE, useTheme } from "../../../../ui/theme";

export default function Roles() {
	const { t } = useTranslation();
	const theme = useTheme();
	const router = useRouter();
	const admin = useAdminApi();
	const { can } = useSession();
	const load = useCallback(() => admin.roles(), [admin]);
	const { data, error, loading, refreshing, reload } = useLoad(load);
	if (loading && !data) return <Loading />;
	const open = (roleId: string) => router.push({ pathname: "/admin/roles/[roleId]", params: { roleId } });
	const roles = [...(data ?? [])].sort(
		(a, b) => Number(b.is_system) - Number(a.is_system) || a.scope.localeCompare(b.scope) || a.name.localeCompare(b.name),
	);
	return (
		<ScrollView
			contentContainerStyle={styles.content}
			refreshControl={<RefreshControl refreshing={refreshing} onRefresh={reload} tintColor={theme.accent} />}
		>
			<ErrorBanner message={error ? describeError(error) : null} />
			{can("org.role.write") ? <Button label={t("admin.roles.new")} onPress={() => open("new")} /> : null}
			{roles.map((r) => (
				<Pressable
					key={r.id}
					accessibilityRole="link"
					onPress={() => open(r.id)}
					style={[styles.row, { borderColor: theme.border, backgroundColor: theme.surface }]}
				>
					<Text style={{ color: theme.text, fontWeight: "600" }}>{r.name}</Text>
					<Text style={{ color: theme.textMuted }}>
						{[
							t(`admin.roles.scope.${r.scope}`, { defaultValue: r.scope }),
							r.is_system ? t("admin.roles.builtIn") : t("admin.roles.custom"),
							t("admin.roles.permissionCount", { count: r.permissions.length }),
						].join(" · ")}
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
