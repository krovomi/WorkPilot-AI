import { useLocalSearchParams, useRouter } from "expo-router";
import { Tabs } from "expo-router/js-tabs";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import type { BoardCard, CardKind, Column } from "../../../../../api/types";
import { useProjectId } from "../../../../../project/ProjectId";
import { useSession } from "../../../../../auth/session";
import { groupByColumn } from "../../../../../board/columns";
import { initialColumn } from "../../../../../board/pickColumn";
import { groupColor, inGroup } from "../../../../../board/splitGroup";
import { useBoard } from "../../../../../board/useBoard";
import { useProject } from "../../../../../forge/useForge";
import { describeError } from "../../../../../i18n";
import { ErrorBanner, Loading, rowOpacity } from "../../../../../ui/components";
import { timeAgo } from "../../../../../ui/format";
import { Icon, type IconName } from "../../../../../ui/Icon";
import { Avatar, Chip, EmptyState, Fab } from "../../../../../ui/kit";
import { columnColor, elevation, RADIUS, SPACE, TYPE, useTheme } from "../../../../../ui/theme";

const KIND_ICONS: Record<CardKind, IconName> = {
	feature: "star",
	bug_fix: "tool",
	refactoring: "refresh-cw",
	investigation: "search",
	docs: "file-text",
	test: "check-square",
};

export default function Board() {
	const projectId = useProjectId();
	const { name } = useLocalSearchParams<{ name?: string }>();
	const { t } = useTranslation();
	const theme = useTheme();
	const router = useRouter();
	const { can } = useSession();
	const { cards, error, live, refreshing, reload } = useBoard(projectId);
	const project = useProject(projectId).data;
	// One split group shown alone, from a tap on a part's mark.
	const [splitGroup, setSplitGroup] = useState<string | null>(null);
	const groups = useMemo(() => groupByColumn(inGroup(cards ?? [], splitGroup)), [cards, splitGroup]);
	const [chosen, setChosen] = useState<Column | null>(null);
	const column = chosen ?? initialColumn(groups);
	const shown = groups.find((g) => g.column === column)?.cards ?? [];
	const toggleGroup = (id: string) => setSplitGroup((current) => (current === id ? null : id));

	const status = () => (
		<View
			accessibilityLabel={live ? t("board.live") : t("board.offline")}
			style={[styles.live, { backgroundColor: theme.elevated }]}
		>
			<View style={[styles.dot, { backgroundColor: live ? theme.success : theme.textFaint }]} />
			<Text style={[TYPE.caption, { color: theme.textMuted, fontWeight: "600" }]}>
				{live ? t("board.live") : t("board.sync")}
			</Text>
		</View>
	);

	if (!cards && !error) return <Loading />;
	return (
		<View style={{ flex: 1 }}>
			<Tabs.Screen options={{ headerTitle: project?.name ?? name ?? "", headerRight: status }} />
			<ScrollView
				horizontal
				showsHorizontalScrollIndicator={false}
				style={[styles.tabsBar, { backgroundColor: theme.surface, borderColor: theme.border }]}
				contentContainerStyle={styles.tabs}
				accessibilityRole="tablist"
			>
				{groups.map((group) => {
					const selected = group.column === column;
					return (
						<Pressable
							key={group.column}
							accessibilityRole="tab"
							accessibilityState={{ selected }}
							onPress={() => setChosen(group.column)}
							style={[styles.tab, { backgroundColor: selected ? theme.accentSoft : "transparent" }]}
						>
							<View style={[styles.dot, { backgroundColor: columnColor(theme, group.column) }]} />
							<Text style={[TYPE.label, { color: selected ? theme.text : theme.textMuted }]}>
								{t(`columns.${group.column}`)}
							</Text>
							<View style={[styles.count, { backgroundColor: selected ? theme.accent : theme.elevated }]}>
								<Text style={[TYPE.caption, { color: selected ? theme.onAccent : theme.textMuted, fontWeight: "700" }]}>
									{group.cards.length}
								</Text>
							</View>
						</Pressable>
					);
				})}
			</ScrollView>
			{splitGroup ? (
				<Pressable
					accessibilityRole="button"
					accessibilityLabel={t("board.showAll")}
					onPress={() => setSplitGroup(null)}
					style={[styles.groupFilter, { borderColor: groupColor(splitGroup, theme.dark) }]}
				>
					<Icon name="x" size={14} color={groupColor(splitGroup, theme.dark)} />
					<Text style={{ color: groupColor(splitGroup, theme.dark), fontWeight: "600" }} numberOfLines={1}>
						{t("board.groupFilter", { group: splitGroup })}
					</Text>
				</Pressable>
			) : null}
			<FlatList<BoardCard>
				data={shown}
				keyExtractor={(c) => c.id}
				contentContainerStyle={styles.list}
				refreshControl={<RefreshControl refreshing={refreshing} onRefresh={reload} tintColor={theme.accent} />}
				ListHeaderComponent={error ? <ErrorBanner message={describeError(error)} /> : undefined}
				ListEmptyComponent={
					<EmptyState icon="inbox" title={t("board.emptyColumn")} hint={t("board.emptyHint")} />
				}
				renderItem={({ item }) => (
					<CardRow
						card={item}
						onGroup={toggleGroup}
						onPress={() =>
							router.push({
								pathname: "/projects/[projectId]/cards/[cardId]",
								params: { projectId, cardId: item.id },
							})
						}
					/>
				)}
			/>
			{can("task.write") ? (
				<Fab
					icon="plus"
					label={t("board.newCard")}
					onPress={() => router.push({ pathname: "/projects/[projectId]/new", params: { projectId } })}
				/>
			) : null}
		</View>
	);
}

function CardRow({
	card,
	onPress,
	onGroup,
}: {
	card: BoardCard;
	onPress: () => void;
	onGroup: (group: string) => void;
}) {
	const { t, i18n } = useTranslation();
	const theme = useTheme();
	const { completed, total } = card.subtasks;
	const { group } = card;
	const when = timeAgo(card.updatedAt, t, i18n.language);
	return (
		<Pressable
			accessibilityRole="button"
			accessibilityLabel={card.title}
			onPress={onPress}
			style={({ pressed }) => [
				styles.card,
				{ backgroundColor: theme.surface, opacity: rowOpacity(pressed) },
				elevation(theme),
			]}
		>
			<View style={[styles.stripe, { backgroundColor: columnColor(theme, card.column) }]} />
			<View style={styles.cardTop}>
				<Text style={[TYPE.caption, { color: theme.textFaint, fontWeight: "600" }]}>#{card.id.split("-")[0]}</Text>
				{card.kind ? <Chip label={t(`kinds.${card.kind}`)} icon={KIND_ICONS[card.kind]} /> : null}
				{card.flagged ? <Chip label={t("board.flagged")} icon="flag" color={theme.danger} /> : null}
				<View style={{ flex: 1 }} />
				{when ? <Text style={[TYPE.caption, { color: theme.textFaint }]}>{when}</Text> : null}
			</View>
			{group ? <GroupMark group={group} onPress={() => onGroup(group.id)} /> : null}
			<Text style={[TYPE.body, { color: theme.text, fontWeight: "600" }]} numberOfLines={3}>
				{card.title}
			</Text>
			{total > 0 ? (
				<View style={styles.progress}>
					<View style={[styles.track, { backgroundColor: theme.elevated }]}>
						<View
							style={[styles.fill, { backgroundColor: theme.accent, width: `${Math.round((completed / total) * 100)}%` }]}
						/>
					</View>
					<Text style={[TYPE.caption, { color: theme.textMuted }]}>{t("board.subtasks", { completed, total })}</Text>
				</View>
			) : null}
			{card.claimedByName ? (
				<View style={styles.owner}>
					<Avatar name={card.claimedByName} size={22} />
					<Text style={[TYPE.small, { color: theme.textMuted }]} numberOfLines={1}>
						{t("board.claimedBy", { name: card.claimedByName })}
					</Text>
				</View>
			) : null}
		</Pressable>
	);
}

/** « Partie 2/4 · OAuth » in the group's colour: written, so colour is never the only sign. */
function GroupMark({ group, onPress }: { group: NonNullable<BoardCard["group"]>; onPress: () => void }) {
	const { t } = useTranslation();
	const theme = useTheme();
	const color = groupColor(group.id, theme.dark);
	const label = t("board.groupMark", { index: group.index, total: group.total, title: group.title });
	return (
		<Pressable
			accessibilityRole="button"
			accessibilityLabel={label}
			accessibilityHint={t("board.groupHint")}
			hitSlop={8}
			onPress={onPress}
			style={[styles.groupMark, { borderColor: color }]}
		>
			<View style={[styles.dot, { backgroundColor: color }]} />
			<Text style={{ color, fontSize: 12, fontWeight: "600", flexShrink: 1 }} numberOfLines={1}>
				{label}
			</Text>
		</Pressable>
	);
}

const styles = StyleSheet.create({
	live: {
		flexDirection: "row",
		alignItems: "center",
		gap: 6,
		borderRadius: RADIUS.pill,
		paddingHorizontal: SPACE.sm + 2,
		paddingVertical: 4,
		marginRight: SPACE.sm,
	},
	dot: { width: 8, height: 8, borderRadius: 4 },
	tabsBar: { flexGrow: 0, borderBottomWidth: StyleSheet.hairlineWidth },
	tabs: { paddingHorizontal: SPACE.md, paddingVertical: SPACE.sm, gap: SPACE.xs },
	tab: {
		flexDirection: "row",
		alignItems: "center",
		gap: SPACE.sm,
		borderRadius: RADIUS.pill,
		paddingLeft: SPACE.md,
		paddingRight: SPACE.sm,
		minHeight: 40,
	},
	count: { minWidth: 22, height: 22, borderRadius: 11, paddingHorizontal: 6, alignItems: "center", justifyContent: "center" },
	// Room under the last card for the floating button.
	list: { padding: SPACE.lg, paddingBottom: 96, gap: SPACE.md },
	card: { borderRadius: RADIUS.lg, padding: SPACE.lg, paddingLeft: SPACE.lg + 4, gap: SPACE.sm, overflow: "hidden" },
	stripe: { position: "absolute", left: 0, top: 0, bottom: 0, width: 4 },
	cardTop: { flexDirection: "row", alignItems: "center", gap: SPACE.sm },
	progress: { flexDirection: "row", alignItems: "center", gap: SPACE.sm },
	owner: { flexDirection: "row", alignItems: "center", gap: SPACE.sm },
	groupMark: {
		flexDirection: "row",
		alignItems: "center",
		alignSelf: "flex-start",
		gap: SPACE.xs,
		borderWidth: 1,
		borderRadius: 999,
		paddingHorizontal: SPACE.sm,
		paddingVertical: 2,
		maxWidth: "100%",
	},
	groupFilter: {
		flexDirection: "row",
		alignItems: "center",
		gap: SPACE.xs,
		alignSelf: "flex-start",
		marginHorizontal: SPACE.lg,
		marginTop: SPACE.md,
		borderWidth: 1,
		borderRadius: 999,
		paddingHorizontal: SPACE.md,
		paddingVertical: SPACE.xs,
	},
	track: { flex: 1, height: 6, borderRadius: 3, overflow: "hidden" },
	fill: { height: 6, borderRadius: 3 },
});
