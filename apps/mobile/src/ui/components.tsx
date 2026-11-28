/** The few building blocks every screen uses, themed. */

import { type ReactNode, useState } from "react";
import {
	ActivityIndicator,
	KeyboardAvoidingView,
	Platform,
	Pressable,
	type PressableProps,
	StyleSheet,
	Text,
	TextInput,
	type TextInputProps,
	View,
	type ViewStyle,
} from "react-native";
import { describeError } from "../i18n";
import { Icon, type IconName } from "./Icon";
import { elevation, RADIUS, SPACE, TYPE, useTheme } from "./theme";

type Variant = "primary" | "secondary" | "danger" | "ghost";

/** A button's fill and ink in a variant. */
function buttonColors(variant: Variant, theme: ReturnType<typeof useTheme>) {
	switch (variant) {
		case "primary":
			return { background: theme.accent, color: theme.onAccent };
		case "danger":
			return { background: theme.dangerSoft, color: theme.danger };
		case "ghost":
			return { background: "transparent", color: theme.accent };
		default:
			return { background: theme.elevated, color: theme.text };
	}
}

export function Button({
	label,
	variant = "primary",
	icon,
	busy = false,
	disabled,
	style,
	...rest
}: Omit<PressableProps, "children" | "style"> & {
	label: string;
	variant?: Variant;
	/** An icon before the label. */
	icon?: IconName;
	busy?: boolean;
	style?: ViewStyle;
}) {
	const theme = useTheme();
	const off = disabled || busy;
	const { background, color } = buttonColors(variant, theme);
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
			{busy ? (
				<ActivityIndicator color={color} />
			) : (
				<>
					{icon ? <Icon name={icon} size={18} color={color} /> : null}
					<Text style={[styles.buttonText, { color }]}>{label}</Text>
				</>
			)}
		</Pressable>
	);
}

export function Field({ label, onFocus, onBlur, ...input }: TextInputProps & { label: string }) {
	const theme = useTheme();
	// The field being typed in shows it: its border takes the accent.
	const [focused, setFocused] = useState(false);
	return (
		<View style={styles.field}>
			<Text style={[styles.label, { color: theme.textMuted }]}>{label}</Text>
			<TextInput
				accessibilityLabel={label}
				placeholderTextColor={theme.textFaint}
				style={[
					styles.input,
					{ color: theme.text, backgroundColor: theme.surface, borderColor: focused ? theme.accent : theme.border },
					input.multiline ? styles.multiline : null,
				]}
				onFocus={(event) => {
					setFocused(true);
					onFocus?.(event);
				}}
				onBlur={(event) => {
					setFocused(false);
					onBlur?.(event);
				}}
				{...input}
			/>
		</View>
	);
}

/** Shows `message`, else the failure `error` in the person's words; nothing when there is neither. */
export function ErrorBanner({ message = null, error = null }: { message?: string | null; error?: unknown }) {
	const theme = useTheme();
	const text = message ?? (error ? describeError(error) : null);
	if (!text) return null;
	return (
		<View accessibilityRole="alert" style={[styles.banner, { backgroundColor: theme.dangerSoft }]}>
			<Icon name="alert-circle" size={18} color={theme.danger} />
			<Text style={{ color: theme.danger, flex: 1 }}>{text}</Text>
		</View>
	);
}

/** Lifts a form above the on-screen keyboard: iOS pads it, Android already resizes the window. */
export function KeyboardAvoiding({ children }: { children: ReactNode }) {
	return (
		<KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
			{children}
		</KeyboardAvoidingView>
	);
}

/** The opacity of a list row while a finger is on it. */
export function rowOpacity(pressed: boolean): number {
	return pressed ? 0.85 : 1;
}

export function Section({
	title,
	icon,
	action,
	children,
}: {
	title: string;
	/** An icon before the title. */
	icon?: IconName;
	/** A control at the right of the title (a link, a small button). */
	action?: ReactNode;
	children: ReactNode;
}) {
	const theme = useTheme();
	return (
		<View style={[styles.section, { backgroundColor: theme.surface }, elevation(theme)]}>
			<View style={styles.sectionHead}>
				{icon ? <Icon name={icon} size={15} color={theme.textMuted} /> : null}
				<Text accessibilityRole="header" style={[TYPE.overline, styles.sectionTitle, { color: theme.textMuted }]}>
					{title}
				</Text>
				{action}
			</View>
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
		flexDirection: "row",
		gap: SPACE.sm,
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
	banner: { flexDirection: "row", alignItems: "flex-start", gap: SPACE.sm, borderRadius: RADIUS.md, padding: SPACE.md },
	section: { borderRadius: RADIUS.lg, padding: SPACE.lg, gap: SPACE.md },
	sectionHead: { flexDirection: "row", alignItems: "center", gap: SPACE.sm, minHeight: 20 },
	sectionTitle: { flex: 1 },
	centered: { flex: 1, alignItems: "center", justifyContent: "center", padding: SPACE.xl, gap: SPACE.md },
});
