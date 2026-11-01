/** A short list to pick one value from, as radio rows. */

import { Pressable, StyleSheet, Text, View } from "react-native";
import { RADIUS, SPACE, useTheme } from "../ui/theme";

export interface Option {
	value: string;
	label: string;
	detail?: string;
}

export function Choice({
	options,
	selected,
	onSelect,
	disabled,
}: {
	options: Option[];
	selected: string | null;
	onSelect: (value: string) => void;
	disabled?: boolean;
}) {
	const theme = useTheme();
	return (
		<View accessibilityRole="radiogroup" style={styles.list}>
			{options.map((o) => {
				const isSelected = o.value === selected;
				return (
					<Pressable
						key={o.value}
						accessibilityRole="radio"
						accessibilityState={{ selected: isSelected, disabled }}
						accessibilityLabel={o.label}
						disabled={disabled}
						onPress={() => onSelect(o.value)}
						style={[
							styles.option,
							{
								borderColor: isSelected ? theme.accent : theme.border,
								backgroundColor: isSelected ? theme.accentSoft : "transparent",
							},
						]}
					>
						<View style={{ flex: 1 }}>
							<Text style={{ color: theme.text, fontWeight: "600" }}>{o.label}</Text>
							{o.detail ? <Text style={{ color: theme.textMuted, fontSize: 12 }}>{o.detail}</Text> : null}
						</View>
						{isSelected ? <Text style={{ color: theme.accent }}>✓</Text> : null}
					</Pressable>
				);
			})}
		</View>
	);
}

const styles = StyleSheet.create({
	list: { gap: SPACE.sm },
	option: {
		flexDirection: "row",
		alignItems: "center",
		borderWidth: 1,
		borderRadius: RADIUS.md,
		padding: SPACE.md,
	},
});
