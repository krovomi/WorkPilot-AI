/**
 * Settings: the mode (the device's, light, dark) and the colour theme, the
 * desktop's seven, each with a swatch of its background and accent in the
 * mode shown. A choice applies at once (`ThemeProvider.tsx`).
 */

import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Section } from "./components";
import { Icon, type IconName } from "./Icon";
import { PALETTES } from "./palettes";
import { RADIUS, SPACE, TYPE, useTheme, useThemeChoice } from "./theme";
import { COLOR_THEME_IDS, THEME_MODES, type ThemeMode } from "./theme-ids";

const MODE_ICONS: Record<ThemeMode, IconName> = { system: "smartphone", light: "sun", dark: "moon" };

export function ThemeSection() {
	const { t } = useTranslation();
	const theme = useTheme();
	const { prefs, choose } = useThemeChoice();
	const shade = theme.dark ? "dark" : "light";

	return (
		<Section title={t("theme.title")} icon="droplet">
			<Text style={[TYPE.small, { color: theme.textMuted }]}>{t("theme.hint")}</Text>
			<Text style={[TYPE.label, { color: theme.text }]}>{t("theme.mode")}</Text>
			<View accessibilityRole="radiogroup" style={[styles.modes, { backgroundColor: theme.elevated }]}>
				{THEME_MODES.map((mode) => {
					const selected = prefs.theme === mode;
					return (
						<Pressable
							key={mode}
							accessibilityRole="radio"
							accessibilityLabel={t(`theme.${mode}`)}
							accessibilityState={{ selected }}
							onPress={() => choose({ ...prefs, theme: mode })}
							style={[styles.mode, selected ? { backgroundColor: theme.surface } : null]}
						>
							<Icon name={MODE_ICONS[mode]} size={16} color={selected ? theme.accent : theme.textMuted} />
							<Text style={[TYPE.label, { color: selected ? theme.text : theme.textMuted }]}>{t(`theme.${mode}`)}</Text>
						</Pressable>
					);
				})}
			</View>
			<Text style={[TYPE.label, { color: theme.text }]}>{t("theme.colorTheme")}</Text>
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
							style={[styles.color, { borderColor: selected ? theme.accent : theme.border }]}
						>
							{/* A small board in the theme: its page, a card, the accent. */}
							<View testID={`swatch-${id}`} style={[styles.swatch, { backgroundColor: swatch.background }]}>
								<View style={[styles.mini, { backgroundColor: swatch.surface, borderColor: swatch.border }]}>
									<View style={[styles.line, { backgroundColor: swatch.text, width: "70%" }]} />
									<View style={[styles.line, { backgroundColor: swatch.textMuted, width: "45%" }]} />
									<View style={[styles.bar, { backgroundColor: swatch.accent }]} />
								</View>
							</View>
							<View style={styles.colorName}>
								<Text style={[TYPE.small, { color: theme.text, fontWeight: selected ? "700" : "500", flex: 1 }]} numberOfLines={1}>
									{name}
								</Text>
								{selected ? <Icon name="check-circle" size={16} color={theme.accent} /> : null}
							</View>
						</Pressable>
					);
				})}
			</View>
		</Section>
	);
}

const styles = StyleSheet.create({
	modes: { flexDirection: "row", borderRadius: RADIUS.md, padding: 3, gap: 3 },
	mode: {
		flex: 1,
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "center",
		gap: 6,
		borderRadius: RADIUS.md - 2,
		minHeight: 40,
	},
	colors: { flexDirection: "row", flexWrap: "wrap", gap: SPACE.sm },
	// Three a row on a phone; the last row keeps the same width.
	color: { flexBasis: "30%", flexGrow: 0, width: "31.5%", borderWidth: 2, borderRadius: RADIUS.md, overflow: "hidden" },
	swatch: { height: 58, padding: SPACE.sm, justifyContent: "center" },
	mini: { borderWidth: 1, borderRadius: RADIUS.sm, padding: 6, gap: 4 },
	line: { height: 4, borderRadius: 2 },
	bar: { height: 5, borderRadius: 3, width: "55%", marginTop: 2 },
	colorName: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: SPACE.sm, paddingVertical: 6 },
});
