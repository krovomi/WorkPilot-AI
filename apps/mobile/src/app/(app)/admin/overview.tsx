/**
 * The organization's control dashboard (`GET /admin/overview`): its members,
 * projects and cards, the agents running now and over the week, who started
 * the most, the last failures, and how close it is to its quotas.
 */

import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useAdminApi } from "../../../admin/api";
import { QuotaMeters } from "../../../admin/QuotaMeters";
import { useLoad } from "../../../hooks/useLoad";
import { phaseLabel } from "../../../i18n/labels";
import { count, Figures, StatTile } from "../../../insights/Figures";
import { ErrorBanner, Loading, Section } from "../../../ui/components";
import { formatDate, formatDay } from "../../../ui/format";
import { RADIUS, SPACE, TYPE, useTheme } from "../../../ui/theme";

export default function AdminOverviewScreen() {
	const { t, i18n } = useTranslation();
	const theme = useTheme();
	const admin = useAdminApi();
	const load = useCallback(() => admin.overview(), [admin]);
	const { data, error, loading, refreshing, reload } = useLoad(load);
	if (loading && !data) return <Loading />;
	const lang = i18n.language;
	const runStatus = (status: string) =>
		i18n.exists(`admin.overview.status.${status}`) ? t(`admin.overview.status.${status}`) : status;
	const busiest = Math.max(1, ...(data?.runs_by_day ?? []).map((d) => d.count));

	return (
		<ScrollView
			contentContainerStyle={styles.content}
			refreshControl={<RefreshControl refreshing={refreshing} onRefresh={reload} tintColor={theme.accent} />}
		>
			<ErrorBanner error={error} />
			{data ? (
				<>
					<View style={styles.tiles}>
						<StatTile label={t("admin.overview.running")} value={count(data.runs_active, lang)} color={theme.accent} />
						<StatTile label={t("admin.overview.queued")} value={count(data.runs_queued, lang)} />
						<StatTile
							label={t("admin.overview.success")}
							value={`${Math.round(data.run_success_rate_7d * 100)} %`}
							color={theme.success}
						/>
					</View>
					<Section title={data.org_name}>
						<Figures
							rows={[
								{
									label: t("admin.overview.members"),
									value: t("admin.overview.activeOf", {
										active: count(data.users_active, lang),
										total: count(data.users_total, lang),
									}),
								},
								{ label: t("admin.overview.projects"), value: count(data.projects_total, lang) },
								{ label: t("admin.overview.cards"), value: count(data.specs_total, lang) },
								{ label: t("admin.overview.runs24h"), value: count(data.runs_24h, lang) },
								{
									label: t("admin.overview.failed24h"),
									value: count(data.runs_failed_24h, lang),
									color: data.runs_failed_24h > 0 ? theme.danger : undefined,
								},
							]}
						/>
					</Section>
					<Section title={t("admin.overview.week")}>
						<View style={styles.bars} accessibilityRole="summary">
							{data.runs_by_day.map((day) => (
								<View
									key={day.date}
									style={styles.day}
									accessible
									accessibilityLabel={t("admin.overview.dayRuns", { date: formatDay(day.date, lang), count: day.count })}
								>
									<View style={styles.barTrack}>
										<View
											style={[
												styles.bar,
												{ height: `${(day.count / busiest) * 100}%`, backgroundColor: theme.accent },
											]}
										/>
									</View>
									<Text style={[TYPE.caption, { color: theme.textMuted }]}>{day.date.slice(8)}</Text>
								</View>
							))}
						</View>
						{Object.keys(data.runs_by_status).length ? (
							<Figures
								rows={Object.entries(data.runs_by_status).map(([status, n]) => ({
									label: runStatus(status),
									value: count(n, lang),
								}))}
							/>
						) : (
							<Text style={{ color: theme.textMuted }}>{t("admin.overview.noRuns")}</Text>
						)}
					</Section>
					{data.top_users.length ? (
						<Section title={t("admin.overview.topUsers")}>
							<Figures
								rows={data.top_users.map((u) => ({
									label: u.display_name,
									value: t("admin.overview.runs", { count: u.runs }),
								}))}
							/>
						</Section>
					) : null}
					<Section title={t("admin.quotas.title")}>
						<QuotaMeters quota={data.quota} />
					</Section>
					{data.recent_failures.length ? (
						<Section title={t("admin.overview.failures")}>
							{data.recent_failures.map((f) => (
								<View key={f.run_id} style={[styles.failure, { borderColor: theme.border }]}>
									<Text style={[TYPE.small, { color: theme.danger, fontWeight: "600" }]}>
										{phaseLabel(f.phase)} · {formatDate(f.finished_at, lang)}
									</Text>
									{f.error ? (
										<Text style={{ color: theme.textMuted }} selectable numberOfLines={4}>
											{f.error}
										</Text>
									) : null}
								</View>
							))}
						</Section>
					) : null}
				</>
			) : null}
		</ScrollView>
	);
}

const styles = StyleSheet.create({
	content: { padding: SPACE.lg, gap: SPACE.lg, paddingBottom: SPACE.xl * 2 },
	tiles: { flexDirection: "row", gap: SPACE.sm },
	bars: { flexDirection: "row", gap: SPACE.xs, alignItems: "flex-end" },
	day: { flex: 1, alignItems: "center", gap: 2 },
	barTrack: { height: 64, width: "100%", justifyContent: "flex-end" },
	bar: { width: "100%", borderRadius: RADIUS.sm, minHeight: 2 },
	failure: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: SPACE.sm, gap: SPACE.xs },
});
