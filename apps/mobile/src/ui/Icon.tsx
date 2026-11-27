/**
 * The app's icons: Feather's line icons (`@expo/vector-icons`), the set the
 * desktop's Lucide icons come from, so a screen reads the same on both.
 * An icon is decoration: the control that carries it has the label.
 */

import Feather from "@expo/vector-icons/Feather";
import type { ComponentProps } from "react";
import type { ColorValue } from "react-native";
import { useTheme } from "./theme";

export type IconName = ComponentProps<typeof Feather>["name"];

export function Icon({ name, size = 20, color }: { name: IconName; size?: number; color?: ColorValue }) {
	const theme = useTheme();
	return (
		<Feather
			name={name}
			size={size}
			color={(color ?? theme.text) as string}
			aria-hidden
			accessibilityElementsHidden
			importantForAccessibility="no-hide-descendants"
		/>
	);
}
