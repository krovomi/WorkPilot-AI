/**
 * A card of the board as a row: its column's stripe, its number and kind,
 * how long ago it moved, its split group, its progress and who claimed it.
 */

import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { BoardCard, CardKind } from "../api/types";
import { rowOpacity } from "../ui/components";
import { timeAgo } from "../ui/format";
import type { IconName } from "../ui/Icon";
import { Avatar, Chip } from "../ui/kit";
import { columnColor, elevation, RADIUS, SPACE, TYPE, useTheme } from "../ui/theme";
import { boardColumn } from "./columns";
import { groupColor } from "./splitGroup";

export const KIND_ICONS: Record<CardKind, IconName> = {
	feature: "star",
	bug_fix: "tool",
	refactoring: "refresh-cw",
	investigation: "search",
	docs: "file-text",
	test: "check-square",
};

export function CardRow({
	card,
	onPress,
	onGroup,
	onQuickActions,
}: {
	card: BoardCard;
	onPress: () => void;
	onGroup: (group: string) => void;
	/** A long press, or the screen reader's action: the card's quick actions. */
	onQuickActions: () => void;
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
			accessibilityHint={t("board.quickHint")}
			accessibilityActions={[{ name: "longpress", label: t("board.quickActions") }]}
			onAccessibilityAction={onQuickActions}
			onPress={onPress}
			onLongPress={onQuickActions}
			delayLongPress={350}
			style={({ pressed }) => [
				styles.card,
				{ backgroundColor: theme.surface, opacity: rowOpacity(pressed) },
				elevation(theme),
			]}
		>
			<View style={[styles.stripe, { backgroundColor: columnColor(theme, boardColumn(card)) }]} />
			<View style={styles.cardTop}>
				<Text style={[TYPE.caption, { color: theme.textFaint, fontWeight: "600" }]}>#{card.id.split("-")[0]}</Text>
				{card.kind ? <Chip label={t(`kinds.${card.kind}`)} icon={KIND_ICONS[card.kind]} /> : null}
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
	dot: { width: 8, height: 8, borderRadius: 4 },
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
	track: { flex: 1, height: 6, borderRadius: 3, overflow: "hidden" },
	fill: { height: 6, borderRadius: 3 },
});
