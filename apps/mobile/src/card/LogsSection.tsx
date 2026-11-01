/**
 * The card's build log, phase by phase, as the server keeps it. The phase that
 * runs (or the last one that wrote) is open; its latest lines show, and the
 * screen reads them again while the agents work.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { LogPhase, TaskLogs, TaskPhaseLog } from "../api/types";
import { Section } from "../ui/components";
import { RADIUS, SPACE, type Theme, useTheme } from "../ui/theme";
import { mono } from "./LongText";

export const LOG_PHASES: LogPhase[] = ["planning", "coding", "validation"];
/** Lines shown for the open phase: a phone reads the tail, not the whole run. */
export const MAX_LOG_LINES = 30;

/** The phase to open first: the one running, else the last that wrote something. */
export function defaultLogPhase(logs: TaskLogs): LogPhase | null {
	const active = LOG_PHASES.find((p) => logs.phases[p]?.status === "active");
	if (active) return active;
	return [...LOG_PHASES].reverse().find((p) => (logs.phases[p]?.entries.length ?? 0) > 0) ?? null;
}

export function LogsSection({ logs }: { logs: TaskLogs | null }) {
	const { t } = useTranslation();
	const theme = useTheme();
	const [chosen, setChosen] = useState<LogPhase | null>(null);
	if (!logs) return null;
	const open = chosen ?? defaultLogPhase(logs);
	return (
		<Section title={t("card.logs")}>
			{open === null ? <Text style={{ color: theme.textMuted }}>{t("card.noLogs")}</Text> : null}
			{LOG_PHASES.map((name) => {
				const phase = logs.phases[name];
				if (!phase) return null;
				return (
					<View key={name}>
						<Pressable
							accessibilityRole="button"
							accessibilityState={{ expanded: open === name }}
							accessibilityLabel={t("card.logPhaseToggle", { phase: t(`card.logPhase_${name}`) })}
							onPress={() => setChosen(name)}
							style={styles.phase}
						>
							<Text style={{ color: theme.text, flex: 1 }}>{t(`card.logPhase_${name}`)}</Text>
							<Text style={{ color: statusColor(theme, phase.status) }}>{t(`card.logStatus_${phase.status}`)}</Text>
						</Pressable>
						{open === name ? <PhaseLines phase={phase} /> : null}
					</View>
				);
			})}
			{logs.truncated ? <Text style={{ color: theme.textFaint }}>{t("card.logsTruncated")}</Text> : null}
		</Section>
	);
}

function PhaseLines({ phase }: { phase: TaskPhaseLog }) {
	const { t } = useTranslation();
	const theme = useTheme();
	if (phase.entries.length === 0) {
		return <Text style={{ color: theme.textMuted }}>{t("card.logsEmptyPhase")}</Text>;
	}
	const hidden = Math.max(0, phase.entries.length - MAX_LOG_LINES);
	// A line's place in the whole log: entries are appended, never reordered.
	const lines = phase.entries.slice(hidden).map((entry, i) => ({ entry, n: hidden + i }));
	return (
		<View style={[styles.lines, { borderColor: theme.border, backgroundColor: theme.surface }]}>
			{hidden > 0 ? <Text style={{ color: theme.textFaint }}>{t("card.logsEarlier", { count: hidden })}</Text> : null}
			{lines.map(({ entry, n }) => (
				<Text key={n} style={[mono.text, { color: entryColor(theme, entry.type) }]} selectable>
					{entry.tool_name ? `[${entry.tool_name}] ` : ""}
					{entry.content}
				</Text>
			))}
		</View>
	);
}

function statusColor(theme: Theme, status: TaskPhaseLog["status"]) {
	switch (status) {
		case "active":
			return theme.accent;
		case "completed":
			return theme.success;
		case "failed":
			return theme.danger;
		default:
			return theme.textFaint;
	}
}

function entryColor(theme: Theme, type: string) {
	if (type === "error") return theme.danger;
	if (type === "success") return theme.success;
	if (type.startsWith("tool")) return theme.textMuted;
	return theme.text;
}

const styles = StyleSheet.create({
	phase: { flexDirection: "row", gap: SPACE.sm, alignItems: "center", paddingVertical: SPACE.xs, minHeight: 32 },
	lines: {
		borderWidth: StyleSheet.hairlineWidth,
		borderRadius: RADIUS.sm,
		padding: SPACE.sm,
		marginBottom: SPACE.sm,
		gap: 2,
	},
});
