import { Stack, useRouter } from "expo-router";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import type { ServerProject } from "../../api/types";
import { useApi, useSession } from "../../auth/session";
import { useLoad } from "../../hooks/useLoad";
import { ErrorBanner, Loading, rowOpacity } from "../../ui/components";
import { repoLabel } from "../../ui/format";
import { Icon, type IconName } from "../../ui/Icon";
import { Avatar, Chip, EmptyState, IconButton } from "../../ui/kit";
import { elevation, RADIUS, SPACE, TYPE, useTheme } from "../../ui/theme";
import { projectRoleLabel } from "../../i18n/labels";

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
		<IconButton icon="settings" label={t("projects.settings")} onPress={() => router.push("/settings")} />
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
				ListHeaderComponent={
					<View style={{ gap: SPACE.md }}>
						<Text style={[TYPE.overline, { color: theme.textMuted }]}>
							{t("projects.count", { count: data?.length ?? 0 })}
						</Text>
						<ErrorBanner error={error} />
					</View>
				}
				ListEmptyComponent={
					error ? undefined : <EmptyState icon="folder" title={t("projects.empty")} />
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
							{ backgroundColor: theme.surface, opacity: rowOpacity(pressed) },
							elevation(theme),
						]}
					>
						<Avatar name={item.name} size={44} square />
						<View style={{ flex: 1, gap: 4 }}>
							<Text style={[TYPE.heading, { color: theme.text, fontSize: 17 }]} numberOfLines={1}>
								{item.name}
							</Text>
							<View style={styles.meta}>
								<Icon name={forgeIcon(item.forge)} size={13} color={theme.textMuted} />
								<Text style={[TYPE.small, { color: theme.textMuted, flexShrink: 1 }]} numberOfLines={1}>
									{repoLabel(item.repo_url)}
								</Text>
								<Icon name="git-branch" size={13} color={theme.textMuted} />
								<Text style={[TYPE.small, { color: theme.textMuted }]} numberOfLines={1}>
									{item.default_branch}
								</Text>
							</View>
							{item.my_role ? <Chip label={projectRoleLabel(item.my_role)} icon="user" /> : null}
						</View>
						<Icon name="chevron-right" size={20} color={theme.textFaint} />
					</Pressable>
				)}
			/>
		</>
	);
}

/** The forge's mark next to the repository. */
function forgeIcon(forge: string | null | undefined): IconName {
	return forge === "github" ? "github" : forge === "gitlab" ? "gitlab" : "folder";
}

const styles = StyleSheet.create({
	list: { padding: SPACE.lg, gap: SPACE.md },
	row: {
		flexDirection: "row",
		alignItems: "center",
		gap: SPACE.md,
		borderRadius: RADIUS.lg,
		padding: SPACE.lg,
	},
	meta: { flexDirection: "row", alignItems: "center", gap: 4 },
});
