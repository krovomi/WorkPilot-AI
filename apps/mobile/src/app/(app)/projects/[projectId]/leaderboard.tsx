/**
 * The team's leaderboard (Pixel Office on a server): the season's points of
 * the people who chose to show their name, on this project or the whole
 * organization, and the person's own score and badges whatever they chose.
 * Showing one's name is off until the person turns it on, here, for their
 * own row only; the server records the choice.
 */

import { Stack, useLocalSearchParams } from "expo-router";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshControl, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { useApi } from "../../../../auth/session";
import { useLoad } from "../../../../hooks/useLoad";
import { describeError } from "../../../../i18n";
import { ChoiceChips } from "../../../../new-card/ChoiceChips";
import { knownBadges, type LeaderboardEntry, type LeaderboardPeriod, type LeaderboardScope } from "../../../../team/types";
import { ErrorBanner, Loading, Section } from "../../../../ui/components";
import { dateLocale } from "../../../../ui/format";
import { Icon } from "../../../../ui/Icon";
import { Avatar, Chip, EmptyState } from "../../../../ui/kit";
import { elevation, RADIUS, SPACE, TYPE, useTheme } from "../../../../ui/theme";

function day(iso: string, language: string): string {
	return new Date(iso).toLocaleDateString(dateLocale(language), { day: "numeric", month: "short" });
}

export default function TeamLeaderboard() {
	const { projectId } = useLocalSearchParams<{ projectId: string }>();
	const { t, i18n } = useTranslation();
	const theme = useTheme();
	const api = useApi();
	const [scope, setScope] = useState<LeaderboardScope>("project");
	const [period, setPeriod] = useState<LeaderboardPeriod>("season");
	const load = useCallback(() => api.leaderboard(projectId, scope, period), [api, projectId, scope, period]);
	const { data, error, loading, refreshing, reload } = useLoad(load);
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);

	const consent = async (visible: boolean) => {
		setSaving(true);
		setSaveError(null);
		try {
			await api.setLeaderboardConsent(projectId, visible);
			await reload();
		} catch (err) {
			setSaveError(describeError(err));
		} finally {
			setSaving(false);
		}
	};

	if (loading && !data) return <Loading />;
	return (
		<ScrollView
			contentContainerStyle={styles.content}
			refreshControl={<RefreshControl refreshing={refreshing} onRefresh={reload} tintColor={theme.accent} />}
		>
			<Stack.Screen options={{ headerTitle: t("leaderboard.title") }} />
			<ChoiceChips<LeaderboardScope>
				label={t("leaderboard.where")}
				choices={[
					{ value: "project", label: t("leaderboard.scope.project") },
					{ value: "org", label: t("leaderboard.scope.org") },
				]}
				selected={scope}
				onSelect={setScope}
			/>
			<ChoiceChips<LeaderboardPeriod>
				label={t("leaderboard.when")}
				choices={[
					{ value: "season", label: t("leaderboard.period.season") },
					{ value: "all", label: t("leaderboard.period.all") },
				]}
				selected={period}
				onSelect={setPeriod}
			/>
			<ErrorBanner message={error ? describeError(error) : null} />
			{data ? (
				<>
					{period === "season" ? (
						<Text style={[TYPE.small, { color: theme.textMuted }]}>
							{t("leaderboard.season", {
								start: day(data.season.start, i18n.language),
								end: day(data.season.end, i18n.language),
							})}
						</Text>
					) : null}
					<View style={[styles.mine, { backgroundColor: theme.surface }, elevation(theme)]}>
						<Text style={[TYPE.label, { color: theme.textMuted }]}>{t("leaderboard.yours")}</Text>
						<Text style={[TYPE.title, { color: theme.text }]}>{t("leaderboard.points", { count: data.me.points })}</Text>
						<Text style={[TYPE.small, { color: theme.textMuted }]}>
							{t("leaderboard.tally", { delivered: data.me.delivered, reviews: data.me.reviews })}
							{" · "}
							{data.me.rank ? t("leaderboard.rank", { rank: data.me.rank }) : t("leaderboard.unranked")}
						</Text>
						<Badges badges={data.me.badges} />
					</View>
					<View style={styles.consent}>
						<View style={{ flex: 1, gap: 2 }}>
							<Text style={[TYPE.body, { color: theme.text, fontWeight: "600" }]}>{t("leaderboard.showMe")}</Text>
							<Text style={[TYPE.small, { color: theme.textMuted }]}>{t("leaderboard.showMeHint")}</Text>
						</View>
						<Switch
							accessibilityLabel={t("leaderboard.showMe")}
							value={data.me.visible}
							disabled={saving}
							onValueChange={(on) => void consent(on)}
						/>
					</View>
					<ErrorBanner message={saveError} />
					<Section title={t("leaderboard.named")} icon="award">
						{data.entries.length ? (
							data.entries.map((entry) => <EntryRow key={`${entry.rank}-${entry.name}`} entry={entry} />)
						) : (
							<EmptyState icon="users" title={t("leaderboard.empty")} hint={t("leaderboard.emptyHint")} />
						)}
					</Section>
					<Text style={[TYPE.caption, { color: theme.textFaint }]}>{t("leaderboard.howItCounts")}</Text>
				</>
			) : null}
		</ScrollView>
	);
}

function Badges({ badges }: { badges: readonly string[] }) {
	const { t } = useTranslation();
	const theme = useTheme();
	const known = knownBadges(badges);
	if (!known.length) return null;
	return (
		<View style={styles.badges}>
			{known.map((badge) => (
				<Chip key={badge} icon="star" color={theme.warning} label={t(`leaderboard.badges.${badge}`)} />
			))}
		</View>
	);
}

function EntryRow({ entry }: { entry: LeaderboardEntry }) {
	const { t } = useTranslation();
	const theme = useTheme();
	return (
		<View
			accessible
			accessibilityLabel={t("leaderboard.entry", { rank: entry.rank, name: entry.name, count: entry.points })}
			style={[styles.entry, { borderColor: entry.you ? theme.accent : theme.border, backgroundColor: theme.surface }]}
		>
			<Text style={[TYPE.label, styles.rank, { color: entry.rank <= 3 ? theme.accent : theme.textMuted }]}>
				{entry.rank}
			</Text>
			<Avatar name={entry.name} size={32} />
			<View style={{ flex: 1, gap: 2 }}>
				<Text style={[TYPE.body, { color: theme.text, fontWeight: "600" }]} numberOfLines={1}>
					{entry.you ? t("leaderboard.youName", { name: entry.name }) : entry.name}
				</Text>
				<Text style={[TYPE.small, { color: theme.textMuted }]}>
					{t("leaderboard.tally", { delivered: entry.delivered, reviews: entry.reviews })}
				</Text>
				<Badges badges={entry.badges} />
			</View>
			<View style={styles.points}>
				<Icon name="award" size={14} color={theme.accent} />
				<Text style={[TYPE.label, { color: theme.text }]}>{entry.points}</Text>
			</View>
		</View>
	);
}

const styles = StyleSheet.create({
	content: { padding: SPACE.lg, gap: SPACE.lg, paddingBottom: SPACE.xl * 2 },
	mine: { borderRadius: RADIUS.lg, padding: SPACE.lg, gap: SPACE.xs },
	consent: { flexDirection: "row", alignItems: "center", gap: SPACE.md },
	badges: { flexDirection: "row", flexWrap: "wrap", gap: SPACE.xs, marginTop: SPACE.xs },
	entry: { flexDirection: "row", alignItems: "center", gap: SPACE.md, borderWidth: 1, borderRadius: RADIUS.md, padding: SPACE.md },
	rank: { width: 24, textAlign: "center" },
	points: { flexDirection: "row", alignItems: "center", gap: 4 },
});
