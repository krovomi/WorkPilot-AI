/**
 * The board's search field and filters: words, the person's own cards, the
 * kinds of card. Each filter is a toggle that says whether it is on.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import type { CardKind } from "../api/types";
import { tick } from "../ui/haptics";
import { Icon, type IconName } from "../ui/Icon";
import { IconButton } from "../ui/kit";
import { RADIUS, SPACE, TYPE, useTheme } from "../ui/theme";
import { KIND_ICONS } from "./CardRow";
import { type BoardFilter, isFiltering, NO_FILTER } from "./filter";

const KINDS = Object.keys(KIND_ICONS) as CardKind[];

export function FilterBar({ filter, onChange }: { filter: BoardFilter; onChange: (filter: BoardFilter) => void }) {
	const { t } = useTranslation();
	const theme = useTheme();
	const [open, setOpen] = useState(filter.kinds.length > 0 || filter.mine);
	const chosen = (filter.mine ? 1 : 0) + filter.kinds.length;

	const toggleKind = (kind: CardKind) => {
		tick();
		onChange({
			...filter,
			kinds: filter.kinds.includes(kind) ? filter.kinds.filter((k) => k !== kind) : [...filter.kinds, kind],
		});
	};

	return (
		<View style={[styles.bar, { borderColor: theme.border, backgroundColor: theme.surface }]}>
			<View style={styles.line}>
				<View style={[styles.search, { backgroundColor: theme.elevated }]}>
					<Icon name="search" size={16} color={theme.textMuted} />
					<TextInput
						accessibilityLabel={t("board.search")}
						placeholder={t("board.search")}
						placeholderTextColor={theme.textFaint}
						value={filter.query}
						onChangeText={(query) => onChange({ ...filter, query })}
						autoCorrect={false}
						returnKeyType="search"
						style={[TYPE.body, styles.input, { color: theme.text }]}
					/>
					{filter.query ? (
						<IconButton
							icon="x"
							label={t("board.clearSearch")}
							color={theme.textMuted}
							onPress={() => onChange({ ...filter, query: "" })}
						/>
					) : null}
				</View>
				<IconButton
					icon="sliders"
					label={chosen ? t("board.filtersOn", { count: chosen }) : t("board.filters")}
					color={chosen ? theme.accent : theme.text}
					badge={chosen > 0}
					accessibilityState={{ expanded: open }}
					onPress={() => setOpen((current) => !current)}
				/>
			</View>
			{open ? (
				<ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
					<Toggle
						label={t("board.mine")}
						icon="user"
						on={filter.mine}
						onPress={() => {
							tick();
							onChange({ ...filter, mine: !filter.mine });
						}}
					/>
					{KINDS.map((kind) => (
						<Toggle
							key={kind}
							label={t(`kinds.${kind}`)}
							icon={KIND_ICONS[kind]}
							on={filter.kinds.includes(kind)}
							onPress={() => toggleKind(kind)}
						/>
					))}
					{isFiltering(filter) ? (
						<Toggle label={t("board.clearFilters")} icon="x" on={false} onPress={() => onChange(NO_FILTER)} />
					) : null}
				</ScrollView>
			) : null}
		</View>
	);
}

function Toggle({ label, icon, on, onPress }: { label: string; icon: IconName; on: boolean; onPress: () => void }) {
	const theme = useTheme();
	const ink = on ? theme.onAccent : theme.textMuted;
	return (
		<Pressable
			accessibilityRole="checkbox"
			accessibilityLabel={label}
			accessibilityState={{ checked: on }}
			onPress={onPress}
			style={[styles.toggle, { backgroundColor: on ? theme.accent : theme.elevated }]}
		>
			<Icon name={icon} size={14} color={ink} />
			<Text style={[TYPE.label, { color: ink }]}>{label}</Text>
		</Pressable>
	);
}

const styles = StyleSheet.create({
	bar: { borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: SPACE.md, paddingVertical: SPACE.sm, gap: SPACE.sm },
	line: { flexDirection: "row", alignItems: "center", gap: SPACE.xs },
	search: {
		flex: 1,
		flexDirection: "row",
		alignItems: "center",
		gap: SPACE.sm,
		borderRadius: RADIUS.md,
		paddingLeft: SPACE.md,
		minHeight: 40,
	},
	input: { flex: 1, paddingVertical: SPACE.sm },
	chips: { gap: SPACE.xs },
	toggle: {
		flexDirection: "row",
		alignItems: "center",
		gap: 6,
		borderRadius: RADIUS.pill,
		paddingHorizontal: SPACE.md,
		minHeight: 34,
	},
});
