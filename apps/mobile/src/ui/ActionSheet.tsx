/**
 * A sheet that rises from the bottom with a few choices, the same on iOS,
 * Android and the web: a title, a line under it, one row per choice, a
 * spinner on the one running, the error if it failed. A tap outside closes it.
 */

import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ErrorBanner, rowOpacity } from "./components";
import { Icon, type IconName } from "./Icon";
import { RADIUS, SPACE, TYPE, useTheme } from "./theme";

export interface SheetOption {
	key: string;
	label: string;
	icon: IconName;
}

export function ActionSheet({
	visible,
	title,
	subtitle,
	options,
	loading,
	busy,
	error,
	closeLabel,
	onSelect,
	onClose,
}: {
	visible: boolean;
	title: string;
	subtitle?: string;
	options: readonly SheetOption[];
	/** The choices are still being read. */
	loading: boolean;
	busy: string | null;
	error: string | null;
	closeLabel: string;
	onSelect: (key: string) => void;
	onClose: () => void;
}) {
	const theme = useTheme();
	const { bottom } = useSafeAreaInsets();
	return (
		<Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
			<Pressable
				accessibilityRole="button"
				accessibilityLabel={closeLabel}
				style={[styles.backdrop, { backgroundColor: "rgba(0,0,0,0.35)" }]}
				onPress={onClose}
			/>
			<View style={[styles.sheet, { backgroundColor: theme.surface, paddingBottom: bottom + SPACE.md }]}>
				<View style={[styles.grip, { backgroundColor: theme.border }]} />
				<Text accessibilityRole="header" style={[TYPE.heading, { color: theme.text }]} numberOfLines={2}>
					{title}
				</Text>
				{subtitle ? <Text style={[TYPE.small, { color: theme.textMuted }]}>{subtitle}</Text> : null}
				{loading ? <ActivityIndicator color={theme.accent} style={{ marginVertical: SPACE.lg }} /> : null}
				{options.map((option) => (
					<Pressable
						key={option.key}
						accessibilityRole="button"
						accessibilityLabel={option.label}
						accessibilityState={{ disabled: busy !== null, busy: busy === option.key }}
						disabled={busy !== null}
						onPress={() => onSelect(option.key)}
						style={({ pressed }) => [styles.option, { backgroundColor: theme.elevated, opacity: rowOpacity(pressed) }]}
					>
						<Icon name={option.icon} size={20} color={theme.accent} />
						<Text style={[TYPE.body, { color: theme.text, flex: 1, fontWeight: "600" }]}>{option.label}</Text>
						{busy === option.key ? <ActivityIndicator color={theme.accent} /> : null}
					</Pressable>
				))}
				<ErrorBanner message={error} />
			</View>
		</Modal>
	);
}

const styles = StyleSheet.create({
	backdrop: { flex: 1 },
	sheet: {
		borderTopLeftRadius: RADIUS.xl,
		borderTopRightRadius: RADIUS.xl,
		paddingHorizontal: SPACE.lg,
		paddingTop: SPACE.sm,
		gap: SPACE.sm,
	},
	grip: { alignSelf: "center", width: 40, height: 4, borderRadius: 2, marginBottom: SPACE.sm },
	option: {
		flexDirection: "row",
		alignItems: "center",
		gap: SPACE.md,
		borderRadius: RADIUS.md,
		paddingHorizontal: SPACE.md,
		minHeight: 52,
	},
});
