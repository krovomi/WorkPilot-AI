import { Link, Stack, useRouter } from "expo-router";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import type { ServerProject } from "../../api/types";
import { useApi, useSession } from "../../auth/session";
import { useLoad } from "../../hooks/useLoad";
import { describeError } from "../../i18n";
import { ErrorBanner, Loading } from "../../ui/components";
import { repoLabel } from "../../ui/format";
import { RADIUS, SPACE, useTheme } from "../../ui/theme";

export default function Projects() {
	const { t } = useTranslation();
	const theme = useTheme();
	const api = useApi();
	const { permissions } = useSession();
	const router = useRouter();
	const load = useCallback(() => api.projects(), [api]);
	const { data, error, loading, refreshing, reload } = useLoad(load);
	const org = permissions?.organizations.find((o) => o.id === permissions.org_id);

	const settings = () => (
		<Link href="/settings" asChild>
			<Pressable accessibilityRole="button" hitSlop={12} style={{ paddingHorizontal: SPACE.sm }}>
				<Text style={{ color: theme.accent, fontSize: 16 }}>{t("projects.settings")}</Text>
			</Pressable>
		</Link>
	);

	if (loading && !data) return <Loading />;
	return (
		<>
			<Stack.Screen options={{ headerRight: settings, headerTitle: org?.name ?? t("projects.title") }} />
			<FlatList<ServerProject>
				data={data ?? []}
				keyExtractor={(p) => p.id}
				contentContainerStyle={styles.list}
				refreshControl={<RefreshControl refreshing={refreshing} onRefresh={reload} tintColor={theme.accent} />}
				ListHeaderComponent={error ? <ErrorBanner message={describeError(error)} /> : undefined}
				ListEmptyComponent={
					error ? undefined : <Text style={{ color: theme.textMuted, textAlign: "center" }}>{t("projects.empty")}</Text>
				}
				renderItem={({ item }) => (
					<Pressable
						accessibilityRole="button"
						accessibilityLabel={item.name}
						onPress={() =>
							router.push({ pathname: "/projects/[projectId]", params: { projectId: item.id, name: item.name } })
						}
						style={({ pressed }) => [
							styles.row,
							{ backgroundColor: theme.surface, borderColor: theme.border, opacity: pressed ? 0.85 : 1 },
						]}
					>
						<View style={{ flex: 1, gap: 2 }}>
							<Text style={[styles.name, { color: theme.text }]}>{item.name}</Text>
							<Text style={{ color: theme.textMuted }} numberOfLines={1}>
								{repoLabel(item.repo_url)} · {item.default_branch}
							</Text>
						</View>
						{item.my_role ? (
							<Text style={{ color: theme.textFaint, fontSize: 12 }}>{t("projects.role", { role: item.my_role })}</Text>
						) : null}
					</Pressable>
				)}
			/>
		</>
	);
}

const styles = StyleSheet.create({
	list: { padding: SPACE.lg, gap: SPACE.md },
	row: {
		flexDirection: "row",
		alignItems: "center",
		gap: SPACE.md,
		borderWidth: 1,
		borderRadius: RADIUS.lg,
		padding: SPACE.lg,
	},
	name: { fontSize: 17, fontWeight: "600" },
});
