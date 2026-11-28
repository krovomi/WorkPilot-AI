import { useLocalSearchParams, useRouter } from "expo-router";
import { Tabs } from "expo-router/js-tabs";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import type { BoardCard, Column } from "../../../../../api/types";
import { useProjectId } from "../../../../../project/ProjectId";
import { useSession, useUserId } from "../../../../../auth/session";
import { CardRow } from "../../../../../board/CardRow";
import { groupByColumn } from "../../../../../board/columns";
import { FilterBar } from "../../../../../board/FilterBar";
import { filterCards, isFiltering, NO_FILTER } from "../../../../../board/filter";
import { useQuickActions } from "../../../../../board/QuickActions";
import { WIDE_BOARD, WideBoard } from "../../../../../board/WideBoard";
import { initialColumn } from "../../../../../board/pickColumn";
import { groupColor, inGroup } from "../../../../../board/splitGroup";
import { useBoard } from "../../../../../board/useBoard";
import { useProject } from "../../../../../forge/useForge";
import { describeError } from "../../../../../i18n";
import { Button, ErrorBanner, Loading } from "../../../../../ui/components";
import { tick } from "../../../../../ui/haptics";
import { Icon } from "../../../../../ui/Icon";
import { EmptyState, Fab } from "../../../../../ui/kit";
import { columnColor, RADIUS, SPACE, TYPE, useTheme } from "../../../../../ui/theme";

export default function Board() {
	const projectId = useProjectId();
	const { name } = useLocalSearchParams<{ name?: string }>();
	const { t } = useTranslation();
	const theme = useTheme();
	const router = useRouter();
	const { can } = useSession();
	const userId = useUserId();
	const { cards, error, live, refreshing, reload } = useBoard(projectId);
	const project = useProject(projectId).data;
	const wide = useWindowDimensions().width >= WIDE_BOARD;
	const quick = useQuickActions(projectId, reload);
	// One split group shown alone, from a tap on a part's mark.
	const [splitGroup, setSplitGroup] = useState<string | null>(null);
	const [filter, setFilter] = useState(NO_FILTER);
	const groups = useMemo(
		() => groupByColumn(filterCards(inGroup(cards ?? [], splitGroup), filter, userId)),
		[cards, splitGroup, filter, userId],
	);
	const filtering = isFiltering(filter);
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

	const openCard = (card: BoardCard) =>
		router.push({ pathname: "/projects/[projectId]/cards/[cardId]", params: { projectId, cardId: card.id } });
	const renderCard = (card: BoardCard) => (
		<CardRow
			card={card}
			onGroup={toggleGroup}
			onPress={() => openCard(card)}
			onQuickActions={() => quick.open(card)}
		/>
	);
	const empty = filtering ? (
		<View style={{ gap: SPACE.md }}>
			<EmptyState icon="search" title={t("board.noMatch")} hint={t("board.noMatchHint")} />
			<Button label={t("board.clearFilters")} variant="ghost" icon="x" onPress={() => setFilter(NO_FILTER)} />
		</View>
	) : (
		<EmptyState icon="inbox" title={t("board.emptyColumn")} hint={t("board.emptyHint")} />
	);
	const groupFilter = splitGroup ? (
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
	) : null;
	const errorBanner = error ? <ErrorBanner message={describeError(error)} /> : null;

	return (
		<View style={{ flex: 1 }}>
			<Tabs.Screen options={{ headerTitle: project?.name ?? name ?? "", headerRight: status }} />
			<FilterBar filter={filter} onChange={setFilter} />
			{wide ? (
				<WideBoard
					groups={groups}
					refreshing={refreshing}
					onRefresh={reload}
					renderCard={renderCard}
					header={
						groupFilter || errorBanner ? (
							<View style={styles.wideHeader}>
								{groupFilter}
								{errorBanner}
							</View>
						) : null
					}
				/>
			) : (
				<>
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
									aria-selected={selected}
									onPress={() => {
										if (!selected) tick();
										setChosen(group.column);
									}}
									style={[styles.tab, { backgroundColor: selected ? theme.accentSoft : "transparent" }]}
								>
									<View style={[styles.dot, { backgroundColor: columnColor(theme, group.column) }]} />
									<Text style={[TYPE.label, { color: selected ? theme.text : theme.textMuted }]}>
										{t(`columns.${group.column}`)}
									</Text>
									<View style={[styles.count, { backgroundColor: selected ? theme.accent : theme.elevated }]}>
										<Text
											style={[TYPE.caption, { color: selected ? theme.onAccent : theme.textMuted, fontWeight: "700" }]}
										>
											{group.cards.length}
										</Text>
									</View>
								</Pressable>
							);
						})}
					</ScrollView>
					{groupFilter}
					<FlatList<BoardCard>
						data={shown}
						keyExtractor={(c) => c.id}
						contentContainerStyle={styles.list}
						refreshControl={<RefreshControl refreshing={refreshing} onRefresh={reload} tintColor={theme.accent} />}
						ListHeaderComponent={errorBanner ?? undefined}
						ListEmptyComponent={empty}
						renderItem={({ item }) => renderCard(item)}
					/>
				</>
			)}
			{can("task.write") ? (
				<Fab
					icon="plus"
					label={t("board.newCard")}
					onPress={() => router.push({ pathname: "/projects/[projectId]/new", params: { projectId } })}
				/>
			) : null}
			{quick.sheet}
		</View>
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
	wideHeader: { paddingHorizontal: SPACE.lg, paddingTop: SPACE.md, gap: SPACE.sm },
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
});
