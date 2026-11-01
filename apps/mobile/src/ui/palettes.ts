/**
 * The desktop's colour themes for the phone, light and dark: the values of
 * each theme's CSS block in `apps/frontend/src/renderer/styles/globals.css`
 * (`:root` / `.dark` for Default, `[data-theme="<id>"]` and its `.dark`).
 *
 * The mapping: background = --background, surface = --card, elevated =
 * --secondary, text = --foreground, textMuted = --muted-foreground, accent =
 * --primary, accentSoft = --accent, onAccent = --primary-foreground, border =
 * --border, success / warning, danger = --destructive, dangerSoft =
 * --error-light. textFaint has no CSS variable: Default keeps design.json's
 * tertiary text, the other themes mix textMuted 35% toward the background.
 *
 * Contrast fixes. On the phone the accent and the semantic colours are text
 * (a status, a link, a check mark) on the background or a card, not only
 * fills, so each of them is kept at 3:1 at least against the background and
 * the surface (and danger against dangerSoft, the error banner). Where the
 * desktop's value falls short it is darkened toward black (light mode) or
 * lightened toward white (dark mode) in small steps until it reaches 3:1; the
 * line says which desktop value it replaces. Default light keeps the phone's
 * earlier choice: a darker olive accent (#8E8F5A, where the desktop's pale
 * #A5A66A is under 3:1 on white) with white text on it.
 * `src/__tests__/theme.test.tsx` checks these ratios for every palette.
 */

import type { Theme } from "./theme";
import type { ColorThemeId } from "./theme-ids";

export const PALETTES: Record<ColorThemeId, { light: Theme; dark: Theme }> = {
	default: {
		light: {
			dark: false,
			background: "#F2F2ED",
			surface: "#FFFFFF",
			elevated: "#E8E8E3",
			text: "#0B0B0F",
			textMuted: "#5C6974",
			textFaint: "#868F97",
			accent: "#8E8F5A", // desktop #A5A66A, for 3:1
			accentSoft: "#EFEFE0",
			onAccent: "#FFFFFF", // desktop #0B0B0F, white on the darker accent
			border: "#DEDED9",
			success: "#2E8F6D", // desktop #4EBE96, for 3:1
			warning: "#8A8C0E", // desktop #D2D714, for 3:1
			danger: "#D84F68",
			dangerSoft: "#FCE8EC",
		},
		dark: {
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
		},
	},
	dusk: {
		light: {
			dark: false,
			background: "#F5F5F0",
			surface: "#FFFFFF",
			elevated: "#EAEAE5",
			text: "#131419",
			textMuted: "#5C6974",
			textFaint: "#929A9F",
			accent: "#90905E", // desktop #B8B978, for 3:1
			accentSoft: "#F0F0E0",
			onAccent: "#131419",
			border: "#E0E0DB",
			success: "#409C7B", // desktop #4EBE96, for 3:1
			warning: "#8F920E", // desktop #D2D714, for 3:1
			danger: "#D84F68",
			dangerSoft: "#FCE8EC",
		},
		dark: {
			dark: true,
			background: "#131419",
			surface: "#1A1B21",
			elevated: "#222329",
			text: "#E6E6E6",
			textMuted: "#868F97",
			textFaint: "#5E646B",
			accent: "#E6E7A3",
			accentSoft: "#2A2B1F",
			onAccent: "#131419",
			border: "#282828",
			success: "#4EBE96",
			warning: "#D2D714",
			danger: "#D84F68",
			dangerSoft: "#2E1A1F",
		},
	},
	lime: {
		light: {
			dark: false,
			background: "#E8F5A3",
			surface: "#FFFFFF",
			elevated: "#F5F9E8",
			text: "#1A1A2E",
			textMuted: "#64748B",
			textFaint: "#92A193",
			accent: "#7C3AED",
			accentSoft: "#EDE9FE",
			onAccent: "#FFFFFF",
			border: "#E2E8F0",
			success: "#059669",
			warning: "#CC7006", // desktop #D97706, for 3:1
			danger: "#DC2626",
			dangerSoft: "#FEE2E2",
		},
		dark: {
			dark: true,
			background: "#0F0F1A",
			surface: "#1E1E2E",
			elevated: "#1A1A2E",
			text: "#F8FAFC",
			textMuted: "#A1A1B5",
			textFaint: "#6E6E7F",
			accent: "#8B5CF6",
			accentSoft: "#2E2350",
			onAccent: "#0F0F1A",
			border: "#2E2E40",
			success: "#34D399",
			warning: "#FBBF24",
			danger: "#F87171",
			dangerSoft: "#450A0A",
		},
	},
	ocean: {
		light: {
			dark: false,
			background: "#E0F2FE",
			surface: "#FFFFFF",
			elevated: "#F0F9FF",
			text: "#0C4A6E",
			textMuted: "#64748B",
			textFaint: "#8FA0B3",
			accent: "#0284C7",
			accentSoft: "#E0F2FE",
			onAccent: "#FFFFFF",
			border: "#BAE6FD",
			success: "#059669",
			warning: "#D07206", // desktop #D97706, for 3:1
			danger: "#DC2626",
			dangerSoft: "#FEE2E2",
		},
		dark: {
			dark: true,
			background: "#082F49",
			surface: "#164E63",
			elevated: "#0C4A6E",
			text: "#F0F9FF",
			textMuted: "#7DD3FC",
			textFaint: "#549ABD",
			accent: "#38BDF8",
			accentSoft: "#0C4A6E",
			onAccent: "#082F49",
			border: "#0E7490",
			success: "#34D399",
			warning: "#FBBF24",
			danger: "#F87171",
			dangerSoft: "#450A0A",
		},
	},
	retro: {
		light: {
			dark: false,
			background: "#FEF3C7",
			surface: "#FFFFFF",
			elevated: "#FFFBEB",
			text: "#78350F",
			textMuted: "#92400E",
			textFaint: "#B87F4F",
			accent: "#D07206", // desktop #D97706, for 3:1
			accentSoft: "#FEF3C7",
			onAccent: "#FFFFFF",
			border: "#FDE68A",
			success: "#15803D",
			warning: "#BA7F04", // desktop #CA8A04, for 3:1
			danger: "#B91C1C",
			dangerSoft: "#FEE2E2",
		},
		dark: {
			dark: true,
			background: "#1C1917",
			surface: "#44403C",
			elevated: "#292524",
			text: "#FEFCE8",
			textMuted: "#FDE68A",
			textFaint: "#AE9E62",
			accent: "#FBBF24",
			accentSoft: "#451A03",
			onAccent: "#1C1917",
			border: "#78716C",
			success: "#4ADE80",
			warning: "#FACC15",
			danger: "#F87171",
			dangerSoft: "#450A0A",
		},
	},
	neo: {
		light: {
			dark: false,
			background: "#FDF4FF",
			surface: "#FFFFFF",
			elevated: "#FAF5FF",
			text: "#581C87",
			textMuted: "#7C3AED",
			textFaint: "#A97BF3",
			accent: "#D946EF",
			accentSoft: "#FAE8FF",
			onAccent: "#FFFFFF",
			border: "#F0ABFC",
			success: "#059DB6", // desktop #06B6D4, for 3:1
			warning: "#C47E09", // desktop #F59E0B, for 3:1
			danger: "#E11D48",
			dangerSoft: "#FFE4E6",
		},
		dark: {
			dark: true,
			background: "#0F0720",
			surface: "#2D1B4E",
			elevated: "#1A0A30",
			text: "#FAF5FF",
			textMuted: "#E879F9",
			textFaint: "#9C51AD",
			accent: "#F0ABFC",
			accentSoft: "#581C87",
			onAccent: "#0F0720",
			border: "#581C87",
			success: "#22D3EE",
			warning: "#FBBF24",
			danger: "#FB7185",
			dangerSoft: "#4C0519",
		},
	},
	forest: {
		light: {
			dark: false,
			background: "#DCFCE7",
			surface: "#FFFFFF",
			elevated: "#F0FDF4",
			text: "#14532D",
			textMuted: "#166534",
			textFaint: "#5B9A73",
			accent: "#16A34A",
			accentSoft: "#DCFCE7",
			onAccent: "#FFFFFF",
			border: "#86EFAC",
			success: "#059669",
			warning: "#BA7F04", // desktop #CA8A04, for 3:1
			danger: "#DC2626",
			dangerSoft: "#FEE2E2",
		},
		dark: {
			dark: true,
			background: "#052E16",
			surface: "#166534",
			elevated: "#14532D",
			text: "#F0FDF4",
			textMuted: "#86EFAC",
			textFaint: "#59AB78",
			accent: "#4ADE80",
			accentSoft: "#14532D",
			onAccent: "#052E16",
			border: "#166534",
			success: "#34D399",
			warning: "#FBBF24",
			danger: "#F98888", // desktop #F87171, for 3:1
			dangerSoft: "#450A0A",
		},
	},
};
