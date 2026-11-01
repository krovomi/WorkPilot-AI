import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import type { BoardCard, Column } from "../../../../api/types";
import { useSession } from "../../../../auth/session";
import { groupByColumn } from "../../../../board/columns";
import { initialColumn } from "../../../../board/pickColumn";
import { useBoard } from "../../../../board/useBoard";
import { forgeKind, useProject } from "../../../../forge/useForge";
import { describeError } from "../../../../i18n";
import { ErrorBanner, Loading } from "../../../../ui/components";
import { columnColor, RADIUS, SPACE, useTheme } from "../../../../ui/theme";

export default function Board() {
	const { projectId, name } = useLocalSearchParams<{ projectId: string; name?: string }>();
	const { t } = useTranslation();
	const theme = useTheme();
	const router = useRouter();
	const { can } = useSession();
	const { cards, error, live, refreshing, reload } = useBoard(projectId);
	const forge = forgeKind(useProject(projectId).data?.forge);
	const links = [
		...(can("insight.read") ? (["insights", "roadmap", "ideas", "context"] as const) : []),
		...(forge && can("vcs.read") ? (["forge"] as const) : []),
		...(can("analytics.read") ? (["dashboard"] as const) : []),
	];
	const groups = useMemo(() => groupByColumn(cards ?? []), [cards]);
	const [chosen, setChosen] = useState<Column | null>(null);
	const column = chosen ?? initialColumn(groups);
	const shown = groups.find((g) => g.column === column)?.cards ?? [];

	const addCard = () =>
		can("task.write") ? (
			<Pressable
				accessibilityRole="button"
				accessibilityLabel={t("board.newCard")}
				hitSlop={12}
				style={{ paddingHorizontal: SPACE.sm }}
				onPress={() => router.push({ pathname: "/projects/[projectId]/new", params: { projectId } })}
			>
				<Text style={{ color: theme.accent, fontSize: 28, lineHeight: 30 }}>+</Text>
			</Pressable>
		) : null;

	if (!cards && !error) return <Loading />;
	return (
		<View style={{ flex: 1 }}>
			<Stack.Screen options={{ headerTitle: name ?? "", headerRight: addCard }} />
			<View style={[styles.status, { borderColor: theme.border }]}>
				<View style={[styles.dot, { backgroundColor: live ? theme.success : theme.textFaint }]} />
				<Text style={{ color: theme.textMuted, fontSize: 12 }}>{live ? t("board.live") : t("board.offline")}</Text>
			</View>
			{links.length ? (
				<View style={styles.links}>
					{links.map((target) => (
						<Pressable
							key={target}
							accessibilityRole="link"
							onPress={() =>
								router.push({
									pathname: `/projects/[projectId]/${target}`,
									params: { projectId },
								})
							}
							style={[styles.link, { borderColor: theme.border, backgroundColor: theme.surface }]}
						>
							<Text style={{ color: theme.accent, fontWeight: "600" }} numberOfLines={1}>
								{target === "forge" && forge
									? t(`forge.${forge}`)
									: target === "dashboard"
										? t("dashboard.title")
										: t(`features.${target}`)}
							</Text>
						</Pressable>
					))}
				</View>
			) : null}
			<ScrollView
				horizontal
				showsHorizontalScrollIndicator={false}
				style={styles.tabsBar}
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
							style={[
								styles.tab,
								{
									backgroundColor: selected ? theme.accentSoft : theme.surface,
									borderColor: selected ? theme.accent : theme.border,
								},
							]}
						>
							<View style={[styles.dot, { backgroundColor: columnColor(theme, group.column) }]} />
							<Text style={{ color: theme.text, fontWeight: selected ? "700" : "500" }}>
								{t(`columns.${group.column}`)}
							</Text>
							<Text style={{ color: theme.textMuted }}>{group.cards.length}</Text>
						</Pressable>
					);
				})}
			</ScrollView>
			<FlatList<BoardCard>
				data={shown}
				keyExtractor={(c) => c.id}
				contentContainerStyle={styles.list}
				refreshControl={<RefreshControl refreshing={refreshing} onRefresh={reload} tintColor={theme.accent} />}
				ListHeaderComponent={error ? <ErrorBanner message={describeError(error)} /> : undefined}
				ListEmptyComponent={
					<Text style={{ color: theme.textMuted, textAlign: "center", marginTop: SPACE.xl }}>
						{t("board.emptyColumn")}
					</Text>
				}
				renderItem={({ item }) => (
					<CardRow
						card={item}
						onPress={() =>
							router.push({
								pathname: "/projects/[projectId]/cards/[cardId]",
								params: { projectId, cardId: item.id },
							})
						}
					/>
				)}
			/>
		</View>
	);
}

function CardRow({ card, onPress }: { card: BoardCard; onPress: () => void }) {
	const { t } = useTranslation();
	const theme = useTheme();
	const { completed, total } = card.subtasks;
	return (
		<Pressable
			accessibilityRole="button"
			accessibilityLabel={card.title}
			onPress={onPress}
			style={({ pressed }) => [
				styles.card,
				{ backgroundColor: theme.surface, borderColor: theme.border, opacity: pressed ? 0.85 : 1 },
			]}
		>
			<View style={styles.cardTop}>
				<Text style={{ color: theme.textFaint, fontSize: 12 }}>{card.id.split("-")[0]}</Text>
				{card.kind ? (
					<Text style={[styles.kind, { color: theme.textMuted, backgroundColor: theme.elevated }]}>
						{t(`kinds.${card.kind}`)}
					</Text>
				) : null}
			</View>
			<Text style={{ color: theme.text, fontSize: 16, fontWeight: "600" }}>{card.title}</Text>
			{total > 0 ? (
				<View style={{ gap: 4 }}>
					<View style={[styles.track, { backgroundColor: theme.elevated }]}>
						<View
							style={[styles.fill, { backgroundColor: theme.accent, width: `${Math.round((completed / total) * 100)}%` }]}
						/>
					</View>
					<Text style={{ color: theme.textMuted, fontSize: 12 }}>{t("board.subtasks", { completed, total })}</Text>
				</View>
			) : null}
			{card.claimedByName ? (
				<Text style={{ color: theme.textFaint, fontSize: 12 }}>
					{t("board.claimedBy", { name: card.claimedByName })}
				</Text>
			) : null}
		</Pressable>
	);
}

const styles = StyleSheet.create({
	links: { flexDirection: "row", flexWrap: "wrap", gap: SPACE.sm, paddingHorizontal: SPACE.lg, paddingTop: SPACE.sm },
	// Three a row: up to six links, which one row would squeeze on a phone.
	link: { flexGrow: 1, flexBasis: "30%", alignItems: "center", borderWidth: StyleSheet.hairlineWidth, borderRadius: RADIUS.md, paddingVertical: SPACE.sm },
	status: {
		flexDirection: "row",
		alignItems: "center",
		gap: SPACE.sm,
		paddingHorizontal: SPACE.lg,
		paddingVertical: SPACE.sm,
		borderBottomWidth: StyleSheet.hairlineWidth,
	},
	dot: { width: 8, height: 8, borderRadius: 4 },
	tabsBar: { flexGrow: 0 },
	tabs: { paddingHorizontal: SPACE.lg, paddingVertical: SPACE.md, gap: SPACE.sm },
	tab: {
		flexDirection: "row",
		alignItems: "center",
		gap: SPACE.sm,
		borderWidth: 1,
		borderRadius: 999,
		paddingHorizontal: SPACE.md,
		minHeight: 40,
	},
	list: { paddingHorizontal: SPACE.lg, paddingBottom: SPACE.xl, gap: SPACE.md },
	card: { borderWidth: 1, borderRadius: RADIUS.lg, padding: SPACE.lg, gap: SPACE.sm },
	cardTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
	kind: { fontSize: 11, paddingHorizontal: SPACE.sm, paddingVertical: 2, borderRadius: RADIUS.sm, overflow: "hidden" },
	track: { height: 4, borderRadius: 2, overflow: "hidden" },
	fill: { height: 4 },
});
