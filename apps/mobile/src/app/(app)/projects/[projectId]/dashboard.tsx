import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useApi } from "../../../../auth/session";
import { useLoad } from "../../../../hooks/useLoad";
import { describeError } from "../../../../i18n";
import { count, Figures, money, top } from "../../../../insights/Figures";
import { Button, ErrorBanner, Loading, Section } from "../../../../ui/components";
import { SPACE, useTheme } from "../../../../ui/theme";

export default function Dashboard() {
	const { projectId } = useLocalSearchParams<{ projectId: string }>();
	const { t, i18n } = useTranslation();
	const theme = useTheme();
	const api = useApi();
	const router = useRouter();
	const load = useCallback(async () => {
		const [snapshot, costs] = await Promise.all([api.dashboard(projectId), api.costs(projectId)]);
		return { snapshot, costs };
	}, [api, projectId]);
	const { data, error, loading, refreshing, reload } = useLoad(load);

	if (loading && !data) return <Loading />;
	const lang = i18n.language;
	const label = (group: string, key: string) => (i18n.exists(`${group}.${key}`) ? t(`${group}.${key}`) : key);
	return (
		<ScrollView
			contentContainerStyle={styles.content}
			refreshControl={<RefreshControl refreshing={refreshing} onRefresh={reload} tintColor={theme.accent} />}
		>
			<ErrorBanner message={error ? describeError(error) : null} />
			<View style={styles.links}>
				<Button
					label={t("dashboard.sessions")}
					variant="secondary"
					style={{ flex: 1 }}
					onPress={() => router.push({ pathname: "/projects/[projectId]/sessions", params: { projectId } })}
				/>
				<Button
					label={t("dashboard.analyses")}
					variant="secondary"
					style={{ flex: 1 }}
					onPress={() => router.push({ pathname: "/projects/[projectId]/analyses", params: { projectId } })}
				/>
			</View>
			{data ? (
				<>
					<Section title={t("dashboard.cards")}>
						<Figures
							rows={top(data.snapshot.tasks_by_status, 12).map(([status, n]) => ({
								label: label("dashboard.status", status),
								value: count(n, lang),
							}))}
						/>
						{Object.keys(data.snapshot.tasks_by_status).length === 0 ? (
							<Text style={{ color: theme.textMuted }}>{t("dashboard.noCards")}</Text>
						) : null}
					</Section>
					<Section title={t("dashboard.quality")}>
						<Figures
							rows={[
								{ label: t("dashboard.qaFirstPass"), value: `${Math.round(data.snapshot.qa_first_pass_rate)} %` },
								{ label: t("dashboard.qaScore"), value: data.snapshot.qa_avg_score.toFixed(1) },
								{ label: t("dashboard.mergesAuto"), value: count(data.snapshot.merge_auto_count, lang) },
								{ label: t("dashboard.mergesManual"), value: count(data.snapshot.merge_manual_count, lang) },
							]}
						/>
					</Section>
					<Section title={t("dashboard.costs", { days: data.costs.period_days })}>
						<Figures
							rows={[
								{ label: t("dashboard.total"), value: money(data.costs.total_cost) },
								{ label: t("dashboard.dailyAvg"), value: money(data.costs.daily_avg) },
								...(typeof data.costs.trend_pct === "number"
									? [
											{
												label: t("dashboard.trend"),
												value: `${data.costs.trend_pct > 0 ? "+" : ""}${Math.round(data.costs.trend_pct)} %`,
												color: data.costs.trend_pct > 0 ? theme.danger : theme.success,
											},
										]
									: []),
								{ label: t("dashboard.tokens"), value: count(data.costs.total_tokens, lang) },
								...top(data.costs.cost_by_model).map(([model, cost]) => ({ label: model, value: money(cost) })),
							]}
						/>
					</Section>
					<Section title={t("dashboard.allTime")}>
						<Figures
							rows={[
								{ label: t("dashboard.total"), value: money(data.snapshot.total_cost) },
								{ label: t("dashboard.tokens"), value: count(data.snapshot.total_tokens, lang) },
							]}
						/>
					</Section>
				</>
			) : null}
		</ScrollView>
	);
}

const styles = StyleSheet.create({
	content: { padding: SPACE.lg, gap: SPACE.lg, paddingBottom: SPACE.xl * 2 },
	links: { flexDirection: "row", gap: SPACE.sm },
});
