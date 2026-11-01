/** A labelled row of chips of which one is chosen: the card's type, engine, effort, priority. */

import { Pressable, StyleSheet, Text, View } from "react-native";
import { SPACE, useTheme } from "../ui/theme";

export interface Choice<T> {
	value: T;
	label: string;
}

export function ChoiceChips<T extends string | null>({
	label,
	choices,
	selected,
	onSelect,
}: {
	label: string;
	choices: readonly Choice<T>[];
	selected: T;
	onSelect: (value: T) => void;
}) {
	const theme = useTheme();
	return (
		<View style={{ gap: SPACE.sm }} accessibilityRole="radiogroup" accessibilityLabel={label}>
			<Text style={{ color: theme.textMuted, fontSize: 13, fontWeight: "500" }}>{label}</Text>
			<View style={styles.chips}>
				{choices.map((choice) => {
					const isSelected = choice.value === selected;
					return (
						<Pressable
							key={choice.value ?? "(default)"}
							accessibilityRole="radio"
							accessibilityState={{ selected: isSelected }}
							accessibilityLabel={choice.label}
							onPress={() => onSelect(choice.value)}
							style={[
								styles.chip,
								{
									borderColor: isSelected ? theme.accent : theme.border,
									backgroundColor: isSelected ? theme.accentSoft : theme.surface,
								},
							]}
						>
							<Text style={{ color: theme.text }}>{choice.label}</Text>
						</Pressable>
					);
				})}
			</View>
		</View>
	);
}

const styles = StyleSheet.create({
	chips: { flexDirection: "row", flexWrap: "wrap", gap: SPACE.sm },
	chip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: SPACE.md, paddingVertical: SPACE.sm },
});
