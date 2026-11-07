import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { useApi, useSession } from "../../../../../auth/session";
import type { InsightSummary } from "../../../../../features/types";
import { useLoad } from "../../../../../hooks/useLoad";
import { describeError } from "../../../../../i18n";
import { Button, ErrorBanner, Loading } from "../../../../../ui/components";
import { formatDate } from "../../../../../ui/format";
import { RADIUS, SPACE, useTheme } from "../../../../../ui/theme";

export default function Insights() {
	const { projectId } = useLocalSearchParams<{ projectId: string }>();
	const { t, i18n } = useTranslation();
	const theme = useTheme();
	const api = useApi();
	const { can } = useSession();
	const router = useRouter();
	const load = useCallback(() => api.insightSessions(projectId), [api, projectId]);
	const { data, error, loading, refreshing, reload } = useLoad(load);
	const [busy, setBusy] = useState(false);
	const [actionError, setActionError] = useState<string | null>(null);

	const open = (sessionId: string) =>
		router.push({ pathname: "/projects/[projectId]/insights/[sessionId]", params: { projectId, sessionId } });

	const create = async () => {
		setBusy(true);
		setActionError(null);
		try {
			open((await api.createInsight(projectId)).id);
		} catch (err) {
			setActionError(describeError(err));
		} finally {
			setBusy(false);
		}
	};

	if (loading && !data) return <Loading />;
	return (
		<FlatList<InsightSummary>
			data={data ?? []}
			keyExtractor={(s) => s.id}
			contentContainerStyle={styles.content}
			refreshControl={<RefreshControl refreshing={refreshing} onRefresh={reload} tintColor={theme.accent} />}
			ListHeaderComponent={
				<View style={{ gap: SPACE.sm }}>
					<Text style={{ color: theme.textMuted }}>{t("insights.intro")}</Text>
					<ErrorBanner message={actionError ?? (error ? describeError(error) : null)} />
					{can("insight.write") ? (
						<Button label={t("insights.new")} busy={busy} onPress={() => void create()} />
					) : null}
				</View>
			}
			ListEmptyComponent={<Text style={{ color: theme.textMuted }}>{t("insights.empty")}</Text>}
			renderItem={({ item }) => (
				<Pressable
					accessibilityRole="button"
					onPress={() => open(item.id)}
					style={[styles.row, { backgroundColor: theme.surface, borderColor: theme.border }]}
				>
					<Text style={{ color: theme.text, fontWeight: "600" }} numberOfLines={2}>
						{item.title}
					</Text>
					<Text style={{ color: theme.textFaint, fontSize: 12 }}>
						{t("insights.meta", {
							owner: item.mine ? t("insights.you") : (item.ownerName ?? "?"),
							count: item.messageCount,
							date: formatDate(item.updatedAt, i18n.language),
						})}
					</Text>
				</Pressable>
			)}
		/>
	);
}

const styles = StyleSheet.create({
	content: { padding: SPACE.lg, gap: SPACE.sm, paddingBottom: SPACE.xl * 2 },
	row: { borderWidth: StyleSheet.hairlineWidth, borderRadius: RADIUS.md, padding: SPACE.md, gap: SPACE.xs },
});
