/**
 * A card's whole build log, phase by phase, read again every 3 seconds while
 * a phase runs, following its end unless the person turns that off. The
 * person filters it to its errors, hides the tool calls, or finds a word.
 */

import { Stack, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FlatList, RefreshControl, StyleSheet, Switch, Text, View } from "react-native";
import type { LogPhase, TaskLogEntry } from "../../../../../../api/types";
import { useApi } from "../../../../../../auth/session";
import { defaultLogPhase, entryColor, LOG_PHASES } from "../../../../../../card/LogsSection";
import { mono } from "../../../../../../card/LongText";
import { useLoad } from "../../../../../../hooks/useLoad";
import { ChoiceChips } from "../../../../../../new-card/ChoiceChips";
import { ErrorBanner, Field, Loading } from "../../../../../../ui/components";
import { EmptyState } from "../../../../../../ui/kit";
import { SPACE, TYPE, useTheme } from "../../../../../../ui/theme";

export const LIVE_LOG_MS = 3_000;
/** The most lines drawn: the tail of a long run. */
export const MAX_FULL_LOG_LINES = 2_000;

type Show = "all" | "errors" | "noTools";

function shown(entry: TaskLogEntry, show: Show, words: string[]): boolean {
	if (show === "errors" && entry.type !== "error") return false;
	if (show === "noTools" && (entry.type.startsWith("tool") || !!entry.tool_name)) return false;
	const text = `${entry.tool_name ?? ""} ${entry.content}`.toLowerCase();
	return words.every((word) => text.includes(word));
}

export default function CardLog() {
	const { projectId, cardId } = useLocalSearchParams<{ projectId: string; cardId: string }>();
	const { t } = useTranslation();
	const theme = useTheme();
	const api = useApi();
	const load = useCallback(() => api.logs(projectId, cardId), [api, projectId, cardId]);
	const { data: logs, error, loading, refreshing, reload, refresh } = useLoad(load);
	const [chosen, setChosen] = useState<LogPhase | null>(null);
	const [show, setShow] = useState<Show>("all");
	const [find, setFind] = useState("");
	const [follow, setFollow] = useState(true);
	const list = useRef<FlatList<{ entry: TaskLogEntry; n: number }>>(null);
	const live = !!logs && LOG_PHASES.some((p) => logs.phases[p]?.status === "active");

	useEffect(() => {
		if (!live) return;
		const timer = setInterval(() => void refresh(), LIVE_LOG_MS);
		return () => clearInterval(timer);
	}, [live, refresh]);

	const phase = logs ? (chosen ?? defaultLogPhase(logs) ?? "planning") : "planning";
	const entries = logs?.phases[phase]?.entries;
	const lines = useMemo(() => {
		const words = find.toLowerCase().split(/\s+/).filter(Boolean);
		const all = (entries ?? []).map((entry, n) => ({ entry, n })).filter(({ entry }) => shown(entry, show, words));
		return { hidden: Math.max(0, all.length - MAX_FULL_LOG_LINES), lines: all.slice(-MAX_FULL_LOG_LINES) };
	}, [entries, show, find]);

	if (loading && !logs) return <Loading />;
	const phases = LOG_PHASES.filter((p) => logs?.phases[p]);
	return (
		<View style={{ flex: 1 }}>
			<Stack.Screen options={{ headerTitle: t("cardLog.title", { id: cardId.split("-")[0] }) }} />
			<View style={[styles.tools, { borderColor: theme.border, backgroundColor: theme.surface }]}>
				<ErrorBanner error={error} />
				{phases.length ? (
					<ChoiceChips<LogPhase>
						label={t("cardLog.phase")}
						choices={phases.map((p) => ({
							value: p,
							label: `${t(`card.logPhase_${p}`)} · ${t(`card.logStatus_${logs?.phases[p]?.status}`)}`,
						}))}
						selected={phase}
						onSelect={setChosen}
					/>
				) : null}
				<ChoiceChips<Show>
					label={t("cardLog.show")}
					choices={[
						{ value: "all", label: t("cardLog.all") },
						{ value: "errors", label: t("cardLog.errors") },
						{ value: "noTools", label: t("cardLog.noTools") },
					]}
					selected={show}
					onSelect={setShow}
				/>
				<Field label={t("cardLog.find")} value={find} onChangeText={setFind} autoCapitalize="none" maxLength={200} />
				<View style={styles.follow}>
					<Text style={[TYPE.small, { color: theme.textMuted, flex: 1 }]}>
						{live ? t("cardLog.live") : t("cardLog.still")}
					</Text>
					<Text style={[TYPE.small, { color: theme.text }]}>{t("cardLog.follow")}</Text>
					<Switch accessibilityLabel={t("cardLog.follow")} value={follow} onValueChange={setFollow} />
				</View>
			</View>
			<FlatList
				ref={list}
				data={lines.lines}
				keyExtractor={({ n }) => String(n)}
				contentContainerStyle={styles.lines}
				onContentSizeChange={() => {
					if (follow) list.current?.scrollToEnd({ animated: false });
				}}
				refreshControl={<RefreshControl refreshing={refreshing} onRefresh={reload} tintColor={theme.accent} />}
				ListHeaderComponent={
					lines.hidden > 0 ? (
						<Text style={{ color: theme.textFaint }}>{t("card.logsEarlier", { count: lines.hidden })}</Text>
					) : undefined
				}
				ListEmptyComponent={<EmptyState icon="file-text" title={t("cardLog.empty")} />}
				renderItem={({ item: { entry } }) => (
					<Text style={[mono.text, { color: entryColor(theme, entry.type) }]} selectable>
						{entry.tool_name ? `[${entry.tool_name}] ` : ""}
						{entry.content}
					</Text>
				)}
			/>
		</View>
	);
}

const styles = StyleSheet.create({
	tools: { padding: SPACE.md, gap: SPACE.sm, borderBottomWidth: StyleSheet.hairlineWidth },
	follow: { flexDirection: "row", alignItems: "center", gap: SPACE.sm },
	lines: { padding: SPACE.md, gap: 2, paddingBottom: SPACE.xl * 2 },
});
