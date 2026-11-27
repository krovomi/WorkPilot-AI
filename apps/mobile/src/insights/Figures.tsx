/** Rows of a label and its value: the phone's small table. */

import { StyleSheet, Text, View } from "react-native";
import { elevation, RADIUS, SPACE, TYPE, useTheme } from "../ui/theme";

export function Figures({ rows }: { rows: { label: string; value: string; color?: string }[] }) {
	const theme = useTheme();
	return (
		<View>
			{rows.map((row, index) => (
				<View
					key={row.label}
					style={[styles.row, index > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderColor: theme.border } : null]}
				>
					<Text style={{ color: theme.textMuted, flex: 1 }}>{row.label}</Text>
					<Text style={{ color: row.color ?? theme.text, fontWeight: "600" }} selectable>
						{row.value}
					</Text>
				</View>
			))}
		</View>
	);
}

/** A big figure with its label, three to a row at the top of a page. */
export function StatTile({ label, value, color }: { label: string; value: string; color?: string }) {
	const theme = useTheme();
	return (
		<View style={[styles.tile, { backgroundColor: theme.surface }, elevation(theme)]}>
			<Text style={[TYPE.title, { color: color ?? theme.text, fontSize: 22 }]} numberOfLines={1} adjustsFontSizeToFit selectable>
				{value}
			</Text>
			<Text style={[TYPE.caption, { color: theme.textMuted }]} numberOfLines={2}>
				{label}
			</Text>
		</View>
	);
}

const styles = StyleSheet.create({
	row: { flexDirection: "row", gap: SPACE.md, alignItems: "baseline", paddingVertical: SPACE.sm },
	tile: { flex: 1, borderRadius: RADIUS.lg, padding: SPACE.md, gap: 2 },
});

export function money(value: number | null | undefined): string {
	return typeof value === "number" && Number.isFinite(value) ? `$${value.toFixed(2)}` : "—";
}

export function count(value: number | null | undefined, locale: string): string {
	return typeof value === "number" && Number.isFinite(value) ? Math.round(value).toLocaleString(locale) : "—";
}

/** The largest entries of a map, for a top-N list. */
export function top(map: Record<string, number> | undefined, n = 5): [string, number][] {
	return Object.entries(map ?? {})
		.filter(([, v]) => typeof v === "number" && v > 0)
		.sort((a, b) => b[1] - a[1])
		.slice(0, n);
}

/** A run's length, short. */
export function duration(seconds: number | null): string | null {
	if (seconds === null || seconds < 0) return null;
	if (seconds < 60) return `${seconds} s`;
	const minutes = Math.round(seconds / 60);
	return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}
