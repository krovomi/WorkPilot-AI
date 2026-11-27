/**
 * The board on a wide screen (a tablet, a phone on its side): every column
 * side by side, as on the desktop, each with its count and its cards.
 */

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import type { BoardCard } from "../api/types";
import { columnColor, RADIUS, SPACE, TYPE, useTheme } from "../ui/theme";
import type { ColumnGroup } from "./columns";

/** From this width (in points) the board shows its columns side by side. */
export const WIDE_BOARD = 900;
const COLUMN_WIDTH = 320;

export function WideBoard({
	groups,
	refreshing,
	onRefresh,
	renderCard,
	header,
}: {
	groups: readonly ColumnGroup[];
	refreshing: boolean;
	onRefresh: () => void;
	renderCard: (card: BoardCard) => ReactNode;
	header?: ReactNode;
}) {
	const { t } = useTranslation();
	const theme = useTheme();
	return (
		<View style={{ flex: 1 }}>
			{header}
			<ScrollView horizontal contentContainerStyle={styles.columns}>
				{groups.map((group) => (
					<View
						key={group.column}
						accessibilityLabel={`${t(`columns.${group.column}`)}, ${group.cards.length}`}
						style={[styles.column, { backgroundColor: theme.elevated }]}
					>
						<View style={styles.head}>
							<View style={[styles.dot, { backgroundColor: columnColor(theme, group.column) }]} />
							<Text accessibilityRole="header" style={[TYPE.label, { color: theme.text, flex: 1 }]}>
								{t(`columns.${group.column}`)}
							</Text>
							<Text style={[TYPE.caption, { color: theme.textMuted, fontWeight: "700" }]}>{group.cards.length}</Text>
						</View>
						<ScrollView
							contentContainerStyle={styles.cards}
							refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.accent} />}
						>
							{group.cards.length ? (
								group.cards.map((card) => <View key={card.id}>{renderCard(card)}</View>)
							) : (
								<Text style={[TYPE.small, { color: theme.textFaint, textAlign: "center" }]}>{t("board.emptyColumn")}</Text>
							)}
						</ScrollView>
					</View>
				))}
			</ScrollView>
		</View>
	);
}

const styles = StyleSheet.create({
	columns: { padding: SPACE.lg, paddingBottom: 96, gap: SPACE.md },
	column: { width: COLUMN_WIDTH, borderRadius: RADIUS.lg, padding: SPACE.sm, gap: SPACE.sm },
	head: { flexDirection: "row", alignItems: "center", gap: SPACE.sm, paddingHorizontal: SPACE.sm, paddingTop: SPACE.xs },
	dot: { width: 8, height: 8, borderRadius: 4 },
	cards: { gap: SPACE.sm, paddingBottom: SPACE.md },
});
