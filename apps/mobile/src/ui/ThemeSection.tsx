/**
 * Settings: the mode (the device's, light, dark) and the colour theme, the
 * desktop's seven, each with a swatch of its background and accent in the
 * mode shown. A choice applies at once (`ThemeProvider.tsx`).
 */

import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Section } from "./components";
import { PALETTES } from "./palettes";
import { RADIUS, SPACE, useTheme, useThemeChoice } from "./theme";
import { COLOR_THEME_IDS, THEME_MODES } from "./theme-ids";

export function ThemeSection() {
	const { t } = useTranslation();
	const theme = useTheme();
	const { prefs, choose } = useThemeChoice();
	const shade = theme.dark ? "dark" : "light";

	return (
		<Section title={t("theme.title")}>
			<Text style={{ color: theme.textMuted }}>{t("theme.hint")}</Text>
			<Text style={[styles.label, { color: theme.text }]}>{t("theme.mode")}</Text>
			<View accessibilityRole="radiogroup" style={styles.modes}>
				{THEME_MODES.map((mode) => {
					const selected = prefs.theme === mode;
					return (
						<Pressable
							key={mode}
							accessibilityRole="radio"
							accessibilityLabel={t(`theme.${mode}`)}
							accessibilityState={{ selected }}
							onPress={() => choose({ ...prefs, theme: mode })}
							style={[
								styles.mode,
								{
									borderColor: selected ? theme.accent : theme.border,
									backgroundColor: selected ? theme.accentSoft : "transparent",
								},
							]}
						>
							<Text style={{ color: theme.text, fontWeight: selected ? "700" : "400" }}>
								{t(`theme.${mode}`)}
							</Text>
						</Pressable>
					);
				})}
			</View>
			<Text style={[styles.label, { color: theme.text }]}>{t("theme.colorTheme")}</Text>
			<View accessibilityRole="radiogroup" style={styles.colors}>
				{COLOR_THEME_IDS.map((id) => {
					const selected = prefs.colorTheme === id;
					const swatch = PALETTES[id][shade];
					const name = t(`theme.colors.${id}`);
					return (
						<Pressable
							key={id}
							accessibilityRole="radio"
							accessibilityLabel={name}
							accessibilityState={{ selected }}
							onPress={() => choose({ ...prefs, colorTheme: id })}
							style={[
								styles.color,
								{
									borderColor: selected ? theme.accent : theme.border,
									backgroundColor: selected ? theme.accentSoft : "transparent",
								},
							]}
						>
							<View
								testID={`swatch-${id}`}
								style={[styles.swatch, { backgroundColor: swatch.background, borderColor: swatch.border }]}
							>
								<View style={[styles.dot, { backgroundColor: swatch.accent }]} />
							</View>
							<Text style={{ color: theme.text, flex: 1 }}>{name}</Text>
							{selected ? <Text style={{ color: theme.accent }}>✓</Text> : null}
						</Pressable>
					);
				})}
			</View>
		</Section>
	);
}

const styles = StyleSheet.create({
	label: { fontWeight: "600", marginTop: SPACE.xs },
	modes: { flexDirection: "row", gap: SPACE.sm },
	mode: {
		flex: 1,
		alignItems: "center",
		borderWidth: 1,
		borderRadius: RADIUS.md,
		paddingVertical: SPACE.sm,
	},
	colors: { gap: SPACE.sm },
	color: {
		flexDirection: "row",
		alignItems: "center",
		gap: SPACE.md,
		borderWidth: 1,
		borderRadius: RADIUS.md,
		padding: SPACE.sm,
	},
	swatch: {
		width: 32,
		height: 24,
		borderRadius: RADIUS.sm,
		borderWidth: 1,
		alignItems: "flex-end",
		justifyContent: "flex-end",
		padding: 3,
	},
	dot: { width: 10, height: 10, borderRadius: 5 },
});
