import { useLocalSearchParams } from "expo-router";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { FlatList, RefreshControl, StyleSheet, Text, View } from "react-native";
import { useApi } from "../../../../auth/session";
import { useLoad } from "../../../../hooks/useLoad";
import { describeError } from "../../../../i18n";
import { duration, money } from "../../../../insights/Figures";
import type { WorkSession } from "../../../../insights/types";
import { ErrorBanner, Loading } from "../../../../ui/components";
import { formatDate } from "../../../../ui/format";
import { RADIUS, SPACE, useTheme } from "../../../../ui/theme";

export default function Sessions() {
	const { projectId } = useLocalSearchParams<{ projectId: string }>();
	const { t, i18n } = useTranslation();
	const theme = useTheme();
	const api = useApi();
	const load = useCallback(() => api.sessions(projectId), [api, projectId]);
	const { data, error, loading, refreshing, reload } = useLoad(load);

	if (loading && !data) return <Loading />;
	const word = (group: string, key: string) => (i18n.exists(`${group}.${key}`) ? t(`${group}.${key}`) : key);
	return (
		<FlatList<WorkSession>
			data={data ?? []}
			keyExtractor={(s) => s.id}
			contentContainerStyle={styles.content}
			refreshControl={<RefreshControl refreshing={refreshing} onRefresh={reload} tintColor={theme.accent} />}
			ListHeaderComponent={error ? <ErrorBanner message={describeError(error)} /> : undefined}
			ListEmptyComponent={<Text style={{ color: theme.textMuted }}>{t("dashboard.noSessions")}</Text>}
			renderItem={({ item }) => {
				const color =
					item.status === "succeeded" ? theme.success : item.status === "failed" ? theme.danger : theme.textMuted;
				return (
					<View style={[styles.row, { backgroundColor: theme.surface, borderColor: theme.border }]}>
						<View style={styles.line}>
							<Text style={{ color: theme.text, fontWeight: "600", flex: 1 }} numberOfLines={1}>
								{item.spec ? `${item.spec.split("-")[0]} · ` : ""}
								{word("runPhase", item.phase)}
							</Text>
							<Text style={{ color }}>{word("runStatus", item.status)}</Text>
						</View>
						<Text style={{ color: theme.textFaint, fontSize: 12 }}>
							{[
								item.started_by,
								formatDate(item.started_at, i18n.language),
								duration(item.duration_seconds),
								item.cost !== null ? money(item.cost) : null,
							]
								.filter(Boolean)
								.join(" · ")}
						</Text>
						{item.error ? (
							<Text style={{ color: theme.danger, fontSize: 12 }} numberOfLines={3}>
								{item.error}
							</Text>
						) : null}
					</View>
				);
			}}
		/>
	);
}

const styles = StyleSheet.create({
	content: { padding: SPACE.lg, gap: SPACE.sm, paddingBottom: SPACE.xl * 2 },
	row: { borderWidth: StyleSheet.hairlineWidth, borderRadius: RADIUS.md, padding: SPACE.md, gap: SPACE.xs },
	line: { flexDirection: "row", gap: SPACE.sm },
});
