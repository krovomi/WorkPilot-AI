/**
 * The smaller pieces the screens share, on top of `components.tsx`: an icon
 * button for a header, a chip, a person's initials, a list row, an empty
 * state and the floating button that creates.
 */

import type { ReactNode } from "react";
import { Pressable, type PressableProps, StyleSheet, Text, View, type ViewStyle } from "react-native";
import { groupColor } from "../board/splitGroup";
import { rowOpacity } from "./components";
import { Icon, type IconName } from "./Icon";
import { elevation, RADIUS, SPACE, TYPE, useTheme } from "./theme";

/** What a pressable piece takes from `Pressable` besides its own props. */
type Press = Omit<PressableProps, "children" | "style" | "onPress">;

/** A header's round button: an icon, its label read aloud. */
export function IconButton({
	icon,
	label,
	onPress,
	color,
	badge,
	...rest
}: Press & {
	icon: IconName;
	label: string;
	onPress: () => void;
	color?: string;
	/** A dot on the icon: something waits behind it. */
	badge?: boolean;
}) {
	const theme = useTheme();
	return (
		<Pressable
			accessibilityRole="button"
			accessibilityLabel={label}
			hitSlop={8}
			onPress={onPress}
			style={({ pressed }) => [styles.iconButton, { backgroundColor: pressed ? theme.elevated : "transparent" }]}
			{...rest}
		>
			<Icon name={icon} size={22} color={color ?? theme.text} />
			{badge ? <View style={[styles.badge, { backgroundColor: theme.danger, borderColor: theme.surface }]} /> : null}
		</Pressable>
	);
}

/** A small rounded label: a kind, a role, a status. `color` tints it. */
export function Chip({ label, icon, color }: { label: string; icon?: IconName; color?: string }) {
	const theme = useTheme();
	const ink = color ?? theme.textMuted;
	return (
		<View style={[styles.chip, { backgroundColor: theme.elevated }]}>
			{icon ? <Icon name={icon} size={12} color={ink} /> : null}
			<Text style={[TYPE.caption, { color: ink, fontWeight: "600" }]} numberOfLines={1}>
				{label}
			</Text>
		</View>
	);
}

/** The initials of a name: "Alice Martin" → "AM", "bob" → "B". */
export function initials(name: string): string {
	const words = name.trim().split(/\s+/).filter(Boolean);
	return words
		.slice(0, 2)
		.map((word) => word[0].toUpperCase())
		.join("");
}

/**
 * A person's initials in a disc of a colour of their own (the same name, the
 * same colour); `square`, a project's in a rounded tile.
 */
export function Avatar({ name, size = 24, square = false }: { name: string; size?: number; square?: boolean }) {
	const theme = useTheme();
	const color = groupColor(name, theme.dark);
	return (
		<View
			accessibilityElementsHidden
			importantForAccessibility="no-hide-descendants"
			style={[
				styles.avatar,
				{ width: size, height: size, borderRadius: square ? RADIUS.md : size / 2, backgroundColor: color },
			]}
		>
			<Text style={{ color: theme.dark ? "#0B0B0F" : "#FFFFFF", fontSize: size * 0.42, fontWeight: "700" }}>
				{initials(name)}
			</Text>
		</View>
	);
}

/** A tappable row: an icon in a tinted tile, a title, a line under it, a chevron. */
export function ListRow({
	icon,
	title,
	subtitle,
	right,
	onPress,
	tint,
	accessibilityLabel,
	...rest
}: Press & {
	icon?: IconName;
	title: string;
	subtitle?: string;
	right?: ReactNode;
	onPress: () => void;
	tint?: string;
	accessibilityLabel?: string;
}) {
	const theme = useTheme();
	const color = tint ?? theme.accent;
	return (
		<Pressable
			accessibilityRole="button"
			accessibilityLabel={accessibilityLabel ?? title}
			onPress={onPress}
			style={({ pressed }) => [
				styles.row,
				{ backgroundColor: pressed ? theme.elevated : theme.surface },
				elevation(theme),
			]}
			{...rest}
		>
			{icon ? (
				<View style={[styles.tile, { backgroundColor: theme.accentSoft }]}>
					<Icon name={icon} size={20} color={color} />
				</View>
			) : null}
			<View style={{ flex: 1, gap: 2 }}>
				<Text style={[TYPE.label, { color: theme.text, fontSize: 16 }]} numberOfLines={1}>
					{title}
				</Text>
				{subtitle ? (
					<Text style={[TYPE.small, { color: theme.textMuted }]} numberOfLines={2}>
						{subtitle}
					</Text>
				) : null}
			</View>
			{right}
			<Icon name="chevron-right" size={20} color={theme.textFaint} />
		</Pressable>
	);
}

/** What a list says when it has nothing: an icon, a sentence, and what to do about it. */
export function EmptyState({
	icon,
	title,
	hint,
	style,
}: {
	icon: IconName;
	title: string;
	hint?: string;
	style?: ViewStyle;
}) {
	const theme = useTheme();
	return (
		<View style={[styles.empty, style]}>
			<View style={[styles.emptyIcon, { backgroundColor: theme.accentSoft }]}>
				<Icon name={icon} size={26} color={theme.accent} />
			</View>
			<Text style={[TYPE.label, { color: theme.text, textAlign: "center" }]}>{title}</Text>
			{hint ? <Text style={[TYPE.small, { color: theme.textMuted, textAlign: "center" }]}>{hint}</Text> : null}
		</View>
	);
}

/** The round button at the bottom right that creates (a card, a session). */
export function Fab({ icon, label, onPress, ...rest }: Press & { icon: IconName; label: string; onPress: () => void }) {
	const theme = useTheme();
	return (
		<Pressable
			accessibilityRole="button"
			accessibilityLabel={label}
			onPress={onPress}
			style={({ pressed }) => [styles.fab, { backgroundColor: theme.accent, opacity: rowOpacity(pressed) }]}
			{...rest}
		>
			<Icon name={icon} size={20} color={theme.onAccent} />
			<Text style={[TYPE.label, { color: theme.onAccent }]}>{label}</Text>
		</Pressable>
	);
}

const styles = StyleSheet.create({
	iconButton: {
		width: 40,
		height: 40,
		borderRadius: 20,
		alignItems: "center",
		justifyContent: "center",
	},
	badge: { position: "absolute", top: 8, right: 8, width: 10, height: 10, borderRadius: 5, borderWidth: 2 },
	chip: {
		flexDirection: "row",
		alignItems: "center",
		gap: 4,
		alignSelf: "flex-start",
		borderRadius: RADIUS.pill,
		paddingHorizontal: SPACE.sm,
		paddingVertical: 3,
		maxWidth: "100%",
	},
	avatar: { alignItems: "center", justifyContent: "center" },
	row: {
		flexDirection: "row",
		alignItems: "center",
		gap: SPACE.md,
		borderRadius: RADIUS.lg,
		padding: SPACE.md,
		minHeight: 64,
	},
	tile: { width: 40, height: 40, borderRadius: RADIUS.md, alignItems: "center", justifyContent: "center" },
	empty: { alignItems: "center", gap: SPACE.sm, paddingVertical: SPACE.xl * 1.5, paddingHorizontal: SPACE.xl },
	emptyIcon: { width: 56, height: 56, borderRadius: 28, alignItems: "center", justifyContent: "center", marginBottom: SPACE.xs },
	fab: {
		position: "absolute",
		right: SPACE.lg,
		bottom: SPACE.lg,
		flexDirection: "row",
		alignItems: "center",
		gap: SPACE.sm,
		height: 52,
		paddingHorizontal: SPACE.lg + 2,
		borderRadius: 26,
		shadowColor: "#000",
		shadowOpacity: 0.18,
		shadowRadius: 12,
		shadowOffset: { width: 0, height: 4 },
		elevation: 4,
	},
});
