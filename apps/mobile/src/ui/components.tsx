/** The few building blocks every screen uses, themed. */

import type { ReactNode } from "react";
import {
	ActivityIndicator,
	Pressable,
	type PressableProps,
	StyleSheet,
	Text,
	TextInput,
	type TextInputProps,
	View,
	type ViewStyle,
} from "react-native";
import { RADIUS, SPACE, useTheme } from "./theme";

type Variant = "primary" | "secondary" | "danger";

export function Button({
	label,
	variant = "primary",
	busy = false,
	disabled,
	style,
	...rest
}: Omit<PressableProps, "children" | "style"> & {
	label: string;
	variant?: Variant;
	busy?: boolean;
	style?: ViewStyle;
}) {
	const theme = useTheme();
	const off = disabled || busy;
	const background =
		variant === "primary" ? theme.accent : variant === "danger" ? theme.dangerSoft : theme.elevated;
	const color = variant === "primary" ? theme.onAccent : variant === "danger" ? theme.danger : theme.text;
	return (
		<Pressable
			accessibilityRole="button"
			accessibilityLabel={label}
			accessibilityState={{ disabled: !!off, busy }}
			disabled={off}
			style={({ pressed }) => [
				styles.button,
				{ backgroundColor: background, opacity: off ? 0.5 : pressed ? 0.8 : 1 },
				style,
			]}
			{...rest}
		>
			{busy ? <ActivityIndicator color={color} /> : <Text style={[styles.buttonText, { color }]}>{label}</Text>}
		</Pressable>
	);
}

export function Field({ label, ...input }: TextInputProps & { label: string }) {
	const theme = useTheme();
	return (
		<View style={styles.field}>
			<Text style={[styles.label, { color: theme.textMuted }]}>{label}</Text>
			<TextInput
				accessibilityLabel={label}
				placeholderTextColor={theme.textFaint}
				style={[
					styles.input,
					{ color: theme.text, backgroundColor: theme.surface, borderColor: theme.border },
					input.multiline ? styles.multiline : null,
				]}
				{...input}
			/>
		</View>
	);
}

export function ErrorBanner({ message }: { message: string | null }) {
	const theme = useTheme();
	if (!message) return null;
	return (
		<View accessibilityRole="alert" style={[styles.banner, { backgroundColor: theme.dangerSoft }]}>
			<Text style={{ color: theme.danger }}>{message}</Text>
		</View>
	);
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
	const theme = useTheme();
	return (
		<View style={[styles.section, { backgroundColor: theme.surface, borderColor: theme.border }]}>
			<Text accessibilityRole="header" style={[styles.sectionTitle, { color: theme.textMuted }]}>
				{title}
			</Text>
			{children}
		</View>
	);
}

export function Centered({ children }: { children: ReactNode }) {
	const theme = useTheme();
	return <View style={[styles.centered, { backgroundColor: theme.background }]}>{children}</View>;
}

export function Loading() {
	const theme = useTheme();
	return (
		<Centered>
			<ActivityIndicator color={theme.accent} />
		</Centered>
	);
}

const styles = StyleSheet.create({
	button: {
		minHeight: 48,
		borderRadius: RADIUS.md,
		paddingHorizontal: SPACE.lg,
		alignItems: "center",
		justifyContent: "center",
	},
	buttonText: { fontSize: 16, fontWeight: "600" },
	field: { gap: SPACE.xs },
	label: { fontSize: 13, fontWeight: "500" },
	input: {
		minHeight: 48,
		borderWidth: 1,
		borderRadius: RADIUS.md,
		paddingHorizontal: SPACE.md,
		fontSize: 16,
	},
	multiline: { minHeight: 120, paddingTop: SPACE.md, textAlignVertical: "top" },
	banner: { borderRadius: RADIUS.md, padding: SPACE.md },
	section: { borderWidth: 1, borderRadius: RADIUS.lg, padding: SPACE.lg, gap: SPACE.sm },
	sectionTitle: { fontSize: 12, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.6 },
	centered: { flex: 1, alignItems: "center", justifyContent: "center", padding: SPACE.xl, gap: SPACE.md },
});
