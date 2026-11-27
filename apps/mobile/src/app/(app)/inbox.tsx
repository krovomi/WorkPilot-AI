/**
 * "For you": what waits on the person across every project they are in,
 * grouped by what to do (`inbox/forMe.ts`). A row opens the card.
 */

import { useRouter } from "expo-router";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, RefreshControl, SectionList, StyleSheet, Text, View } from "react-native";
import { useApi } from "../../auth/session";
import { useLoad } from "../../hooks/useLoad";
import { type InboxItem, REASONS } from "../../inbox/forMe";
import { REASON_LOOK } from "../../inbox/look";
import { useInbox } from "../../inbox/useInbox";
import { ErrorBanner, Loading, rowOpacity } from "../../ui/components";
import { timeAgo } from "../../ui/format";
import { Avatar, Chip, EmptyState } from "../../ui/kit";
import { elevation, RADIUS, SPACE, TYPE, useTheme } from "../../ui/theme";

export default function InboxScreen() {
	const { t } = useTranslation();
	const theme = useTheme();
	const api = useApi();
	const loadProjects = useCallback(() => api.projects(), [api]);
	const projects = useLoad(loadProjects);
	const inbox = useInbox(projects.data);

	if ((projects.loading && !projects.data) || (inbox.loading && !inbox.data)) return <Loading />;
	const items = inbox.data?.items ?? [];
	const unreachable = inbox.data?.unreachable ?? [];
	const sections = REASONS.map((reason) => ({
		reason,
		data: items.filter((item) => item.reason === reason),
	})).filter((section) => section.data.length > 0);
	const refreshing = projects.refreshing || inbox.refreshing;

	return (
		<SectionList<InboxItem, (typeof sections)[number]>
			sections={sections}
			keyExtractor={(item) => `${item.project.id}/${item.card.id}`}
			contentContainerStyle={styles.list}
			stickySectionHeadersEnabled={false}
			refreshControl={<RefreshControl refreshing={refreshing} onRefresh={projects.reload} tintColor={theme.accent} />}
			ListHeaderComponent={
				<View style={{ gap: SPACE.md }}>
					<Text style={[TYPE.small, { color: theme.textMuted }]}>{t("inbox.intro")}</Text>
					<ErrorBanner error={projects.error ?? inbox.error} />
					<ErrorBanner message={unreachable.length ? t("inbox.unreachable", { names: unreachable.join(", ") }) : null} />
				</View>
			}
			ListEmptyComponent={
				projects.error || inbox.error ? undefined : (
					<EmptyState icon="check-circle" title={t("inbox.empty")} hint={t("inbox.emptyHint")} />
				)
			}
			renderSectionHeader={({ section }) => (
				<Text accessibilityRole="header" style={[TYPE.overline, styles.header, { color: theme.textMuted }]}>
					{t(`inbox.reasons.${section.reason}`)} · {section.data.length}
				</Text>
			)}
			renderItem={({ item }) => <InboxRow item={item} />}
		/>
	);
}

function InboxRow({ item }: { item: InboxItem }) {
	const { t, i18n } = useTranslation();
	const theme = useTheme();
	const router = useRouter();
	const { project, card, reason } = item;
	const look = REASON_LOOK[reason];
	const color = theme[look.color];
	const when = timeAgo(card.updatedAt, t, i18n.language);
	return (
		<Pressable
			accessibilityRole="button"
			accessibilityLabel={`${card.title}, ${project.name}`}
			onPress={() =>
				router.push({ pathname: "/projects/[projectId]/cards/[cardId]", params: { projectId: project.id, cardId: card.id } })
			}
			style={({ pressed }) => [styles.row, { backgroundColor: theme.surface, opacity: rowOpacity(pressed) }, elevation(theme)]}
		>
			<View style={[styles.stripe, { backgroundColor: color }]} />
			<View style={styles.top}>
				<Avatar name={project.name} size={20} square />
				<Text style={[TYPE.caption, { color: theme.textMuted, fontWeight: "600", flexShrink: 1 }]} numberOfLines={1}>
					{project.name} · #{card.id.split("-")[0]}
				</Text>
				<View style={{ flex: 1 }} />
				{when ? <Text style={[TYPE.caption, { color: theme.textFaint }]}>{when}</Text> : null}
			</View>
			<Text style={[TYPE.body, { color: theme.text, fontWeight: "600" }]} numberOfLines={3}>
				{card.title}
			</Text>
			<Chip label={t(`inbox.chips.${reason}`)} icon={look.icon} color={color} />
		</Pressable>
	);
}

const styles = StyleSheet.create({
	list: { padding: SPACE.lg, gap: SPACE.md, paddingBottom: SPACE.xl * 2 },
	header: { marginTop: SPACE.sm },
	row: { borderRadius: RADIUS.lg, padding: SPACE.md, paddingLeft: SPACE.md + 4, gap: SPACE.sm, overflow: "hidden" },
	stripe: { position: "absolute", left: 0, top: 0, bottom: 0, width: 4 },
	top: { flexDirection: "row", alignItems: "center", gap: SPACE.sm },
});
