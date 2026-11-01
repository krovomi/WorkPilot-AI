/**
 * The desktop's default theme (Oscura, `apps/frontend/design.json`) for the
 * phone: the same backgrounds, text, accent and semantic colours, light and
 * dark following the device.
 */

import { useColorScheme } from "react-native";
import type { Column } from "../api/types";

export interface Theme {
	dark: boolean;
	background: string;
	surface: string;
	elevated: string;
	text: string;
	textMuted: string;
	textFaint: string;
	accent: string;
	accentSoft: string;
	onAccent: string;
	border: string;
	success: string;
	warning: string;
	danger: string;
	dangerSoft: string;
}

export const LIGHT: Theme = {
	dark: false,
	background: "#F2F2ED",
	surface: "#FFFFFF",
	elevated: "#E8E8E3",
	text: "#0B0B0F",
	textMuted: "#5C6974",
	textFaint: "#868F97",
	accent: "#8E8F5A",
	accentSoft: "#EFEFE0",
	onAccent: "#FFFFFF",
	border: "#DEDED9",
	success: "#2E8F6D",
	warning: "#8A8C0E",
	danger: "#D84F68",
	dangerSoft: "#FCE8EC",
};

export const DARK: Theme = {
	dark: true,
	background: "#0B0B0F",
	surface: "#121216",
	elevated: "#1A1A1F",
	text: "#E6E6E6",
	textMuted: "#868F97",
	textFaint: "#5C6974",
	accent: "#D6D876",
	accentSoft: "#2A2A1F",
	onAccent: "#0B0B0F",
	border: "#232323",
	success: "#4EBE96",
	warning: "#D2D714",
	danger: "#FF5C5C",
	dangerSoft: "#2A1A1A",
};

export function useTheme(): Theme {
	return useColorScheme() === "dark" ? DARK : LIGHT;
}

/** The dot that marks a column. */
export function columnColor(theme: Theme, column: Column): string {
	switch (column) {
		case "in_progress":
		case "queue":
			return theme.accent;
		case "ai_review":
		case "human_review":
			return theme.warning;
		case "done":
		case "pr_created":
			return theme.success;
		case "build_failed":
		case "error":
			return theme.danger;
		default:
			return theme.textFaint;
	}
}

export const SPACE = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;
export const RADIUS = { sm: 6, md: 10, lg: 14 } as const;
